/**
 * agents/clipAgent.js — Clip Production Agent (replaces the old content.js)
 *
 * Real workflow for a client-footage clipping business:
 *   1. Client shares a URL to their raw long-form footage (a Drive/YouTube/
 *      link) — stored on their client record via core/clients.js.
 *      Vizard fetches the video server-side; we never host multi-GB files.
 *   2. Submit queued footage to Vizard (rights-gated — see below), which
 *      finds highlight moments itself and scores them.
 *   3. Poll processing footage; once Vizard is done, this agent picks which
 *      detected clips are actually worth delivering and writes the
 *      caption/hook/hashtags for each in the client's own voice.
 *   4. Download the chosen clips, run them through the existing
 *      integrations/video.js pass (9:16 format normalize) for consistency,
 *      and write them to a delivery queue Josh reviews from the dashboard.
 *
 * RIGHTS GATE: a client with rightsAuthorized !== true never gets footage
 * submitted, full stop — this is enforced here in code, not left to the
 * model's judgment alone (see PERSONAS.rightsReviewer for why).
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import { loadMemory, saveMemory, addLearning } from "../core/memory.js";
import { addBlockerOnce } from "../core/queue.js";
import * as vizard from "../integrations/vizard.js";
import * as video from "../integrations/video.js";
import * as clients from "../core/clients.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "../data/clip_queue.json");
const DOWNLOAD_DIR = path.join(__dirname, "../data/vizard-clips");

// NOT a real per-submission charge — confirmed from Vizard's own docs
// (2026-07-27): Vizard bills against monthly plan minutes (Creator/Business
// tier), consumption-based, not a fee per API call. This number is a rough
// internal safety cap only, so submissions still show up in the ledger and
// something stops an unbounded flood of requests — it does not reflect what
// Josh's Vizard invoice will actually say. The real signal to watch is a
// Vizard error code 4007 (account out of plan minutes), which raises its
// own distinct blocker below — that's the one that actually means "pay
// Vizard," not this number.
const VIZARD_COST_PER_SUBMISSION_USD = Number(process.env.VIZARD_COST_PER_SUBMISSION_USD || 2);

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_PATH)) return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  } catch { /* fall through */ }
  return [];
}

function saveQueue(queue) {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

export function getClipQueue() {
  return loadQueue();
}

/**
 * Josh reviews every clip before it reaches a client (see /review flow in the
 * dashboard) — this captures WHY he rejected one so the curation prompt below
 * can actually learn from it, instead of the same mistake repeating silently.
 */
export function rejectClip(id, reason) {
  const queue = loadQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) throw new Error(`Clip ${id} not found in queue.`);
  item.status = "rejected";
  item.rejectedAt = new Date().toISOString();
  item.rejectionReason = reason || null;
  saveQueue(queue);
  if (reason) {
    const memory = loadMemory();
    addLearning(memory, `Clip rejected for "${item.clientName}" (caption: "${(item.caption || "").slice(0, 80)}"): ${reason}`);
    saveMemory(memory);
  }
  return item;
}

export function markClipDelivered(id) {
  const queue = loadQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) throw new Error(`Clip ${id} not found in queue.`);
  item.status = "delivered";
  item.deliveredAt = new Date().toISOString();
  saveQueue(queue);
  if (item.clientId) {
    const client = clients.getClient(item.clientId);
    if (client) clients.updateClient(client.id, { clipsDelivered: (client.clipsDelivered || 0) + 1 });
  }
}

