/**
 * agents/clipAgent.js — Clip Production Agent (replaces the old content.js)
 *
 * Real workflow for a client-footage clipping business:
 *   1. Client shares a URL to their raw long-form footage (a Drive/YouTube/
 *      Dropbox link) — stored on their client record via core/clients.js.
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
import * as vizard from "../integrations/vizard.js";
import * as video from "../integrations/video.js";
import * as clients from "../core/clients.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "../data/clip_queue.json");
const DOWNLOAD_DIR = path.join(__dirname, "../data/vizard-clips");

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

export async function runClipAgent({ memory }) {
  log("sub-agent", "Clip agent starting...");

  let submitted = 0, polled = 0, delivered = 0;

  // ── 1. Submit queued, rights-cleared footage to Vizard ──────────────────
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
    try {
      const { projectId } = await vizard.submitVideoForClipping({
        videoUrl: footage.url,
        projectName: `${footage.clientName} — ${footage.id}`,
      });
      clients.updateFootageSubmission(footage.clientId, footage.id, { status: "processing", vizardProjectId: projectId });
      submitted++;
      log("action", `Submitted footage from "${footage.clientName}" to Vizard (project ${projectId}).`);
    } catch (err) {
      log("error", `Vizard submit failed for "${footage.clientName}": ${err.message}`);
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
      // client's own voice.
      const decision = await thinkJSON({
        system: PERSONAS.clipAgent,
        prompt: `Vizard detected these highlight candidates from ${footage.clientName}'s footage. Decide which are actually worth delivering as finished clips, and write the delivery copy for each.

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
