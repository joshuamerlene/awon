/**
 * core/innerLoop.js — Awon's autonomous inner work loop
 *
 * After the main cycle completes, Awon doesn't stop. He asks himself
 * "what's the most valuable thing I can do right now?" and keeps working
 * until he genuinely runs out of useful things to do or hits the time limit.
 *
 * This is what separates a scheduled script from a real operator.
 *
 * Design:
 * - Max 40 minutes per cycle (configurable via INNER_LOOP_MINUTES env var)
 * - Max 10 tasks per session (guards against runaway)
 * - Awon picks from a concrete action menu — no hallucinated capabilities
 * - Every task actually executes: writes to Shopify, Printify, content queue, etc.
 * - Session log prevents repeating the same task twice
 * - Awon can declare "done" early if there's nothing valuable left
 */

import { thinkJSON, think, PERSONAS } from "./claude.js";
import { log } from "./logger.js";
import { addLearning } from "./memory.js";
import * as shopify from "../integrations/shopify.js";
import * as printify from "../integrations/printify.js";

const MAX_MINUTES = Number(process.env.INNER_LOOP_MINUTES || 40);
const MAX_TASKS   = Number(process.env.INNER_LOOP_MAX_TASKS || 10);

// ── Available actions Awon can self-assign ────────────────────────────────────
// Each has a name, description (shown to Awon when choosing), and handler.
// Awon picks based on what will move the needle most given current state.

