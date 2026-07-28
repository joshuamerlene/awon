/**
 * core/freeTrial.js — free trial slot tracking for the public website funnel
 *
 * The site (awonvideo.com) offers a limited number of free trial clip
 * batches as the tripwire that gets a stranger to say yes with zero risk —
 * it doubles as real portfolio content, since none exists yet. This module
 * is the single source of truth for how many are left, so the public site
 * can flip its own copy from "free trial" to "let's talk pricing" the
 * moment the limit is hit, without anyone touching the site by hand.
 *
 * Counted off clients whose sourceChannel is "website-free-trial" — set
 * once, at intake, never retroactively changed by later status updates.
 */

import { getAllClients } from "./clients.js";
import { addBlockerOnce } from "./queue.js";

export const FREE_TRIAL_LIMIT = Number(process.env.FREE_TRIAL_LIMIT || 5);
export const FREE_TRIAL_SOURCE = "website-free-trial";

export function freeTrialUsedCount() {
  return getAllClients().filter((c) => c.sourceChannel === FREE_TRIAL_SOURCE).length;
}

export function getFreeTrialStatus() {
  const used = freeTrialUsedCount();
  return {
    limit: FREE_TRIAL_LIMIT,
    used,
    remaining: Math.max(0, FREE_TRIAL_LIMIT - used),
    open: used < FREE_TRIAL_LIMIT,
  };
}

/**
 * Call right after a new client is created off the public intake form. If
 * this submission was the one that used up the last slot, raise a real
 * blocker (once — addBlockerOnce dedupes on title) so Josh actually sets
 * real pricing instead of the site quietly going stale on "free trial"
 * language after the limit is already full.
 */
export function checkAndFlagIfJustFilled() {
  const status = getFreeTrialStatus();
  if (status.used >= status.limit) {
    addBlockerOnce({
      title: `Free trial slots full — ${status.limit} used, time to set real pricing`,
      context: `All ${status.limit} free trial spots on awonvideo.com have been claimed. The public site already stopped offering the free trial automatically (it checks /api/public/status live), so nothing breaks while this sits unresolved — but every new prospect from here on lands on "let's talk pricing" with no actual number to quote them.`,
      options: [
        "Set per-clip and/or retainer pricing — give me the numbers to quote",
        "Extend the free trial limit (raise FREE_TRIAL_LIMIT) instead of pricing yet",
        "Pause new intake until I decide",
      ],
      thread: "Whatever Josh decides here becomes the real pricing quoted to every prospect from now on.",
    });
  }
}
