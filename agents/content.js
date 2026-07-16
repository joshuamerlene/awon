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
  const usedSegments = memory.usedSegments || {}; // filename → [{start, dur}]

  // Probe clip durations once and cache them in memory — the remix prompt is
  // only useful if the model knows how long each clip actually is. Probing is
  // capped per cycle so a 300-clip bulk import doesn't stall the agent.
  memory.footageMeta = memory.footageMeta || {};
  let probed = 0;
  for (const f of rawFootage) {
    if (memory.footageMeta[f.filename] || probed >= 50) continue;
    try {
      const info = await video.getVideoInfo(f.path);
      memory.footageMeta[f.filename] = { durationSec: Math.round(info.durationSec || 0) };
    } catch {
      memory.footageMeta[f.filename] = { durationSec: null };
    }
    probed++;
  }

  // Cap the prompt list: unused clips first, then least-remixed
  const footageForPrompt = rawFootage
    .map(f => ({
      filename: f.filename,
      durationSec: memory.footageMeta[f.filename]?.durationSec ?? null,
      segmentsAlreadyUsed: (usedSegments[f.filename] || []).map(s => `${s.start}s-${s.start + s.dur}s`),
      remixCount: (usedSegments[f.filename] || []).length + (usedFootage.includes(f.filename) ? 1 : 0),
    }))
    .sort((a, b) => a.remixCount - b.remixCount)
    .slice(0, 60);

  // How many posts to produce per cycle (each one lands private; Josh flips
  // them public manually, so keep this within what he'll actually flip).
  const postsPerCycle = Math.min(Math.max(Number(process.env.POSTS_PER_CYCLE || 2), 1), 4);

  const result = await thinkJSON({
    system: PERSONAS.contentAgent,
    prompt: `Plan content for The Rival Is Me this cycle.

IMPORTANT: You do not get to request new footage or describe a video for Josh to go film. He is not filming anything on demand. You work only with raw clips he has already uploaded (his older TikToks) — pick from what actually exists below, or return an empty postsToProduce array if there's genuinely nothing usable.

You are a REMIXER: you can splice segments from MULTIPLE clips into one post (they get concatenated in order), or cut a fresh segment from a clip that's been used before — avoid re-cutting the exact same seconds (each clip lists which second-ranges are already used). durationSec on a clip is its total length; keep each segment inside it. Good TikTok posts from this footage are 6-30 seconds total.

Produce up to ${postsPerCycle} post(s) this cycle. Every post lands as a PRIVATE draft that Josh flips public manually — make each one worth his tap.

Raw footage available (Josh's uploaded clips — durationSec is total clip length, segmentsAlreadyUsed are second-ranges you've already posted from it):
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
  "postsToProduce": [
    {
      "segments": [
        { "sourceFootageFilename": "exact filename copied from the raw footage list above", "startSec": 0, "durationSec": 8 }
      ],
      "caption": "full caption — direct, raw, sounds like a real person. Max 150 chars.",
      "hashtags": ["discipline", "therivalisme", "gymtok"],
      "hook": "short line burned onto the first ~3 seconds. Under 40 characters so it fits on screen. Null if it doesn't need one.",
      "productId": "Shopify product ID to tag, or null",
      "reasoning": "why these segments, why this angle"
    }
  ],
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

postsToProduce are the posts you're actually producing this cycle (max ${postsPerCycle}) — each is built from real segments of real files above. postsToQueue is just backlog caption ideas for later, they don't need footage yet. Be specific — write actual captions, actual hooks, not templates.`,
  });

  // ── Produce the actual videos for this cycle ───────────────────────────────
  const postsToPublish = [];
  const plannedPosts = (result.postsToProduce || []).slice(0, postsPerCycle);

  for (const [postIndex, chosen] of plannedPosts.entries()) {
    const segments = (chosen.segments || []).filter(s => s.sourceFootageFilename);
    if (segments.length === 0) continue;

    // Every segment's source file must actually exist
    const missing = segments.find(s => !rawFootage.some(f => f.filename === s.sourceFootageFilename));
    if (missing) {
      log("error", `Content agent picked footage "${missing.sourceFootageFilename}" that doesn't exist in raw-footage — skipping this post.`);
      continue;
    }

    try {
      const stamp = `${Date.now()}_${postIndex}`;

      // Cut each segment
      const segmentPaths = [];
      for (const [i, seg] of segments.entries()) {
        const source = rawFootage.find(f => f.filename === seg.sourceFootageFilename);
        const cut = await video.trimClip(source.path, `seg_${stamp}_${i}.mp4`, {
          startSec: seg.startSec || 0,
          durationSec: seg.durationSec || undefined,
        });
        segmentPaths.push(cut);
      }

      // Splice if multi-segment, then normalize + hook
      let workingPath = segmentPaths.length > 1
        ? await video.concatClips(segmentPaths, `spliced_${stamp}.mp4`)
        : segmentPaths[0];

      let finalPath = await video.prepareForTikTok(workingPath, `ready_${stamp}.mp4`);

      if (chosen.hook) {
        finalPath = await video.addTextOverlay(finalPath, `hooked_${stamp}.mp4`, chosen.hook, {
          startSec: 0,
          durationSec: 3,
        });
      }

      // Clean up intermediate cuts (final clip is cleaned post-publish by awon.js)
      for (const p of [...segmentPaths, workingPath]) {
        if (p !== finalPath) video.cleanupEditedClip(p);
      }

      postsToPublish.push({
        videoPath: finalPath,
        caption: chosen.caption,
        hashtags: chosen.hashtags || [],
        productId: chosen.productId || null,
        sourceFootageFilename: segments.map(s => s.sourceFootageFilename).join(" + "),
      });

      // Record usage at segment level so future cycles cut fresh moments
      memory.usedSegments = memory.usedSegments || {};
      for (const seg of segments) {
        memory.usedSegments[seg.sourceFootageFilename] = memory.usedSegments[seg.sourceFootageFilename] || [];
        memory.usedSegments[seg.sourceFootageFilename].push({
          start: Math.round(seg.startSec || 0),
          dur: Math.round(seg.durationSec || 0),
        });
        memory.usedFootage = [...new Set([...(memory.usedFootage || []), seg.sourceFootageFilename])];
      }

      log("action", `Remixed ${segments.length} segment(s) [${segments.map(s => `${s.sourceFootageFilename} @${s.startSec || 0}s`).join(", ")}] into a TikTok-ready post. ${chosen.reasoning || ""}`);
    } catch (err) {
      log("error", `Video editing failed for post ${postIndex + 1} [${segments.map(s => s.sourceFootageFilename).join(", ")}]: ${err.message}`);
    }
  }

  if (plannedPosts.length === 0 && rawFootage.length === 0) {
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
