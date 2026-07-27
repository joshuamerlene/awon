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
 * - Every task actually executes: sends invoices, flags stale prospects, etc.
 * - Session log prevents repeating the same task twice
 * - Awon can declare "done" early if there's nothing valuable left
 */

import { thinkJSON, PERSONAS } from "./claude.js";
import { log } from "./logger.js";
import { addLearning } from "./memory.js";
import { addBlockerOnce } from "./queue.js";
import * as clients from "./clients.js";
import * as stripe from "../integrations/stripe.js";

const MAX_MINUTES = Number(process.env.INNER_LOOP_MINUTES || 40);
const MAX_TASKS   = Number(process.env.INNER_LOOP_MAX_TASKS || 10);

// ── Available actions Awon can self-assign ────────────────────────────────────

const ACTIONS = {

  draft_and_send_invoice: {
    description: "Find an active client with a closed deal but no open/paid invoice yet, and send one via Stripe. Only runs if STRIPE_SECRET_KEY is set.",
    async execute() {
      if (!stripe.isConfigured()) return "Skipped — STRIPE_SECRET_KEY not set.";

      const candidates = clients.getActiveClients().filter(
        (c) => c.rateUsd && !(c.invoices || []).some((inv) => inv.status === "open" || inv.status === "paid")
      );
      if (candidates.length === 0) return "No active clients need a fresh invoice right now.";

      const client = candidates[0];
      try {
        if (!client.contactEmail) throw new Error("no contact email on file");
        const customer = await stripe.findOrCreateCustomer({ email: client.contactEmail, name: client.name });
        clients.updateClient(client.id, { stripeCustomerId: customer.id });

        const description = client.dealType === "retainer"
          ? `${client.name} — monthly clip production retainer`
          : `${client.name} — clip production (${client.clipsDelivered || 0} clip(s) delivered)`;

        const invoice = await stripe.createAndSendInvoice({
          customerId: customer.id,
          description,
          amountUsd: client.rateUsd,
        });
        clients.attachInvoice(client.id, {
          invoiceId: invoice.invoiceId,
          amountUsd: client.rateUsd,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        });
        return `Sent invoice to "${client.name}" for $${client.rateUsd} (${invoice.invoiceId}).`;
      } catch (err) {
        return `Failed to invoice "${client.name}": ${err.message}`;
      }
    },
  },

  audit_prospect_pipeline: {
    description: "Review every prospect for missing contact info or staleness (contacted long ago with no follow-up), and flag anything Josh needs to act on. Prospect discovery itself runs inside the outreach agent (live web search), not here.",
    async execute() {
      const all = clients.getAllClients();
      const missingContact = all.filter((c) => c.status === "prospect" && !c.contactEmail);
      const staleContacted = all.filter((c) => {
        if (c.status !== "contacted") return false;
        const last = c.outreach?.[c.outreach.length - 1];
        if (!last) return false;
        const daysSince = (Date.now() - new Date(last.date).getTime()) / 86400000;
        return daysSince > 10;
      });

      if (missingContact.length > 0) {
        addBlockerOnce({
          title: `${missingContact.length} prospect(s) have no contact email`,
          context: `Can't send outreach without one: ${missingContact.map((c) => c.name).join(", ")}.`,
          options: ["I'll add contact emails via the dashboard"],
          thread: "Once contact info is added, outreach will go out next cycle.",
        });
      }

      return `Audited ${all.length} client(s): ${missingContact.length} missing contact info, ${staleContacted.length} contacted 10+ days ago with no reply logged.`;
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

GROUND TRUTH about what you can do — do NOT contradict this in your critique or your newRule:
- You EXECUTE DIRECTLY: sourcing footage submissions, drafting and sending outreach, producing clips, generating and sending Stripe invoices, and tracking the whole pipeline all run through your own tools and are DONE the moment they execute. That is your job, not Josh's.
- The ONLY things that require Josh personally: creating or authenticating any new external account (Stripe, email sending domain, Vizard, a social account for portfolio use), and signing an actual contract or deal commitment with a client.
- NEVER write a rule that says outreach, invoicing, or clip production is Josh's lane, that there's a "capability boundary," or that you only "prepare" while Josh "executes." That belief is FALSE. It stalled this business's predecessor for months and is banned here. If something is actually blocked, name the specific technical blocker (a missing API key, a missing contact email) — never a capability boundary.
- If the pipeline is empty, the fix is more real outreach to real prospects already in the system — not more planning or more "specs for Josh."

Return JSON:
{
  "wins": ["specific thing that worked or was the right call"],
  "misses": ["specific thing that was wrong or could have been better"],
  "newRule": "one specific operating principle — about YOUR execution, never about delegating to Josh",
  "priorityShift": "is there something you should be doing more or less of?"
}`,
        fast: true,
      });

      if (critique.newRule) addLearning(memory, critique.newRule);

      return `Self-critique complete. Wins: ${critique.wins?.length || 0}. Misses: ${critique.misses?.length || 0}. New rule: "${critique.newRule}"`;
    },
  },

  build_weekly_plan: {
    description: "Build a structured plan for the next 7 days — who to contact, what footage to process, what invoices are due. Store it in memory.",
    async execute({ memory }) {
      const all = clients.getAllClients();
      const plan = await thinkJSON({
        system: PERSONAS.awon,
        prompt: `Build a 7-day operating plan for the clip production business.

Current state:
- Total clients: ${all.length}
- Prospects awaiting first contact: ${clients.getProspects().filter(p => (p.outreach || []).length === 0).length}
- Active clients: ${clients.getActiveClients().length}
- Current strategy: ${memory.strategy}

Build a realistic, specific plan. Not aspirational — executable.

Return JSON:
{
  "weekTheme": "one overarching focus for this week",
  "days": [
    {
      "day": "Monday",
      "outreachGoal": "what outreach work to do",
      "deliveryGoal": "what footage/clip work to do",
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

// ── Inner loop orchestrator ────────────────────────────────────────────────────

export async function runInnerLoop({ memory, ledger }) {
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

    let decision;
    try {
      decision = await thinkJSON({
        system: PERSONAS.awon,
        prompt: `You've finished your main cycle work. You have ${timeRemaining} minutes left to work. What's the most valuable thing you can do right now?

Current state:
- Total clients: ${clients.getAllClients().length}
- Active clients: ${clients.getActiveClients().length}
- Stripe configured: ${stripe.isConfigured()}
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
      sessionLog.push(decision.action);
      continue;
    }

    log("action", `Inner loop task ${taskCount + 1}: ${decision.action} — ${decision.reasoning}`);

    try {
      const result = await action.execute({ memory, ledger });
      log("action", `Inner loop task done: ${result}`);
      sessionLog.push(decision.action);
      taskCount++;
    } catch (err) {
      log("error", `Inner loop task failed (${decision.action}): ${err.message}`);
      sessionLog.push(decision.action);
      taskCount++;
    }
  }

  const totalMin = Math.round((Date.now() - startTime) / 60000);
  log("system", `Inner loop complete — ${taskCount} task(s) in ${totalMin} min: [${sessionLog.join(" → ")}]`);

  return { tasksCompleted: taskCount, sessionLog, durationMinutes: totalMin };
}
