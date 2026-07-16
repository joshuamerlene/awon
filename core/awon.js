/**
 * core/awon.js — Awon's main decision loop
 *
 * Every cycle:
 *   1. Load state (memory, ledger, blockers)
 *   2. Process any resolved blockers — pick those threads back up
 *   3. Pull live data (Shopify, TikTok)
 *   4. Strategic decision — what does Awon focus on this cycle?
 *   5. Delegate to sub-agents (product, content, analytics)
 *   6. Execute approved actions, gated by ledger
 *   7. Reconcile confirmed revenue
 *   8. Update sandbox/memory with learnings
 *   9. Log everything
 */

import { thinkJSON, think, PERSONAS } from "./claude.js";
import { Ledger } from "./ledger.js";
import { loadMemory, saveMemory, addLearning } from "./memory.js";
import { getPendingBlockers, getResolvedBlockers, markProcessed, addBlocker, addBlockerOnce } from "./queue.js";
import { getUnconsumedNotes, markConsumed as markNoteConsumed } from "./notes.js";
import { log } from "./logger.js";
import { runProductAgent } from "../agents/product.js";
import { runContentAgent } from "../agents/content.js";
import { runAnalyticsAgent } from "../agents/analytics.js";
import { runStoreAgent } from "../agents/store.js";
import { runInnerLoop } from "./innerLoop.js";
import { runFulfillmentAgent } from "../agents/fulfillment.js";
import * as shopify from "../integrations/shopify.js";
import * as tiktok from "../integrations/tiktok.js";
import * as printful from "../integrations/printful.js";
import * as cj from "../integrations/cj.js";
import * as video from "../integrations/video.js";