const ACTIONS = {

  research_printify: {
    description: "Search Printify catalog for new fitness POD product opportunities. Research blueprints, providers, price points. Add strong candidates to memory for next product creation.",
    async execute({ memory }) {
      const keywords = ["gym shirt", "tank top", "hoodie fitness", "joggers", "gym bag", "water bottle", "gym shorts", "compression shirt"];
      const kw = keywords[Math.floor(Math.random() * keywords.length)];

      const results = await thinkJSON({
        system: PERSONAS.productAgent,
        prompt: `Research Printify POD opportunities for The Rival Is Me fitness brand.

Search keyword to explore: "${kw}"

Based on your knowledge of fitness apparel and POD products, evaluate this category:
- What specific products in this category fit The Rival Is Me brand?
- What retail price would be premium but fair?
- What messaging angle would make it fly on TikTok?
- What's the estimated margin at that price?

Return JSON:
{
  "keyword": "${kw}",
  "topCandidates": [
    {
      "printifySearchKeyword": "exact search term for Printify",
      "suggestedTitle": "DISCIPLINE OVER COMFORT — Training Tee",
      "retailPrice": 34.99,
      "estimatedCOGS": 14.00,
      "marginPercent": 60,
      "tiktokAngle": "how to feature this on TikTok",
      "urgency": "add now|add soon|test first"
    }
  ],
  "categoryVerdict": "is this category worth pursuing for The Rival Is Me?"
}`,
        fast: true,
      });

      // Store candidates in memory for product agent to act on
      memory.printifyCandidates = [
        ...(memory.printifyCandidates || []),
        ...results.topCandidates,
      ].slice(-20); // keep last 20 candidates

      return `Researched "${kw}" — ${results.topCandidates.length} candidates found. Verdict: ${results.categoryVerdict}`;
    },
  },

  create_pod_product: {
    description: "Take a queued Printify candidate from memory and actually create + publish it to Shopify. Only run if PRINTIFY_API_KEY is set and there are candidates waiting.",
    async execute({ memory }) {
      if (!printify.isConfigured()) return "Skipped — PRINTIFY_API_KEY not set.";

      const candidates = (memory.printifyCandidates || []).filter(c => c.urgency === "add now" && !c.created);
      if (candidates.length === 0) return "No urgent Printify candidates in queue. Run research_printify first.";

      const candidate = candidates[0];

      try {
        const blueprint = await printify.resolveBlueprintForKeyword(candidate.printifySearchKeyword);
        const retailPriceCents = Math.round((candidate.retailPrice || 34.99) * 100);
        const enabledVariants = blueprint.variants.slice(0, 50).map(v => ({
          id: v.id,
          price: retailPriceCents,
          is_enabled: true,
        }));

        const product = await printify.createProduct({
          title: candidate.suggestedTitle,
          description: `<p>${candidate.suggestedTitle}</p><p>Built for the ones who chose discipline. The Rival Is Me.</p>`,
          blueprintId: blueprint.blueprintId,
          printProviderId: blueprint.printProviderId,
          variants: enabledVariants,
          printAreas: [{
            variant_ids: enabledVariants.map(v => v.id),
            placeholders: [{ position: "front", images: [] }],
          }],
        });

        await printify.publishProduct(product.id);

        // Mark as created in memory
        candidate.created = true;
        candidate.printifyId = product.id;

        return `Created and published "${candidate.suggestedTitle}" to Shopify (Printify ID: ${product.id})`;
      } catch (err) {
        return `Failed to create "${candidate.suggestedTitle}": ${err.message}`;
      }
    },
  },

  improve_product_descriptions: {
    description: "Rewrite all active Shopify product descriptions in The Rival Is Me voice — direct, disciplined, no corporate speak. Update them on Shopify.",
    async execute({ products }) {
      if (products.length === 0) return "No active products to improve.";

      let improved = 0;
      for (const product of products.slice(0, 5)) { // max 5 per session
        try {
          const newDescription = await think({
            system: PERSONAS.awon,
            prompt: `Rewrite this product description in The Rival Is Me voice.

Product: ${product.title}
Current description: ${product.body_html || "(none)"}
Price: $${product.variants?.[0]?.price}

Voice rules:
- Raw and direct. Sounds like a real person who trains.
- No buzzwords, no corporate speak, no "premium quality"
- Short punchy sentences. Max 3 paragraphs.
- End with something that feels like a challenge or statement of intent
- HTML format (<p> tags)

Write the new description only. Nothing else.`,
            fast: true,
          });

          await shopify.updateProduct(product.id, { body_html: newDescription });
          improved++;
          log("action", `Improved description for "${product.title}"`);
        } catch (err) {
          log("error", `Description update failed for ${product.id}: ${err.message}`);
        }
      }

      return `Rewrote descriptions for ${improved} product(s) in The Rival Is Me voice`;
    },
  },

  plan_content_series: {
    description: "Develop a detailed 3-5 video TikTok content arc and write it fully to the content queue. Hooks, captions, editing notes, posting schedule — the whole thing.",
    async execute({ memory, products }) {
      const { getContentQueue } = await import("../agents/content.js");
      const fs = await import("fs");
      const path = await import("path");
      const { fileURLToPath } = await import("url");
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const QUEUE_PATH = path.join(__dirname, "../data/content_queue.json");

      const series = await thinkJSON({
        system: PERSONAS.contentAgent,
        prompt: `Develop a complete 5-video TikTok content series for @the.rival.is.me.

Available products: ${JSON.stringify(products.map(p => ({ title: p.title, price: p.variants?.[0]?.price })))}
What's worked before: ${memory.contentNotes?.workingFormats?.join(", ") || "no data yet"}
Current strategy: ${memory.strategy || "building from scratch"}

Design a series arc where each video builds on the last. Think narrative momentum — someone should be able to watch all 5 and feel like they're following a story.

Return JSON:
{
  "seriesName": "name for this arc",
  "seriesHook": "the overarching theme that ties all 5 together",
  "videos": [
    {
      "position": 1,
      "hook": "first 2 seconds — make them stop",
      "caption": "full caption, max 150 chars, sounds like a real person",
      "hashtags": ["discipline", "therivalisme"],
      "editingNotes": "specific: trim 0:00-0:12, text overlay at 0:03, use trending sound X",
      "contentAngle": "discipline|transformation|product|challenge|motivation",
      "suggestedPostTime": "ISO timestamp — optimal time",
      "productId": null,
      "seriesTag": "series name"
    }
  ]
}

Write real captions and hooks — not templates. Make it feel like someone who actually lives this wrote it.`,
        fast: false,
      });

      // Write all videos to content queue
      const queue = JSON.parse(fs.existsSync(QUEUE_PATH) ? fs.readFileSync(QUEUE_PATH, "utf8") : "[]");
      const newItems = (series.videos || []).map((v, i) => ({
        id: `series_${Date.now()}_${i}`,
        status: "pending",
        queuedAt: new Date().toISOString(),
        seriesName: series.seriesName,
        ...v,
      }));
      queue.push(...newItems);
      const dir = path.dirname(QUEUE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));

      return `Planned "${series.seriesName}" series — ${newItems.length} videos queued. Theme: ${series.seriesHook}`;
    },
  },

  write_blog_post: {
    description: "Write a full brand-aligned blog post for the Shopify store. Real, personal, discipline-focused. Publish it directly to the store.",
    async execute({ memory }) {
      const topic = await think({
        system: PERSONAS.awon,
        prompt: `Pick ONE blog post topic for The Rival Is Me that:
- Feels personal and real, not like SEO content
- Ties into discipline, the rival within, or the Sanctuary mission
- Could attract someone who googles "how to stay disciplined" or "fitness mindset"
- Is something Josh (the founder) would actually have thought about

Return only the topic title. Nothing else.`,
        fast: true,
      });

      const postHTML = await think({
        system: PERSONAS.awon,
        prompt: `Write a full blog post for The Rival Is Me on this topic: "${topic.trim()}"

Rules:
- 400-600 words
- Written like the founder — personal, direct, no fluff
- HTML format using <h2>, <p>, <strong> tags
- Ends with a call to action that feels like a challenge, not a sales pitch
- DO NOT mention specific product names or prices
- Reference "The Rival" (the lazy version of yourself) naturally
- The tone: like a journal entry crossed with a manifesto

Write the full post HTML only.`,
        fast: false,
      });

      try {
        await shopify.createPage({
          title: topic.trim(),
          body_html: postHTML,
          handle: topic.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        });
        return `Published blog post: "${topic.trim()}"`;
      } catch (err) {
        // Blog posts go to pages — try that
        return `Wrote blog post "${topic.trim()}" but couldn't publish: ${err.message}`;
      }
    },
  },

  audit_product_titles: {
    description: "Review all product titles for brand fit, SEO, and The Rival Is Me voice. Rename anything that sounds generic or off-brand.",
    async execute({ products }) {
      if (products.length === 0) return "No active products to audit.";

      const audit = await thinkJSON({
        system: PERSONAS.productAgent,
        prompt: `Audit these product titles for The Rival Is Me brand fit.

Products:
${JSON.stringify(products.map(p => ({ id: p.id, title: p.title, price: p.variants?.[0]?.price })))}

For each product, decide:
- Does the title sound like The Rival Is Me? (disciplined, direct, premium)
- Is it searchable? (someone searching "gym shirt" should find it)
- Is it worth renaming?

Title formula that works: [DISCIPLINE PHRASE] — [Product Type]
Examples: "BUILT NOT BORN — Training Tee", "6AM CLUB — Performance Hoodie"

Return JSON:
{
  "renames": [
    { "productId": "...", "oldTitle": "...", "newTitle": "...", "reasoning": "..." }
  ],
  "noChangeNeeded": ["productId", ...]
}`,
        fast: true,
      });

      let renamed = 0;
      for (const rename of audit.renames || []) {
        try {
          await shopify.updateProduct(rename.productId, { title: rename.newTitle });
          log("action", `Renamed "${rename.oldTitle}" → "${rename.newTitle}": ${rename.reasoning}`);
          renamed++;
        } catch (err) {
          log("error", `Rename failed (${rename.productId}): ${err.message}`);
        }
      }

      return `Audited ${products.length} product titles — ${renamed} renamed, ${(audit.noChangeNeeded || []).length} kept`;
    },
  },

  self_critique: {
    description: "Review recent decisions and actions. Grade them honestly. Extract learnings. Update memory with what to do differently.",
    async execute({ memory }) {
      const critique = await thinkJSON({
        system: PERSONAS.awon,
        prompt: `Review your recent work and grade yourself honestly.

Recent strategy: ${memory.strategy}
Last actions taken: ${(memory.nextActions || []).join(", ") || "none recorded"}
Recent learnings: ${(memory.learnings || []).slice(-5).map(l => l.insight).join("; ") || "none yet"}
Pending blockers: ${memory.blockers || "none"}

Be honest. What did you do well? What was a bad call? What would you do differently?

Return JSON:
{
  "wins": ["specific thing that worked or was the right call"],
  "misses": ["specific thing that was wrong or could have been better"],
  "newRule": "one specific operating principle you're adding to how you work",
  "priorityShift": "is there something you should be doing more or less of?"
}`,
        fast: true,
      });

      // Store the new rule as a learning
      if (critique.newRule) {
        addLearning(memory, critique.newRule);
      }

      return `Self-critique complete. Wins: ${critique.wins?.length || 0}. Misses: ${critique.misses?.length || 0}. New rule: "${critique.newRule}"`;
    },
  },

  build_weekly_plan: {
    description: "Build a structured plan for the next 7 days — what products to add, what content to post, what store changes to make. Store it in memory.",
    async execute({ memory, products }) {
      const plan = await thinkJSON({
        system: PERSONAS.awon,
        prompt: `Build a 7-day operating plan for The Rival Is Me.

Current state:
- Active products: ${products.length}
- Current strategy: ${memory.strategy}
- Pending Printify candidates: ${(memory.printifyCandidates || []).length}
- Content queue size: ${memory.contentNotes?.queueSize || "unknown"}

Build a realistic, specific plan. Not aspirational — executable.

Return JSON:
{
  "weekTheme": "one overarching focus for this week",
  "days": [
    {
      "day": "Monday",
      "productGoal": "what product work to do",
      "contentGoal": "what content to plan or post",
      "storeGoal": "any store changes",
      "priority": "the single most important thing this day"
    }
  ],
  "weeklySuccessMetric": "how will you know this week was a win?"
}`,
        fast: true,
      });

      memory.weeklyPlan = plan;
      memory.weeklyPlanDate = new Date().toISOString();

      return `Built 7-day plan — theme: "${plan.weekTheme}". Success metric: "${plan.weeklySuccessMetric}"`;
    },
  },

};

