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
import * as email from "../integrations/email.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "..", "data", "blockers.json");
const OWNER_EMAIL = process.env.OWNER_EMAIL || "joshuamerlene@gmail.com";

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

  // A blocker that only shows up in the dashboard is a blocker nobody sees
  // until they happen to open it -- exactly how the budget-exhaustion blocker
  // sat unread for a full day. Same fire-and-forget alert pattern as the
  // public-intake email: never blocks blocker creation if Resend isn't
  // configured or the send fails.
  if (email.isConfigured()) {
    email
      .sendEmail({
        to: OWNER_EMAIL,
        subject: `Awon needs you — ${title}`,
        html:
          `<p>Awon hit something he can't resolve on his own:</p>` +
          `<p><strong>${title}</strong></p>` +
          `<p>${context}</p>` +
          (options.length ? `<p>Options: ${options.join(" | ")}</p>` : "") +
          `<p>Respond from the dashboard's blockers panel.</p>`,
      })
      .catch((e) => log("error", `Blocker alert email failed: ${e.message}`));
  }

  return blocker.id;
}

/**
 * Add a blocker only if a pending one with the same title doesn't already
 * exist. Use this for failures that repeat every cycle (bad API keys, dead
 * integrations) so they surface to Josh exactly once instead of either
 * spamming the queue or — worse — never showing up at all because the
 * calling code only logs the error and moves on.
 */
export function addBlockerOnce({ title, context, options = [], thread = "" }) {
  const queue = load();
  const alreadyPending = queue.some((b) => b.title === title && b.resolution === null);
  if (alreadyPending) return null;
  return addBlocker({ title, context, options, thread });
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

/**
 * Wipe the entire blocker queue. Used for a one-time clean start after a
 * business pivot (the 2026-07-28 Awon Video rebuild used this to clear out
 * Rival Is Me-era product/CJ-dropshipping blockers that no longer meant
 * anything) and exposed on the dashboard so a future pivot doesn't need a
 * manual data fix again.
 */
export function clearAllBlockers() {
  save([]);
}
