/**
 * core/memory.js — Awon's persistent sandbox / memory
 *
 * This is Awon's growing understanding of the business. He reads it
 * at the start of every cycle, updates it with what he learned, and
 * writes it back. Josh can view it in the dashboard as the "sandbox."
 *
 * Structure:
 *   businessIdentity — the BUSINESS_NAME this memory was last written under.
 *                       See scrubOnIdentityChange() below — this is the real
 *                       fix for the 2026-07-28 stale-memory bug, not just the
 *                       regex scrubs, which are kept as defense-in-depth only.
 *   strategy      — Awon's current strategic focus and reasoning
 *   experiments   — active tests and what they've taught him so far
 *   learnings     — confirmed insights Awon has locked in
 *   products      — his assessments of current catalog items
 *   contentNotes  — what content formats/hooks are working
 *   subAgents     — active sub-agent assignments and status
 *   nextActions   — what Awon plans to do next cycle
 *   businessLaunchedAt — when the CURRENT business identity went live (used by
 *                       the time-box checkpoint in core/awon.js) — reset along
 *                       with everything else on an identity change, since the
 *                       checkpoint clock has to restart with the new business,
 *                       not keep counting from the old one's launch date.
 *   updatedAt     — last write timestamp
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_PATH = path.join(__dirname, "..", "data", "memory.json");

const DEFAULT_MEMORY = {
  strategy: "Brand new. No clients yet. First priority: get real prospects into the pipeline (Josh adds candidates via the dashboard until a search integration exists), send real outreach, and close a first deal.",
  experiments: [],
  learnings: [],
  subAgents: [],
  nextActions: [],
  cycleCount: 0,
  updatedAt: null,
};

// The BUSINESS_NAME this codebase is currently running as. Compared against
// memory.businessIdentity on every load (see scrubOnIdentityChange) so a
// future pivot (like Rival Is Me -> Awon Video) resets memory structurally
// instead of relying on someone remembering to widen a regex list again.
const CURRENT_BUSINESS_NAME = process.env.BUSINESS_NAME || "";

/**
 * The real fix for the 2026-07-28 bug: memory.json lives on the Railway
 * volume and survives deploys BY DESIGN (so learnings aren't lost on every
 * redeploy) — but that also means a business-identity change doesn't
 * automatically invalidate old strategy/learnings/nextActions/experiments/
 * subAgents/contentNotes. The RETIRED_BUSINESS_PATTERNS regex scrub below
 * was the first fix, but it only catches fields whose exact old-business
 * phrasing someone thought to list — anything else (an experiment record, a
 * contentNotes entry, a subAgent assignment, a stale businessLaunchedAt
 * driving the wrong checkpoint clock) would have sailed through untouched.
 * This runs FIRST: if the business identity actually changed since memory
 * was last written, do a full reset rather than trying to enumerate every
 * place old-business residue could hide. The regex scrubs remain below as
 * defense-in-depth for memory written before this field existed, or for a
 * same-identity cycle where a stale belief crept back in some other way.
 */
function scrubOnIdentityChange(memory) {
  if (!CURRENT_BUSINESS_NAME) return memory; // env var not set — nothing to compare against
  if (memory.businessIdentity && memory.businessIdentity !== CURRENT_BUSINESS_NAME) {
    return { ...DEFAULT_MEMORY, businessIdentity: CURRENT_BUSINESS_NAME };
  }
  if (!memory.businessIdentity) memory.businessIdentity = CURRENT_BUSINESS_NAME;
  return memory;
}

// Stale-belief scrub. During the weeks the integrations were broken, Awon
// locked in a set of "learnings" that are now false and actively harmful:
// that TikTok access is unverified, that Josh's manual execution is the
// permanent blocker, that the right move is escalation deadlines aimed at
// Josh instead of doing the work. Those beliefs survived the integration
// fixes and steered every cycle's strategy away from producing anything.
// Filter them on EVERY load so re-learned variants get caught too.
const STALE_BELIEF_PATTERNS = [
  /permanent(ly)?\s+block/i,
  /blocking dependency/i,
  /unverified\b.{0,40}(tiktok|account|access)/i,
  /(tiktok|account|access).{0,40}\bunverified/i,
  /escalat(e|es|ion)/i,
  /binary decision gate/i,
  /decision gate/i,
  /decision deadline/i,
  /force[sd]? josh/i,
  /josh decision (gate|deadline)/i,
  /proof of (life|posting)/i,
  /ultimatum/i,
  // ── The "capability boundary / I prepare, Josh publishes" delegation belief.
  // This is FALSE (Awon publishes products, listings, blogs, collections, store
  // changes directly). It regenerated for 40+ cycles via self_critique, made
  // Awon sandbag and tell Josh he was "waiting on him," and kept the catalog
  // from being built. Scrub every variant on every load.
  /capability[- ]?(boundary|first)/i,
  /josh'?s\s+(work|role|lane|job|part|hands|column)\b/i,
  /josh\s+(executes|publishes|posts|owns all|reviews and)/i,
  /i (prepare|draft)[,;].{0,70}(josh|he)\s+(execut|publish|post|review)/i,
  /prepare[s]?\b.{0,50}\bjosh\b.{0,25}(execut|publish|post)/i,
  /(publishing|posting|execution)\s*[=:]\s*(josh|external)/i,
  /i cannot claim execution/i,
  /proof artifacts?\b/i,
  /external\s+(account\s+)?(access|posting|execution|verification)/i,
  /outside (my|this)\s+text\s+(interface|sandbox)/i,
  /text (interface|sandbox)\b/i,
  /aspirational delegation/i,
  /my (lane|column)\b/i,
  /within (my|the) capability/i,
  /publishing (live )?= josh/i,
  /exclusive, permanent control/i,
  /josh'?s human execution/i,
  /deadline (threat|forces)/i,
  /delegation model/i,
  /content agent ran \(false\)/i,
  /commitment gate/i,
  /assumes? exclusive/i,
  /operator[- ]exclusive/i,
  /account access protocol/i,
  /if josh does not respond/i,
  /irreversibl/i,
  /recovery protocol within/i,
  /proof artifacts? by/i,
];

