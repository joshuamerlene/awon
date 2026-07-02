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
import { getPendingBlockers, getResolvedBlockers, markProcessed, addBlocker } from "./queue.js";
import { log } from "./logger.js";
import { runProductAgent } from "../agents/product.js";
import { runContentAgent } from "../agents/content.js";
import { runAnalyticsAgent } from "../agents/analytics.js";
import { runStoreAgent } from "../agents/store.js";
import { runInnerLoop } from "./innerLoop.js";
import * as shopify from "../integrations/shopify.js";
import * as tiktok from "../integrations/tiktok.js";
import * as printful from "../integrations/printful.js";

export async function runCycle() {
  log("system", "=== Awon cycle starting ===");

  const ledger = new Ledger();
  const memory = loadMemory();
  const pendingBlockers = getPendingBlockers();
  const resolvedBlockers = getResolvedBlockers();

  log("system", `Budget: $${ledger.getAvailable().toFixed(2)} | Cycle #${(memory.cycleCount || 0) + 1} | Pending blockers: ${pendingBlockers.length}`);

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
- Budget available: $${ledger.getAvailable().toFixed(2)}
- Ad cap: $${ledger.getAdCap().toFixed(2)}
- Pending blockers (don't act on these, just know they exist): ${pendingBlockers.map(b => b.title).join(", ") || "none"}
- Store design agent running this cycle: ${runStoreAgentThisCycle}

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

  // Update strategy in memory
  memory.strategy = strategy.focus;
  memory.cycleCount = cycleCount;

  // ── 4. Run sub-agents ──────────────────────────────────────────────────────
  let productRecs = null, contentPlan = null, analyticsInsights = null;

  if (strategy.runProductAgent) {
    try {
      productRecs = await runProductAgent({ products, orders, memory, ledger });
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
  if (productRecs) {
    for (const reprice of productRecs.repriceSuggestions || []) {
      try {
        await shopify.updateProduct(reprice.productId, { variants: [{ price: String(reprice.newPrice) }] });
        log("action", `Repriced product ${reprice.productId} → $${reprice.newPrice}: ${reprice.reasoning}`);
      } catch (err) {
        log("error", `Reprice failed (${reprice.productId}): ${err.message}`);
      }
    }

    for (const id of productRecs.kill || []) {
      try {
        await shopify.archiveProduct(id);
        log("action", `Archived underperforming product ${id}`);
      } catch (err) {
        log("error", `Archive failed (${id}): ${err.message}`);
      }
    }

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

    // Non-POD dropship candidates — park as blocker if significant and no supplier wired
    const dropshipCandidates = productRecs.newDropshipCandidates || [];
    const urgentDropship = dropshipCandidates.filter(p => p.urgency === "add now");
    if (urgentDropship.length > 0 && !process.env.ZENDROP_API_KEY) {
      addBlocker({
        title: "Dropship product candidates ready — need supplier decision",
        context: `Product agent identified ${urgentDropship.length} strong non-POD candidates: ${urgentDropship.map(p => p.description).join("; ")}. Need a dropship supplier to list.`,
        options: ["Connect Zendrop", "Connect DSers (AliExpress)", "Connect AutoDS", "Skip — focus on Printful POD only"],
        thread: "Once supplier is chosen, I'll list these products immediately.",
      });
    }
  }

  // ── 6. Execute content actions ─────────────────────────────────────────────
  if (contentPlan) {
    for (const post of contentPlan.postsToPublish || []) {
      try {
        const videoId = await tiktok.publishVideo(post);
        log("action", `Published TikTok: "${post.caption?.slice(0, 60)}..." (${videoId})`);
      } catch (err) {
        log("error", `TikTok publish failed: ${err.message}`);
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

  // ── 7. Reconcile confirmed revenue ─────────────────────────────────────────
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