// ── Inner loop orchestrator ───────────────────────────────────────────────────

export async function runInnerLoop({ memory, products, orders, ledger }) {
  const startTime = Date.now();
  const maxMs = MAX_MINUTES * 60 * 1000;
  const sessionLog = []; // what we've done this session — prevents repeats
  let taskCount = 0;

  log("system", `Inner loop starting — max ${MAX_MINUTES} min, max ${MAX_TASKS} tasks`);

  while (taskCount < MAX_TASKS) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxMs) {
      log("system", `Inner loop: time limit reached (${Math.round(elapsed / 60000)}min)`);
      break;
    }

    const timeRemaining = Math.round((maxMs - elapsed) / 60000);
    const availableActions = Object.entries(ACTIONS)
      .filter(([name]) => !sessionLog.includes(name)) // don't repeat
      .map(([name, action]) => `- ${name}: ${action.description}`);

    if (availableActions.length === 0) {
      log("system", "Inner loop: all available actions completed");
      break;
    }

    // Ask Awon what to do next
    let decision;
    try {
      decision = await thinkJSON({
        system: PERSONAS.awon,
        prompt: `You've finished your main cycle work. You have ${timeRemaining} minutes left to work. What's the most valuable thing you can do right now?

Current state:
- Active products in store: ${products.length}
- Printify configured: ${printify.isConfigured()}
- Orders today: ${orders.length}
- Printify candidates queued: ${(memory.printifyCandidates || []).filter(c => !c.created).length}
- Weekly plan exists: ${!!memory.weeklyPlan}
- Current strategy: ${memory.strategy}

Already done this session: ${sessionLog.join(", ") || "nothing yet"}

Available actions:
${availableActions.join("\n")}

Or return "done" if there's genuinely nothing valuable left to do.

Return JSON: { "action": "action_name_or_done", "reasoning": "why this is the best use of time right now" }`,
        fast: true,
      });
    } catch (err) {
      log("error", `Inner loop: failed to pick next task — ${err.message}`);
      break;
    }

    if (!decision.action || decision.action === "done") {
      log("system", `Inner loop: Awon decided he's done. Reasoning: ${decision.reasoning}`);
      break;
    }

    const action = ACTIONS[decision.action];
    if (!action) {
      log("error", `Inner loop: unknown action "${decision.action}" — skipping`);
      sessionLog.push(decision.action); // mark as attempted to avoid looping
      continue;
    }

    log("action", `Inner loop task ${taskCount + 1}: ${decision.action} — ${decision.reasoning}`);

    try {
      const result = await action.execute({ memory, products, orders, ledger });
      log("action", `Inner loop task done: ${result}`);
      sessionLog.push(decision.action);
      taskCount++;
    } catch (err) {
      log("error", `Inner loop task failed (${decision.action}): ${err.message}`);
      sessionLog.push(decision.action); // don't retry failed tasks
      taskCount++;
    }
  }

  const totalMin = Math.round((Date.now() - startTime) / 60000);
  log("system", `Inner loop complete — ${taskCount} task(s) in ${totalMin} min: [${sessionLog.join(" → ")}]`);

  return { tasksCompleted: taskCount, sessionLog, durationMinutes: totalMin };
}