export async function runCycle() {
  log("system", "=== Awon cycle starting ===");

  const ledger = new Ledger();
  const memory = loadMemory();
  const pendingBlockers = getPendingBlockers();
  const resolvedBlockers = getResolvedBlockers();
  const notes = getUnconsumedNotes();

  log("system", `Budget: $${ledger.getAvailable().toFixed(2)} | Cycle #${(memory.cycleCount || 0) + 1} | Pending blockers: ${pendingBlockers.length} | New notes from Josh: ${notes.length}`);
  if (notes.length > 0) {
    log("decision", `Reading ${notes.length} note(s) Josh left: ${notes.map(n => `"${n.text}"`).join(" | ")}`);
  }

  // ── 1. Process resolved blockers ──────────────────────────────────────────
  for (const blocker of resolvedBlockers) {
    log("decision", `Processing resolved blocker: "${blocker.title}"`, { resolution: blocker.resolution });
    try {
      const action = await think({
        system: PERSONAS.awon,
        prompt: `You had a blocker that Josh just resolved. Here's the context and his response.

Blocker: ${blocker.title}
Your original context: ${blocker.context}
Thread you planned to resume: ${blocker.thread}
Josh's resolution: ${blocker.resolution}

Describe in plain text what you will do now to continue this thread, given his input.`,
      });
      log("action", `Resumed thread after blocker resolution: ${action}`);
      markProcessed(blocker.id);
    } catch (err) {
      log("error", `Failed to process blocker resolution: ${err.message}`);
    }
  }

  // ── 2. Pull live data ──────────────────────────────────────────────────────
  let products = [], orders = [], videos = [];

  try {
    products = await shopify.getProducts();
    orders = await shopify.getRecentOrders({ sinceISO: hoursAgo(24) });
    log("action", `Shopify: ${products.length} products, ${orders.length} recent orders`);
  } catch (err) {
    log("error", `Shopify pull failed: ${err.message}`);
  }

  try {
    videos = await tiktok.getAccountVideos();
    log("action", `TikTok: ${videos.length} videos fetched`);
  } catch (err) {
    log("system", `TikTok data skipped (not yet wired): ${err.message}`);
  }

  // Raw footage is the content pipeline's real input — surface it to the
  // strategy decision. Without this, Awon had no way to know clips existed
  // and kept ruling the content agent off cycle after cycle.
  let rawFootage = [];
  try {
    rawFootage = video.listRawFootage();
  } catch { /* non-fatal */ }
  const unusedFootageCount = rawFootage.filter(f => !(memory.usedFootage || []).includes(f.filename)).length;
  if (rawFootage.length > 0) {
    log("action", `Raw footage: ${rawFootage.length} clip(s) uploaded, ${unusedFootageCount} not yet used`);
  }

  // ── 3. Strategic decision — what does Awon focus on this cycle? ───────────
  // Store agent runs weekly (every 7th cycle) — visual changes shouldn't be constant
  const cycleCount = (memory.cycleCount || 0) + 1;
  const runStoreAgentThisCycle = cycleCount % 7 === 1; // cycle 1, 8, 15, 22...

  let strategy;
  try {
    strategy = await thinkJSON({
      system: PERSONAS.awon,
      prompt: `Here is your current state. Decide your strategic focus for this cycle.

Your sandbox/memory:
${JSON.stringify(memory, null, 2)}

Current data:
- Products in catalog: ${products.length} (if 0, catalog was intentionally cleared — your job is to rebuild it via Printful POD)
- Recent orders (24h): ${orders.length}
- TikTok videos available: ${videos.length}
- Raw footage clips Josh has uploaded for you to edit: ${rawFootage.length} total, ${unusedFootageCount} not yet used
- TikTok posting reality check: the Content Posting API WORKS. Because the app is Sandbox/unaudited, every post lands as PRIVATE (SELF_ONLY) and Josh manually flips it public in the TikTok app — that manual flip is the agreed, accepted workflow, NOT a blocker and NOT unverified access. A private post with a publish ID IS a delivered post and counts as your proof artifact. If unused raw footage exists, running the content agent produces and publishes a real post this cycle. Do not rule the content agent off because of "unverified account access" — that belief is outdated.
- Budget available: $${ledger.getAvailable().toFixed(2)}
- Ad cap: $${ledger.getAdCap().toFixed(2)}
- Pending blockers (don't act on these, just know they exist): ${pendingBlockers.map(b => b.title).join(", ") || "none"}
- Store design agent running this cycle: ${runStoreAgentThisCycle}

Notes Josh left for you since your last cycle (he can leave these anytime from the dashboard — they're proactive instructions or context, not something you asked for. Take them seriously and let them override your default focus if they're time-sensitive):
${notes.length > 0 ? notes.map(n => `- "${n.text}" (left ${n.createdAt})`).join("\n") : "None."}

Return JSON:
{
  "focus": "one sentence — what is the most important thing this cycle?",
  "runProductAgent": true/false,
  "runContentAgent": true/false,
  "runAnalyticsAgent": true/false,
  "reasoning": "why this focus?"
}`,
    });
    log("decision", `Strategic focus: ${strategy.focus}`, { reasoning: strategy.reasoning });
  } catch (err) {
    log("error", `Strategy decision failed: ${err.message}`);
    strategy = { focus: "Review available data", runProductAgent: true, runContentAgent: true, runAnalyticsAgent: false };
  }

  // Deterministic override: if unused footage exists, the content agent RUNS.
  // The strategy model repeatedly ruled content off based on stale memory
  // ("unverified access", "Josh is the blocker") cycle after cycle — so this
  // is no longer its call to make. Producing content is the job.
  if (unusedFootageCount > 0 && !strategy.runContentAgent) {
    log("decision", `Override: strategy skipped the content agent despite ${unusedFootageCount} unused clip(s) — running it anyway. Content production is not optional while footage exists.`);
    strategy.runContentAgent = true;
  }

  // Update strategy in memory
  memory.strategy = strategy.focus;
  memory.cycleCount = cycleCount;

  // Notes have now been folded into the strategic decision (and will reach the
  // product agent below too). Give Josh a short reply on each one so the
  // dashboard reads like an actual conversation, then mark them consumed.
  for (const note of notes) {
    try {
      const response = await think({
        system: PERSONAS.awon,
        prompt: `Josh (your owner) left you this note: "${note.text}"

Your strategic focus this cycle, decided with this note in mind: "${strategy.focus}"
Your reasoning: "${strategy.reasoning}"

Reply to Josh directly, in 1-3 sentences, plain text. Tell him what you're actually going to do about his note this cycle (or why it's not urgent yet). Sound like yourself — direct, no corporate filler.`,
        fast: true,
      });
      markNoteConsumed(note.id, response.trim());
      log("decision", `Replied to Josh's note "${note.text.slice(0, 60)}...": ${response.trim()}`);
    } catch (err) {
      log("error", `Failed to respond to note ${note.id}: ${err.message}`);
      markNoteConsumed(note.id);
    }
  }

  // ── 4. Run sub-agents ──────────────────────────────────────────────────────
  let productRecs = null, contentPlan = null, analyticsInsights = null;

  if (strategy.runProductAgent) {
    try {
      productRecs = await runProductAgent({ products, orders, memory, ledger, notes });
      log("sub-agent", "Product agent completed", { recommendations: productRecs?.summary });
    } catch (err) {
      log("error", `Product agent failed: ${err.message}`);
    }
  }

  if (strategy.runContentAgent) {
    try {
      contentPlan = await runContentAgent({ videos, products, memory });
      log("sub-agent", "Content agent completed", { plan: contentPlan?.summary });
    } catch (err) {
      log("error", `Content agent failed: ${err.message}`);
    }
  }

  if (strategy.runAnalyticsAgent) {
    try {
      analyticsInsights = await runAnalyticsAgent({ products, orders, videos, memory });
      log("sub-agent", "Analytics agent completed", { insights: analyticsInsights?.topInsight });
    } catch (err) {
      log("error", `Analytics agent failed: ${err.message}`);
    }
  }

  // Store agent — runs weekly, not every cycle
  if (runStoreAgentThisCycle) {
    try {
      const storeResult = await runStoreAgent({ memory });
      if (!storeResult.skipped) {
        log("sub-agent", `Store agent completed — ${storeResult.patchesApplied} setting(s) changed, ${storeResult.pagesUpdated} page(s) updated`);
        if (storeResult.heroTextSuggestion) {
          memory.contentNotes = memory.contentNotes || {};
          memory.contentNotes.heroText = storeResult.heroTextSuggestion;
        }
      }
    } catch (err) {
      log("error", `Store agent failed: ${err.message}`);
    }
  }

  // ── 5. Execute catalog actions ─────────────────────────────────────────────
  // NOTE: reprices and kills are executed by the product agent itself
  // (agents/product.js steps 4–5). They used to ALSO be re-executed here,
  // so every reprice and archive ran twice per cycle (visible as duplicate
  // "Repriced …" / "Archived …" pairs in the activity log). Removed.
  if (productRecs) {
    // Log POD products that were created this cycle
    if ((productRecs.createdPODProducts || []).length > 0) {
      log("action", `POD products created this cycle: ${productRecs.createdPODProducts.map(p => `"${p.title}"`).join(", ")}`);
      // Store content angles in memory for content agent to pick up
      memory.contentNotes = memory.contentNotes || {};
      memory.contentNotes.newPODProducts = [
        ...(memory.contentNotes.newPODProducts || []),
        ...productRecs.createdPODProducts,
      ].slice(-10); // keep last 10
    }

    // Non-POD dropship candidates — list via CJ if configured, otherwise park as blocker
    const dropshipCandidates = productRecs.newDropshipCandidates || [];
    const urgentDropship = dropshipCandidates.filter(p => p.urgency === "add now");
    if (urgentDropship.length > 0) {
      if (cj.isConfigured()) {
        // CJ is live — product agent handles listing (see agents/product.js CJ section)
        log("decision", `${urgentDropship.length} CJ dropship candidate(s) queued for listing this cycle.`);
      } else {
        addBlocker({
          title: "Dropship product candidates ready — need CJ API key",
          context: `Product agent identified ${urgentDropship.length} strong non-POD candidates: ${urgentDropship.map(p => p.description).join("; ")}. CJ Dropshipping is the connected supplier — just need CJ_API_KEY set in Railway.`,
          options: ["Add CJ_API_KEY to Railway env vars", "Skip — focus on Printful POD only"],
          thread: "Once CJ_API_KEY is set, I'll list these products immediately.",
        });
      }
    }
  }

  // ── 6. Execute content actions ─────────────────────────────────────────────
  if (contentPlan) {
    for (const post of contentPlan.postsToPublish || []) {
      try {
        const { publishId, privacyLevel } = await tiktok.publishVideo(post);
        if (privacyLevel === "SELF_ONLY") {
          log("action", `Posted to TikTok privately (unaudited app — awaiting manual publish): "${post.caption?.slice(0, 60)}..." (${publishId})`);
          addBlocker({
            title: "TikTok video posted privately — needs manual publish",
            context: `Posted "${post.caption?.slice(0, 80)}..." to @the.rival.is.me (from footage "${post.sourceFootageFilename || "unknown"}"), but the app is unaudited so TikTok forces it private (SELF_ONLY). Open the TikTok app, find this draft, and change its privacy to "Everyone" to make it public. Publish ID: ${publishId}`,
            options: ["I've made it public", "Skip this one"],
            thread: "Once you confirm, I'll move on — I can't flip the privacy setting myself, TikTok only allows that from within the app.",
          });
        } else {
          log("action", `Published TikTok: "${post.caption?.slice(0, 60)}..." (${publishId})`);
        }
      } catch (err) {
        log("error", `TikTok publish failed: ${err.message}`);
        addBlockerOnce({
          title: "TikTok publishing is failing",
          context: `Publishing to TikTok keeps failing: "${err.message}". This means edited clips are being produced but never actually reaching TikTok — check the TikTok connection (may need to reconnect via /auth/tiktok) and TIKTOK_APP_KEY/TIKTOK_APP_SECRET.`,
          options: ["I'll check the TikTok connection", "Skip TikTok publishing for now"],
          thread: "Once publishing succeeds again, I'll resume posting from uploaded footage.",
        });
      } finally {
        // Clean up the edited clip regardless of outcome — it's a derived
        // file (original raw footage is untouched), no reason to let it
        // pile up on the Volume.
        if (post.videoPath) video.cleanupEditedClip(post.videoPath);
      }
    }

    for (const tag of contentPlan.productTags || []) {
      try {
        await tiktok.tagProductOnVideo(tag.videoId, tag.productId);
        log("action", `Tagged product ${tag.productId} on video ${tag.videoId}`);
      } catch (err) {
        log("error", `Product tag failed: ${err.message}`);
      }
    }

    // Boost decision — always gated through ledger
    if (contentPlan.boostCandidate) {
      const { videoId, amountUsd, reasoning } = contentPlan.boostCandidate;
      const check = ledger.canSpend(amountUsd, "ad_promotion");
      if (check.allowed) {
        try {
          await tiktok.boostVideo(videoId, amountUsd);
          ledger.recordSpend(amountUsd, "ad_promotion", reasoning);
          log("action", `Boosted video ${videoId} with $${amountUsd}: ${reasoning}`);
        } catch (err) {
          log("error", `Boost failed: ${err.message}`);
        }
      } else {
        log("decision", `Boost skipped — ${check.reason}`);
      }
    }
  }

  // ── 7. Auto-fulfill CJ orders ─────────────────────────────────────────────
  try {
    const fulfillResult = await runFulfillmentAgent({ orders, memory });
    if (fulfillResult.fulfilled > 0) {
      log("sub-agent", `Fulfillment agent: sent ${fulfillResult.fulfilled} order(s) to CJ Dropshipping.`);
    }
    if (fulfillResult.errors.length > 0) {
      for (const err of fulfillResult.errors) log("error", err);
    }
  } catch (err) {
    log("error", `Fulfillment agent crashed: ${err.message}`);
  }

  // ── 8. Reconcile confirmed revenue (Printful POD) ─────────────────────────
  for (const order of orders.filter(o => o.fulfillment_status === "fulfilled" && o.financial_status === "paid")) {
    const revenue = Number(order.total_price || 0);
    const cogs = Number(order.estimated_cost_of_goods || revenue * 0.4);
    ledger.recordRevenue(revenue, cogs, `Order ${order.id}`);
    log("action", `Revenue reconciled: Order ${order.id} — $${revenue} revenue, $${cogs.toFixed(2)} COGS`);
  }

  // ── 8. Update memory / sandbox ─────────────────────────────────────────────
  try {
    const memoryUpdate = await thinkJSON({
      system: PERSONAS.awon,
      prompt: `Update your sandbox/memory based on this cycle.

What happened this cycle:
- Strategic focus: ${strategy.focus}
- Products pulled: ${products.length}
- Orders: ${orders.length}
- Content agent ran: ${!!contentPlan}
- Product agent ran: ${!!productRecs}
${analyticsInsights ? `- Analytics insights: ${JSON.stringify(analyticsInsights)}` : ""}

Current memory:
${JSON.stringify(memory, null, 2)}

Return JSON with ONLY the fields that should change:
{
  "strategy": "updated one-line strategic focus",
  "newLearning": "one specific thing you learned or confirmed this cycle (or null)",
  "nextActions": ["action 1", "action 2", "action 3"],
  "contentNotes": { ... only if something changed ... }
}`,
      fast: true,
    });

    if (memoryUpdate.strategy) memory.strategy = memoryUpdate.strategy;
    if (memoryUpdate.newLearning) addLearning(memory, memoryUpdate.newLearning);
    if (memoryUpdate.nextActions) memory.nextActions = memoryUpdate.nextActions;
    if (memoryUpdate.contentNotes) memory.contentNotes = { ...memory.contentNotes, ...memoryUpdate.contentNotes };

  } catch (err) {
    log("error", `Memory update failed: ${err.message}`);
  }

  // Save memory snapshot before inner loop so sub-agents have current state
  saveMemory(memory);

  // ── 9. Inner work loop — Awon keeps working until time runs out ────────────
  try {
    // Refresh products list so inner loop sees any products created this cycle
    const freshProducts = await shopify.getProducts().catch(() => products);
    const loopResult = await runInnerLoop({
      memory,
      products: freshProducts,
      orders,
      ledger,
    });
    log("system", `Inner loop: ${loopResult.tasksCompleted} task(s) completed in ${loopResult.durationMinutes}min`);
  } catch (err) {
    log("error", `Inner loop crashed: ${err.message}`);
  }

  saveMemory(memory);
  log("system", `=== Full cycle complete. Budget: $${ledger.getAvailable().toFixed(2)} ===`);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}
