/**
 * core/queue.js — Awon's blocker queue
 *
 * When Awon hits something he genuinely can't decide alone, he parks
 * it here with full context and keeps working other angles. Josh sees
 * these in the dashboard, responds, and Awon picks them up next cycle.
 *
 * Blocker shape:
 * {
 *   id          — unique ID
 *   createdAt   — when Awon added it
 *   title       — short description of what he needs
 *   context     — what Awon was doing and why he's blocked
 *   options     — optional array of choices Josh can pick from
 *   resolution  — null until Josh responds
 *   resolvedAt  — timestamp of resolution
 *   thread      — what Awon will do once unblocked (for his own reference)
 * }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "..", "data", "blockers.json");

function load() {
  if (!fs.existsSync(QUEUE_PATH)) {
    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify([], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
}

function save(queue) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

/** Add a new blocker to the queue. Returns the blocker id. */
export function addBlocker({ title, context, options = [], thread = "" }) {
  const queue = load();
  const blocker = {
    id: `blk_${Date.now()}`,
    createdAt: new Date().toISOString(),
    title,
    context,
    options,
    thread,
    resolution: null,
    resolvedAt: null,
  };
  queue.push(blocker);
  save(queue);
  return blocker.id;
}

/** Get all pending (unresolved) blockers. */
export function getPendingBlockers() {
  return load().filter((b) => b.resolution === null);
}

/** Get all resolved blockers that haven't been processed yet. */
export function getResolvedBlockers() {
  return load().filter((b) => b.resolution !== null && !b.processed);
}

/** Mark a blocker as processed after Awon has acted on the resolution. */
export function markProcessed(id) {
  const queue = load();
  const blocker = queue.find((b) => b.id === id);
  if (blocker) {
    blocker.processed = true;
    save(queue);
  }
}

/** Resolve a blocker (called from the dashboard API when Josh responds). */
export function resolveBlocker(id, resolution) {
  const queue = load();
  const blocker = queue.find((b) => b.id === id);
  if (!blocker) throw new Error(`Blocker ${id} not found.`);
  blocker.resolution = resolution;
  blocker.resolvedAt = new Date().toISOString();
  save(queue);
  return blocker;
}

/** Get all blockers (for dashboard display). */
export function getAllBlockers() {
  return load().reverse(); // newest first
}
