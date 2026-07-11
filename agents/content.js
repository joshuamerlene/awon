/**
 * agents/content.js — Content Agent (Think + Queue)
 *
 * Awon's content arm. This agent:
 *   1. Plans TikTok content based on products, videos, and brand creed
 *   2. Writes hooks, captions, and posting schedules
 *   3. Writes everything to a persistent content queue (content_queue.json)
 *   4. When TikTok API is live, awon.js drains the queue and posts automatically
 *
 * Nothing is lost even when TikTok API isn't wired yet.
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import * as video from "../integrations/video.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "../data/content_queue.json");

// ── Queue helpers ─────────────────────────────────────────────────────────────

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_PATH)) {
      return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    }
  } catch (_) {}
  return [];
}

function saveQueue(queue) {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

export function getContentQueue() {
  return loadQueue();
}

export function drainQueueItem(id) {
  const queue = loadQueue();
  const updated = queue.map(item =>
    item.id === id ? { ...item, status: "posted", postedAt: new Date().toISOString() } : item
  );
  saveQueue(updated);
}

// ── Main agent ────────────────────────────────────────────────────────────────

export async function runContentAgent({ videos, products, memory }) {
  log("sub-agent", "Content agent starting...");

  const existingQueue = loadQueue();
  const pendingCount = existingQueue.filter(i => i.status === "pending").length;

  // Ground planning in footage that actually exists. Josh isn't going to film
  // specific shots on request — he uploads clips (his older TikToks) and
  // Awon has to work with what's there. Previously this agent planned shot
  // lists as if new footage would appear on demand, then always returned
  // postsToPublish: [] regardless — nothing was ever actually produced or
  // posted. Now it picks a real uploaded file and edits it this cycle.
  const rawFootage = video.listRawFootage();
  const usedFootage = memory.usedFootage || [];
  const footageForPrompt = rawFootage.map(f => ({
    filename: f.filename,
    sizeMB: (f.sizeBytes / 1_000_000).toFixed(1),
    uploadedAt: f.uploadedAt,
    alreadyUsedByAwon: usedFootage.includes(f.filename),
  }));

  const result = await thinkJSON({
    system: PERSONAS.contentAgent,
    prompt: `Plan content for The Rival Is Me this cycle.

IMPORTANT: You do not get to request new footage or describe a video for Josh to go film. He is not filming anything on demand. You work only with raw clips he has already uploaded (his older TikToks) — pick from what actually exists below, or leave postToProduce.sourceFootageFilename null if there's genuinely nothing usable.

Raw footage available (Josh's uploaded clips):
${footageForPrompt.length > 0
  ? JSON.stringify(footageForPrompt, null, 2)
  : "None uploaded yet — you cannot produce a real post this cycle. Only write caption/idea drafts to the queue for when footage exists."}

Already-published TikTok videos on @the.rival.is.me (for product-tagging existing posts, not for producing new ones):
${videos.length > 0
  ? JSON.stringify(videos.map(v => ({
      id: v.id,
      description: v.title || v.description,
      viewCount: v.statistics?.play_count,
      likeCount: v.statistics?.like_count,
    })), null, 2)
  : "None fetched."}

Current products to feature:
${JSON.stringify(products.map(p => ({ id: p.id, title: p.title, price: p.variants?.[0]?.price })), null, 2)}

What's been working (from memory):
${memory.contentNotes?.workingFormats?.join(", ") || "No data yet"}
${memory.contentNotes?.workingHooks?.join(", ") || ""}

Posts already queued (pending): ${pendingCount}
Queue items (last 5):
${JSON.stringify(existingQueue.slice(-5).map(i => ({ caption: i.caption?.slice(0, 80), status: i.status, queuedAt: i.queuedAt })), null, 2)}

Return JSON:
{
  "summary": "one-sentence content plan for this cycle",
  "postToProduce": {
    "sourceFootageFilename": "exact filename copied from the raw footage list above, or null if nothing usable exists",
    "caption": "full caption — direct, raw, sounds like a real person. Max 150 chars.",
    "hashtags": ["discipline", "therivalisme", "gymtok"],
    "hook": "short line burned onto the first ~3 seconds of the clip. Under 40 characters so it fits on screen. Null if the clip doesn't need one.",
    "trimStartSec": 0,
    "trimDurationSec": null,
    "productId": "Shopify product ID to tag, or null",
    "reasoning": "why this clip, why this angle"
  },
  "postsToQueue": [
    {
      "caption": "additional caption idea for a future cycle — full caption, max 150 chars",
      "hashtags": ["..."],
      "hook": "...",
      "contentAngle": "discipline|transformation|product|challenge|motivation",
      "seriesTag": "optional series name"
    }
  ],
  "productTags": [
    { "videoId": "...", "productId": "...", "caption": "updated caption for existing video" }
  ],
  "boostCandidate": {
    "videoId": "...",
    "amountUsd": 0,
    "reasoning": "specific data justifying spend"
  },
  "trendingOpportunity": "any fitness trend or sound worth riding"
}

postToProduce is the ONE clip you're actually turning into a post this cycle — prefer footage not already used unless you have a specific creative reason to re-cut it. postsToQueue is just backlog caption ideas for later, they don't need footage yet. Be specific — write actual captions, actual hooks, not templates.`,
  });

  // ── Produce the actual video for this cycle, if a real clip was chosen ────
  const postsToPublish = [];
  const chosen = result.postToProduce;

  if (chosen?.sourceFootageFilename) {
    const source = rawFootage.find(f => f.filename === chosen.sourceFootageFilename);
    if (!source) {
      log("error", `Content agent picked footage "${chosen.sourceFootageFilename}" that doesn't exist in raw-footage — skipping production this cycle.`);
    } else {
      try {
        let workingPath = source.path;

        if (chosen.trimDurationSec) {
          workingPath = await video.trimClip(workingPath, `trim_${Date.now()}.mp4`, {
            startSec: chosen.trimStartSec || 0,
            durationSec: chosen.trimDurationSec,
          });
        }

        let finalPath = await video.prepareForTikTok(workingPath, `ready_${Date.now()}.mp4`);

        if (chosen.hook) {
          finalPath = await video.addTextOverlay(finalPath, `hooked_${Date.now()}.mp4`, chosen.hook, {
            startSec: 0,
            durationSec: 3,
          });
        }

        postsToPublish.push({
          videoPath: finalPath,
          caption: chosen.caption,
          hashtags: chosen.hashtags || [],
          productId: chosen.productId || null,
          sourceFootageFilename: chosen.sourceFootageFilename,
        });

        memory.usedFootage = [...new Set([...(memory.usedFootage || []), chosen.sourceFootageFilename])];

        log("action", `Edited "${chosen.sourceFootageFilename}" into a TikTok-ready clip — queued for publish this cycle. ${chosen.reasoning || ""}`);
      } catch (err) {
        log("error", `Video editing failed for "${chosen.sourceFootageFilename}": ${err.message}`);
      }
    }
  } else if (rawFootage.length === 0) {
    log("system", "Content agent: no raw footage uploaded — nothing to produce this cycle. Waiting on Josh to upload clips.");
  }

  // ── Queue backlog caption ideas (no footage tied yet) ─────────────────────
  const queue = loadQueue();
  const newItems = (result.postsToQueue || []).map((post, i) => ({
    id: `${Date.now()}_${i}`,
    status: "pending",
    queuedAt: new Date().toISOString(),
    ...post,
  }));

  queue.push(...newItems);
  saveQueue(queue);

  log("sub-agent", `Content agent done. ${postsToPublish.length} post produced this cycle, ${newItems.length} backlog idea(s) queued.`);

  return {
    summary: result.summary,
    postsToPublish,
    queuedPosts: newItems,
    productTags: result.productTags || [],
    boostCandidate: result.boostCandidate || null,
    trendingOpportunity: result.trendingOpportunity,
  };
}
