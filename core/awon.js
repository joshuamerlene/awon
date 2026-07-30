/**
 * core/awon.js — Awon's main decision loop
 *
 * Every cycle:
 *   1. Load state (memory, ledger, blockers)
 *   2. Process any resolved blockers — pick those threads back up
 *   3. Pull live data (client pipeline, footage, invoices)
 *   4. Strategic decision — what does Awon focus on this cycle?
 *   5. Delegate to sub-agents (outreach, clip production, analytics)
 *   6. Reconcile confirmed revenue (Stripe)
 *   7. Update sandbox/memory with learnings
 *   8. Log everything
 */

import { thinkJSON, think, PERSONAS } from "./claude.js";
import { Ledger } from "./ledger.js";
import { loadMemory, saveMemory, addLearning } from "./memory.js";
import { getPendingBlockers, getResolvedBlockers, markProcessed, addBlockerOnce } from "./queue.js";
import { getUnconsumedNotes, markConsumed as markNoteConsumed } from "./notes.js";
import { pruneExpired } from "./chatMemory.js";
import { log } from "./logger.js";
import * as clients from "./clients.js";
import { runOutreachAgent } from "../agents/outreach.js";
import { runClipAgent } from "../agents/clipAgent.js";
import { runAnalyticsAgent } from "../agents/analytics.js";
import { runInnerLoop } from "./innerLoop.js";
import * as stripe from "../integrations/stripe.js";
import * as vizard from "../integrations/vizard.js";
import * as email from "../integrations/email.js";

