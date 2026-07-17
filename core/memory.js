/**
 * core/memory.js — Awon's persistent sandbox / memory
 *
 * This is Awon's growing understanding of the business. He reads it
 * at the start of every cycle, updates it with what he learned, and
 * writes it back. Josh can view it in the dashboard as the "sandbox."
 *
 * Structure:
 *   strategy      — Awon's current strategic focus and reasoning
 *   experiments   — active tests and what they've taught him so far
 *   learnings     — confirmed insights Awon has locked in
 *   products      — his assessments of current catalog items
 *   contentNotes  — what content formats/hooks are working
 *   subAgents     — active sub-agent assignments and status
 *   nextActions   — what Awon plans to do next cycle
 *   updatedAt     — last write timestamp
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_PATH = path.join(__dirname, "..", "data", "memory.json");

const DEFAULT_MEMORY = {
  strategy: "Brand new. No data yet. First priority: get products live on TikTok Shop and Shopify, then drive organic traffic through existing workout footage.",
  experiments: [],
  learnings: [],
  products: [],
  contentNotes: {
    workingFormats: [],
    workingHooks: [],
    bestPostingTimes: [],
    audienceInsights: [],
  },
  subAgents: [],
  nextActions: [],
  cycleCount: 0,
  updatedAt: null,
};

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

function scrubStaleBeliefs(memory) {
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
  return memory;
}

export function loadMemory() {
  if (!fs.existsSync(MEMORY_PATH)) {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(DEFAULT_MEMORY, null, 2));
    return { ...DEFAULT_MEMORY };
  }
  return scrubStaleBeliefs(JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8")));
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
