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

export function loadMemory() {
  if (!fs.existsSync(MEMORY_PATH)) {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(DEFAULT_MEMORY, null, 2));
    return { ...DEFAULT_MEMORY };
  }
  return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"));
}

export function saveMemory(memory) {
  memory.updatedAt = new Date().toISOString();
  memory.cycleCount = (memory.cycleCount || 0) + 1;
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2));
}

export function addLearning(memory, learning) {
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