export async function runCycle() {
  log("system", "=== Awon cycle starting ===");

  // Timed directives from Josh's chat expire on their own schedule — campaigns
  // stop themselves. (Living memory itself is injected via core/claude.js.)
  try { pruneExpired(); } catch { /* non-fatal */ }

  const ledger = new Ledger();
  const memory = loadMemory();
  const pendingBlockers = getPendingBlockers();
  const resolvedBlockers = getResolvedBlockers();
  const notes = getUnconsumedNotes();

  log("system", `Budget: $${ledger.getAvailable().toFixed(2)} | Cycle #${(memory.cycleCount || 0) + 1} | Pending blockers: ${pendingBlockers.length} | New notes from Josh: ${notes.length}`);
  if (notes.length > 0) {
    log("decision", `Reading ${notes.length} note(s) Josh left: ${notes.map(n => `"${n.text}"`).join(" | ")}`);
  }

  // ── Budget circuit breaker — a real hard stop, checked BEFORE anything in
  // this cycle spends a cent. Every think() call costs money and is never
  // individually blocked (core/claude.js recordSpendUnconditional — blocking
  // an individual call could brick Awon mid-thought), so the actual stop has
  // to happen here instead: if the budget cap is already used up, skip the
  // entire cycle — no thinking, no outreach, no clip work, nothing spends.
  // Uses a plain deterministic message, not an LLM call, on purpose: this has
  // to work even when the budget is the exact reason nothing else can run.
  if (ledger.getAvailable() <= 0) {
    addBlockerOnce({
      title: "Budget exhausted — Awon is paused",
      context: `Available budget is $${ledger.getAvailable().toFixed(2)}. Every cycle costs real money to run (thinking, outreach, clip production), so cycles are skipped entirely — not throttled, fully paused — until funded again.`,
      options: ["Add funds via the dashboard Budget panel"],
      thread: "Once funded, the next scheduled cycle picks up normally — nothing queued is lost while paused.",
    });
    log("system", `=== Cycle skipped — budget exhausted ($${ledger.getAvailable().toFixed(2)} available). Add funds to resume. ===`);
    return;
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

  // ── 2. Pull live state ─────────────────────────────────────────────────────
  const allClients = clients.getAllClients();
  const prospects = clients.getProspects();
  const activeClients = clients.getActiveClients();
  const queuedFootage = clients.getFootageByStatus("queued");
  const processingFootage = clients.getFootageByStatus("processing");

  log("action", `Pipeline: ${allClients.length} client(s) total — ${prospects.length} prospect(s), ${activeClients.length} active. Footage: ${queuedFootage.length} queued, ${processingFootage.length} processing.`);

  // ── 2b. Time-box checkpoint ─────────────────────────────────────────────
  // This is the direct lesson from this business's predecessor (The Rival Is
  // Me apparel store): it ran 4 months to $0 revenue before the pattern got
  // acted on. Don't let that repeat quietly — surface it as a real blocker,
  // not a vault note nobody reads mid-cycle.
  if (!memory.businessLaunchedAt) memory.businessLaunchedAt = new Date().toISOString();
  const CHECKPOINT_WEEKS = Number(process.env.CHECKPOINT_WEEKS || 6);
  const weeksSinceLaunch = (Date.now() - new Date(memory.businessLaunchedAt).getTime()) / (7 * 24 * 3600 * 1000);
  const daysSinceLastCheckpointFlag = memory.lastCheckpointFlagAt
    ? (Date.now() - new Date(memory.lastCheckpointFlagAt).getTime()) / (24 * 3600 * 1000)
    : Infinity;
  if (weeksSinceLaunch >= CHECKPOINT_WEEKS && activeClients.length === 0 && daysSinceLastCheckpointFlag >= 7) {
    addBlockerOnce({
      title: `Time-box checkpoint: ${CHECKPOINT_WEEKS}+ weeks in, zero active clients`,
      context: `Launched ${memory.businessLaunchedAt}. Same checkpoint logic the vault note for this business named up front, now enforced in code instead of hoping someone remembers to check: this business's predecessor ran 4 months to $0 revenue before anyone acted on the pattern. Prospects contacted so far: ${prospects.filter(p => (p.outreach || []).length > 0).length}. Worth a real look at whether the approach needs to change (different prospecting channel, pricing, positioning) rather than continuing to wait.`,
      options: ["Keep going as-is — give it more time", "Something needs to change — let's revisit the approach", "Pause this and reassess"],
      thread: "Whatever Josh decides here becomes the new strategy going forward.",
    });
    memory.lastCheckpointFlagAt = new Date().toISOString();
    log("decision", `Time-box checkpoint flagged — ${weeksSinceLaunch.toFixed(1)} weeks in, still zero active clients.`);
  }

  // ── 3. Strategic decision — what does Awon focus on this cycle? ───────────
  const cycleCount = (memory.cycleCount || 0) + 1;

  let strategy;
  try {
    strategy = await thinkJSON({
      system: PERSONAS.awon,
      prompt: `Here is your current state. Decide your strategic focus for this cycle.

Your sandbox/memory:
${JSON.stringify(memory, null, 2)}

Current pipeline:
- Total clients: ${allClients.length} (${prospects.length} prospect, ${activeClients.length} active/negotiating)
- Footage queued for Vizard submission: ${queuedFootage.length}
- Footage currently processing at Vizard: ${processingFootage.length}
- Vizard configured: ${vizard.isConfigured()}
- Stripe configured: ${stripe.isConfigured()}
- Email sending configured: ${email.isConfigured()}
- Budget available: $${ledger.getAvailable().toFixed(2)}
- Pending blockers (don't act on these, just know they exist): ${pendingBlockers.map(b => b.title).join(", ") || "none"}

Notes Josh left for you since your last cycle (he can leave these anytime from the dashboard — they're proactive instructions or context, not something you asked for. Take them seriously and let them override your default focus if they're time-sensitive):
${notes.length > 0 ? notes.map(n => `- "${n.text}" (left ${n.createdAt})`).join("\n") : "None."}

Return JSON:
{
  "focus": "one sentence — what is the most important thing this cycle?",
  "runOutreachAgent": true/false,
  "runClipAgent": true/false,
  "runAnalyticsAgent": true/false,
  "reasoning": "why this focus?"
}`,
    });
    log("decision", `Strategic focus: ${strategy.focus}`, { reasoning: strategy.reasoning });
  } catch (err) {
    log("error", `Strategy decision failed: ${err.message}`);
    strategy = { focus: "Review pipeline state", runOutreachAgent: true, runClipAgent: true, runAnalyticsAgent: false };
  }

  // Deterministic overrides — don't let stale memory rule off work that
  // objectively exists to do (the predecessor of this business got stuck for
  // months on exactly this failure mode: a model deciding not to do
  // available work based on outdated beliefs).
  if ((queuedFootage.length > 0 || processingFootage.length > 0) && !strategy.runClipAgent) {
    log("decision", `Override: strategy skipped the clip agent despite footage waiting — running it anyway.`);
    strategy.runClipAgent = true;
  }
  if (prospects.some(p => !clients.hasBeenContacted(p)) && !strategy.runOutreachAgent) {
    log("decision", `Override: strategy skipped outreach despite un-contacted prospects — running it anyway.`);
    strategy.runOutreachAgent = true;
  }

  memory.strategy = strategy.focus;
  memory.cycleCount = cycleCount;

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
  let outreachResult = null, clipResult = null, analyticsInsights = null;

  if (strategy.runOutreachAgent) {
    try {
      outreachResult = await runOutreachAgent({ memory });
      log("sub-agent", "Outreach agent completed", { summary: outreachResult?.summary });
    } catch (err) {
      log("error", `Outreach agent failed: ${err.message}`);
    }
  }

  if (strategy.runClipAgent) {
    try {
      clipResult = await runClipAgent({ memory, ledger });
      log("sub-agent", "Clip agent completed", { summary: clipResult?.summary });
    } catch (err) {
      log("error", `Clip agent failed: ${err.message}`);
    }
  }

  if (strategy.runAnalyticsAgent) {
    try {
      analyticsInsights = await runAnalyticsAgent({ memory });
      log("sub-agent", "Analytics agent completed", { insights: analyticsInsights?.topInsight });
    } catch (err) {
      log("error", `Analytics agent failed: ${err.message}`);
    }
  }

  // ── 5. Reconcile confirmed revenue (Stripe) ────────────────────────────────
  if (stripe.isConfigured()) {
    try {
      const recentInvoices = await stripe.listRecentInvoices({ limit: 30 });
      for (const invoice of recentInvoices.filter(i => i.paid)) {
        const updated = clients.markInvoicePaid(invoice.id, invoice.amountPaidUsd);
        if (updated) {
          // Service business — no per-unit COGS to speak of yet (the real cost
          // is the flat monthly Vizard/email subscription, tracked separately
          // as its own ledger spend category, not per invoice).
          ledger.recordRevenue(invoice.amountPaidUsd, 0, `Invoice ${invoice.id} — ${updated.name}`);
          log("action", `Revenue reconciled: invoice ${invoice.id} (${updated.name}) — $${invoice.amountPaidUsd}`);
        }
      }
    } catch (err) {
      log("error", `Stripe reconciliation failed: ${err.message}`);
    }
  }

  // ── 6. Update memory / sandbox ─────────────────────────────────────────────
  try {
    const memoryUpdate = await thinkJSON({
      system: PERSONAS.awon,
      prompt: `Update your sandbox/memory based on this cycle.

What happened this cycle:
- Strategic focus: ${strategy.focus}
- Outreach agent ran: ${!!outreachResult}${outreachResult ? ` (${outreachResult.summary})` : ""}
- Clip agent ran: ${!!clipResult}${clipResult ? ` (${clipResult.summary})` : ""}
${analyticsInsights ? `- Analytics insights: ${JSON.stringify(analyticsInsights)}` : ""}

Current memory:
${JSON.stringify(memory, null, 2)}

Return JSON with ONLY the fields that should change:
{
  "strategy": "updated one-line strategic focus",
  "newLearning": "one specific thing you learned or confirmed this cycle (or null)",
  "nextActions": ["action 1", "action 2", "action 3"]
}`,
      fast: true,
    });

    if (memoryUpdate.strategy) memory.strategy = memoryUpdate.strategy;
    if (memoryUpdate.newLearning) addLearning(memory, memoryUpdate.newLearning);
    if (memoryUpdate.nextActions) memory.nextActions = memoryUpdate.nextActions;

  } catch (err) {
    log("error", `Memory update failed: ${err.message}`);
  }

  // Save memory snapshot before inner loop so sub-agents have current state
  saveMemory(memory);

  // ── 7. Inner work loop — Awon keeps working until time runs out ────────────
  try {
    const loopResult = await runInnerLoop({ memory, ledger });
    log("system", `Inner loop: ${loopResult.tasksCompleted} task(s) completed in ${loopResult.durationMinutes}min`);
  } catch (err) {
    log("error", `Inner loop crashed: ${err.message}`);
  }

  saveMemory(memory);
  log("system", `=== Full cycle complete. Budget: $${ledger.getAvailable().toFixed(2)} ===`);
}
