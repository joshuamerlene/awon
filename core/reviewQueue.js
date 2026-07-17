/**
 * core/reviewQueue.js — TikTok post review queue
 *
 * When TIKTOK_REVIEW_MODE=true, the content agent's finished videos wait
 * here instead of auto-posting. Josh reviews each one on the dashboard's
 * /review.html page — TikTok's audit-compliant compose flow (creator info,
 * privacy selection, interaction toggles, commercial content disclosure,
 * consent declaration) — and posts with one click.
 *
 * Items: { id, videoPath, caption, hashtags, sourceFootageFilename,
 *          status: "pending"|"posted"|"discarded", createdAt, publishId? }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "..", "data", "review-queue.json");

function load() {
  try {
    if (fs.existsSync(QUEUE_PATH)) return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
  } catch { /* corrupt file — start fresh rather than crash */ }
  return [];
}

function save(items) {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(items, null, 2));
}

export function isReviewMode() {
  return ["1", "true", "yes"].includes(String(process.env.TIKTOK_REVIEW_MODE || "").toLowerCase());
}

export function addToReviewQueue({ videoPath, caption, hashtags = [], sourceFootageFilename = null }) {
  const items = load();
  const item = {
    id: `rq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    videoPath,
    caption,
    hashtags,
    sourceFootageFilename,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  save(items);
  return item;
}

export function getReviewQueue() {
  // Drop entries whose video file has vanished (volume cleanup etc.)
  return load().filter(i => i.status !== "pending" || fs.existsSync(i.videoPath));
}

export function getReviewItem(id) {
  return load().find(i => i.id === id) || null;
}

export function updateReviewItem(id, patch) {
  const items = load();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch };
  save(items);
  return items[idx];
}