export async function runClipAgent({ memory, ledger }) {
  log("sub-agent", "Clip agent starting...");

  let submitted = 0, polled = 0, delivered = 0;

  // ── 1. Submit queued, rights-cleared footage to Vizard ──────────────────
  // Every submission costs real money — gated through the same ledger every
  // other spend in this app goes through, not a bare API call with no cap.
  const queuedFootage = clients.getFootageByStatus("queued");
  for (const footage of queuedFootage) {
    if (!footage.rightsAuthorized) {
      log("decision", `Skipping footage submission for "${footage.clientName}" — no rights authorization on file. Flag this for Josh before proceeding.`);
      continue;
    }
    if (!vizard.isConfigured()) {
      log("system", "VIZARD_API_KEY not set — footage stays queued until it's configured.");
      break;
    }
    if (ledger) {
      const check = ledger.canSpend(VIZARD_COST_PER_SUBMISSION_USD, "vizard_clipping");
      if (!check.allowed) {
        addBlockerOnce({
          title: "Budget too low to submit footage to Vizard",
          context: `Next footage submission (~$${VIZARD_COST_PER_SUBMISSION_USD}) would exceed the available budget: ${check.reason}`,
          options: ["Add funds via the dashboard Budget panel"],
          thread: "Once funded, queued footage submits automatically — nothing is lost, it just waits.",
        });
        log("decision", `Vizard submission for "${footage.clientName}" skipped — budget check failed: ${check.reason}`);
        continue;
      }
    }
    try {
      const { projectId } = await vizard.submitVideoForClipping({
        videoUrl: footage.url,
        projectName: `${footage.clientName} — ${footage.id}`,
      });
      clients.updateFootageSubmission(footage.clientId, footage.id, { status: "processing", vizardProjectId: projectId });
      if (ledger) ledger.recordSpend(VIZARD_COST_PER_SUBMISSION_USD, "vizard_clipping", `Footage submission for ${footage.clientName}`);
      submitted++;
      log("action", `Submitted footage from "${footage.clientName}" to Vizard (project ${projectId}).`);
    } catch (err) {
      log("error", `Vizard submit failed for "${footage.clientName}": ${err.message}`);
      if (err.vizardCode === 4007) {
        // This is Vizard's OWN account running out of plan minutes — a
        // completely different fix (pay Vizard) than Awon's internal budget
        // being low. Don't let it get lost in the generic error log.
        addBlockerOnce({
          title: "Vizard account is out of plan minutes",
          context: `Vizard rejected a submission for "${footage.clientName}" with error 4007 — the Vizard account itself is out of consumption for this billing period, separate from Awon's own budget ledger. This needs a top-up or plan upgrade directly on vizard.ai.`,
          options: ["I've upgraded/topped up the Vizard plan"],
          thread: "Once Vizard's own account has capacity again, queued footage submits automatically.",
        });
      }
    }
  }

  // ── 2. Poll processing footage ───────────────────────────────────────────
  const processingFootage = clients.getFootageByStatus("processing");
  for (const footage of processingFootage) {
    if (!footage.vizardProjectId) continue;
    try {
      const result = await vizard.queryProject(footage.vizardProjectId);
      polled++;
      if (!result.ready) continue;

      if (!result.videos || result.videos.length === 0) {
        clients.updateFootageSubmission(footage.clientId, footage.id, { status: "ready" });
        log("system", `Vizard found no usable clips in footage from "${footage.clientName}".`);
        continue;
      }

      // Let the clip agent decide which detected moments are actually worth
      // delivering and write the caption/hook/hashtags for each, in the
      // client's own voice. Ground it in what Josh has actually rejected
      // before — a real feedback loop, not the same mistake repeating.
      const clipRejectionLearnings = (memory.learnings || [])
        .map(l => (typeof l === "string" ? l : l.insight))
        .filter(Boolean)
        .filter(l => l.includes("Clip rejected"))
        .slice(0, 5);

      const decision = await thinkJSON({
        system: PERSONAS.clipAgent,
        prompt: `Vizard detected these highlight candidates from ${footage.clientName}'s footage. Decide which are actually worth delivering as finished clips, and write the delivery copy for each.

Josh's past clip rejections (avoid repeating whatever pattern got these rejected): ${clipRejectionLearnings.join(" | ") || "none yet — no rejections on file"}

Candidates (sorted by Vizard's own viral score, 0-10):
${JSON.stringify(result.videos.map(v => ({
  videoId: v.videoId,
  title: v.title,
  transcript: v.transcript?.slice(0, 500),
  viralScore: v.viralScore,
  viralReason: v.viralReason,
  durationMs: v.durationMs,
})), null, 2)}

Return JSON:
{
  "selections": [
    {
      "videoId": "matching videoId from above",
      "caption": "full caption in the client's voice, max 150 chars",
      "hook": "short line for on-screen hook text, under 40 chars, or null",
      "hashtags": ["relevant", "tags"],
      "reasoning": "why this one is worth delivering"
    }
  ],
  "skipped": ["videoId of any candidate not worth delivering, and why — reference in reasoning if needed"]
}`,
      });

      const chosen = (decision.selections || []).filter(s => result.videos.some(v => String(v.videoId) === String(s.videoId)));
      if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

      const queue = loadQueue();
      for (const sel of chosen) {
        const source = result.videos.find(v => String(v.videoId) === String(sel.videoId));
        try {
          const rawPath = path.join(DOWNLOAD_DIR, `${sel.videoId}_raw.mp4`);
          await vizard.downloadClip(source.videoUrl, rawPath);
          const finalPath = await video.prepareForTikTok(rawPath, `${sel.videoId}_final.mp4`);
          video.cleanupEditedClip(rawPath);

          queue.push({
            id: `clip_${Date.now()}_${sel.videoId}`,
            clientId: footage.clientId,
            clientName: footage.clientName,
            status: "pending",
            videoPath: finalPath,
            caption: sel.caption,
            hook: sel.hook,
            hashtags: sel.hashtags || [],
            viralScore: source.viralScore,
            queuedAt: new Date().toISOString(),
          });

          delivered++;
        } catch (err) {
          log("error", `Failed to download/prepare clip ${sel.videoId} for "${footage.clientName}": ${err.message}`);
        }
      }
      saveQueue(queue);

      clients.updateFootageSubmission(footage.clientId, footage.id, { status: "ready" });
      log("action", `Clip agent produced ${chosen.length} deliverable clip(s) for "${footage.clientName}" from ${result.videos.length} candidates.`);
    } catch (err) {
      log("error", `Vizard poll failed for "${footage.clientName}": ${err.message}`);
    }
  }

  log("sub-agent", `Clip agent done. ${submitted} submitted, ${polled} polled, ${delivered} clip(s) queued for delivery.`);
  return { summary: `${submitted} footage submission(s) sent to Vizard, ${delivered} clip(s) ready for delivery review.`, submitted, delivered };
}