// Retired-business scrub. The Rival Is Me → Awon Video redirect deleted every
// Shopify/Printful/CJ Dropshipping/product-catalog file from the codebase,
// but memory.json lives on the persistent volume and survives deploys by
// design — so the OLD strategy text ("generate branded product mockups...
// publish Printful listings...") kept re-seeding every cycle's decision step
// for a full day after the redirect shipped, even though self_critique
// correctly noticed every single cycle that no tool exists to execute it.
// Same fix pattern as the stale-belief scrub above: reset on sight rather
// than trust it to self-correct.
const RETIRED_BUSINESS_PATTERNS = [
  /rival is me/i,
  /printful/i,
  /\bshopify\b/i,
  /cj dropship/i,
  /\bmockup/i, // catches "product mockup", "branded mockup", etc. — this business does none
  /apparel/i,
  /merch(andise)?\b/i,
  /\bpod\b product/i,
  /\bhoodie|\btank\b|\bjoggers?\b|\bjersey\b/i,
];

function scrubRetiredBusiness(memory) {
  if (typeof memory.strategy === "string" && RETIRED_BUSINESS_PATTERNS.some((rx) => rx.test(memory.strategy))) {
    memory.strategy = DEFAULT_MEMORY.strategy;
  }
  if (Array.isArray(memory.learnings)) {
    memory.learnings = memory.learnings.filter((l) => {
      const text = typeof l === "string" ? l : (l && l.insight) || "";
      return !RETIRED_BUSINESS_PATTERNS.some((rx) => rx.test(text));
    });
  }
  if (Array.isArray(memory.nextActions)) {
    memory.nextActions = memory.nextActions.filter(
      (a) => !RETIRED_BUSINESS_PATTERNS.some((rx) => rx.test(String(a)))
    );
  }
  return memory;
}

function scrubStaleBeliefs(memory) {
  // The strategy field itself was left out of the original scrub, so ultimatum
  // language ("decision gate Friday", "operator escalates Monday") survived in
  // memory.strategy and re-seeded every cycle's thinking. Reset it on sight.
  if (typeof memory.strategy === "string" && STALE_BELIEF_PATTERNS.some((rx) => rx.test(memory.strategy))) {
    memory.strategy =
      "Close deals and deliver clips. Work the prospect pipeline, produce real work for active clients, get invoices out. No ultimatums — just work.";
  }
  if (Array.isArray(memory.learnings)) {
    memory.learnings = memory.learnings.filter((l) => {
      const text = typeof l === "string" ? l : (l && l.insight) || "";
      return !STALE_BELIEF_PATTERNS.some((rx) => rx.test(text));
    });
  }
  if (Array.isArray(memory.nextActions)) {
    memory.nextActions = memory.nextActions.filter(
      (a) => !STALE_BELIEF_PATTERNS.some((rx) => rx.test(String(a)))
    );
  }
  return scrubRetiredBusiness(memory);
}

export function loadMemory() {
  if (!fs.existsSync(MEMORY_PATH)) {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    const fresh = { ...DEFAULT_MEMORY, businessIdentity: CURRENT_BUSINESS_NAME };
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const onDisk = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"));
  return scrubStaleBeliefs(scrubOnIdentityChange(onDisk));
}

export function saveMemory(memory) {
  memory.updatedAt = new Date().toISOString();
  memory.cycleCount = (memory.cycleCount || 0) + 1;
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

export function addLearning(memory, learning) {
  // The model sometimes returns an object here — stringify it instead of
  // storing "[object Object]" in the sandbox.
  if (typeof learning !== "string") learning = JSON.stringify(learning);
  // Refuse to re-learn a scrubbed stale belief (see STALE_BELIEF_PATTERNS).
  if (STALE_BELIEF_PATTERNS.some((rx) => rx.test(learning))) return;
  memory.learnings.unshift({
    date: new Date().toISOString(),
    insight: learning,
  });
  // Keep last 50 learnings
  if (memory.learnings.length > 50) memory.learnings = memory.learnings.slice(0, 50);
}

export function addExperiment(memory, experiment) {
  memory.experiments.push({
    id: Date.now().toString(),
    startedAt: new Date().toISOString(),
    status: "active",
    ...experiment,
  });
}

export function resolveExperiment(memory, id, result) {
  const exp = memory.experiments.find((e) => e.id === id);
  if (exp) {
    exp.status = "resolved";
    exp.resolvedAt = new Date().toISOString();
    exp.result = result;
  }
}
