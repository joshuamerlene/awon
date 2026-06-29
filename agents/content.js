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

  const result = await thinkJSON({
    system: PERSONAS.contentAgent,
    prompt: `Plan content for The Rival Is Me this cycle.

Available TikTok videos on @the.rival.is.me:
${videos.length > 0
  ? JSON.stringify(videos.map(v => ({
      id: v.id,
      description: v.title || v.description,
      viewCount: v.statistics?.play_count,
      likeCount: v.statistics?.like_count,
      duration: v.duration,
      createTime: v.create_time,
    })), null, 2)
  : "No TikTok API data yet. Plan content for original footage — document the training journey."}

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
  "postsToQueue": [
    {
      "videoId": "existing TikTok video ID if tagging existing content, or null for new content",
      "caption": "full caption — direct, raw, sounds like a real person. Max 150 chars.",
      "hashtags": ["discipline", "therivalisme", "gymtok"],
      "productId": "Shopify product ID to tag (or null)",
      "suggestedPostTime": "ISO timestamp — best time to post",
      "hook": "the first line/verbal hook. 0-2 seconds. Make them stop.",
      "contentAngle": "discipline|transformation|product|challenge|motivation",
      "editingNotes": "specific editing instructions — trim points, overlays, text, sound suggestion",
      "seriesTag": "optional series name if this fits an arc"
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
  "contentSeriesIdea": "a 3-video arc to build momentum",
  "trendingOpportunity": "any fitness trend or sound worth riding"
}

Write at least 2 posts. Be specific — write actual captions, actual hooks. Don't return templates.`,
  });

  // ── Queue new posts ──────────────────────────────────────────────────────
  const queue = loadQueue();
  const newItems = (result.postsToQueue || []).map((post, i) => ({
    id: `${Date.now()}_${i}`,
    status: "pending",
    queuedAt: new Date().toISOString(),
    ...post,
  }));

  queue.push(...newItems);
  saveQueue(queue);

  log("sub-agent", `Content agent done. ${newItems.length} post(s) queued (total pending: ${queue.filter(i => i.status === "pending").length}). Series idea: "${result.contentSeriesIdea?.slice(0, 80)}"`);

  return {
    summary: result.summary,
    postsToPublish: [],  // Empty until TikTok API is live — use queue instead
    queuedPosts: newItems,
    productTags: result.productTags || [],
    boostCandidate: result.boostCandidate || null,
    contentSeriesIdea: result.contentSeriesIdea,
    trendingOpportunity: result.trendingOpportunity,
  };
}
