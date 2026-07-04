/**
 * integrations/tiktok.js — TikTok Shop + Content Posting API
 *
 * Two separate TikTok APIs are at play here:
 *   1. TikTok Shop API  — product catalog, orders, shop management
 *      Docs: https://partner.tiktokshop.com/docv2
 *   2. TikTok Content Posting API — upload and publish videos
 *      Docs: https://developers.tiktok.com/products/content-posting-api/
 *
 * Status: Shell implemented. Needs credentials from TikTok Partner Center.
 * The integration degrades gracefully — Awon skips TikTok actions and logs
 * them as pending until credentials are active.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHOP_TOKEN  = process.env.TIKTOK_SHOP_ACCESS_TOKEN;
const SHOP_ID     = process.env.TIKTOK_SHOP_ID;
const APP_KEY     = process.env.TIKTOK_APP_KEY;
const APP_SECRET  = process.env.TIKTOK_APP_SECRET;
const CONTENT_TOKEN = process.env.TIKTOK_CONTENT_ACCESS_TOKEN; // from Content Posting API OAuth

const SHOP_BASE    = "https://open-api.tiktokglobalshop.com";
const CONTENT_BASE = "https://open.tiktokapis.com/v2";

function shopReady() { return !!(SHOP_TOKEN && SHOP_ID && APP_KEY); }
function contentReady() { return !!CONTENT_TOKEN; }

// ─── TikTok Shop API ──────────────────────────────────────────────────────────

/**
 * Sync a product from Shopify into TikTok Shop catalog.
 * Maps Shopify product fields to TikTok Shop product schema.
 */
export async function syncProductToShop(shopifyProduct) {
  if (!shopReady()) throw new Error("TikTok Shop credentials not set — add TIKTOK_SHOP_ACCESS_TOKEN, TIKTOK_SHOP_ID, TIKTOK_APP_KEY to .env");

  const payload = {
    title: shopifyProduct.title,
    description: shopifyProduct.body_html?.replace(/<[^>]+>/g, "") || shopifyProduct.title,
    skus: (shopifyProduct.variants || []).map((v) => ({
      price: { amount: (Number(v.price) * 100).toString(), currency: "USD" },
      inventory: [{ quantity: 999, warehouse_id: process.env.TIKTOK_WAREHOUSE_ID || "" }],
      seller_sku: v.sku || `SKU-${v.id}`,
    })),
    images: (shopifyProduct.images || []).map((img) => ({ url: img.src })),
  };

  // TODO: sign request with APP_KEY + APP_SECRET (HMAC-SHA256)
  // Docs: https://partner.tiktokshop.com/docv2/page/how-to-sign-requests
  throw new Error("TikTok Shop sync: request signing not yet implemented. Coming next session.");
}

/**
 * Get all videos from the connected TikTok account (@the.rival.is.me).
 * Uses Content Posting API video.list scope.
 */
export async function getAccountVideos() {
  if (!contentReady()) throw new Error("TIKTOK_CONTENT_ACCESS_TOKEN not set.");

  const res = await fetch(`${CONTENT_BASE}/video/list/?fields=id,title,video_description,duration,create_time,statistics`, {
    headers: {
      Authorization: `Bearer ${CONTENT_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify({ max_count: 20 }),
  });

  if (!res.ok) throw new Error(`TikTok video list error ${res.status}`);
  const data = await res.json();
  return data?.data?.videos || [];
}

/**
 * Publish a video to TikTok.
 * Supports two modes:
 *   - videoPath: upload a local file (for agent-created/edited videos)
 *   - videoUrl: pull from URL (for existing CDN-hosted clips)
 */
export async function publishVideo({ videoPath, videoUrl, caption, hashtags = [], productId = null }) {
  if (!contentReady()) throw new Error("TIKTOK_CONTENT_ACCESS_TOKEN not set.");

  const fullCaption = [caption, ...hashtags.map((h) => `#${h.replace(/^#/, "")}`)].join(" ");

  // IMPORTANT — privacy_level:
  // This app's production audit was rejected (see AWON_HANDOFF / memory —
  // TikTok flagged it as "personal or company internal use," which the
  // Content Posting API's public review process doesn't approve for a
  // single-brand self-posting tool). Unaudited API clients are still allowed
  // to post via Direct Post, but ONLY privately (SELF_ONLY) — the account
  // owner then has to manually flip each video to public in the TikTok app.
  // Do NOT change this to PUBLIC_TO_EVERYONE unless the app has actually
  // passed TikTok's audit — it will be rejected/fail otherwise.
  // Override only if TIKTOK_AUDITED=true is explicitly set once that changes.
  const privacyLevel = process.env.TIKTOK_AUDITED === "true" ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";

  // Step 1: Initialize the upload
  const initRes = await fetch(`${CONTENT_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONTENT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      post_info: {
        title: fullCaption,
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: videoUrl
        ? { source: "PULL_FROM_URL", video_url: videoUrl }
        : { source: "FILE_UPLOAD", video_size: fs.statSync(videoPath).size, chunk_size: 10000000, total_chunk_count: 1 },
    }),
  });

  if (!initRes.ok) throw new Error(`TikTok publish init error ${initRes.status}: ${await initRes.text()}`);
  const initData = await initRes.json();
  const publishId = initData?.data?.publish_id;
  const uploadUrl = initData?.data?.upload_url;

  // Step 2: Upload file if needed
  if (videoPath && uploadUrl) {
    const videoBuffer = fs.readFileSync(videoPath);
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
        "Content-Length": videoBuffer.length.toString(),
      },
      body: videoBuffer,
    });
    if (!uploadRes.ok) throw new Error(`TikTok video upload error ${uploadRes.status}`);
  }

  return { publishId, privacyLevel };
}

/**
 * Tag a product onto an existing or newly published TikTok video.
 */
export async function tagProductOnVideo(videoId, productId) {
  if (!shopReady()) throw new Error("TikTok Shop credentials not set.");
  // TikTok Shop affiliate product tagging
  // Docs: https://partner.tiktokshop.com/docv2/page/affiliate-video-product
  throw new Error("Product tagging: needs Shop API request signing. Coming next session.");
}

/**
 * Get performance data for a video.
 */
export async function getVideoPerformance(videoId) {
  if (!contentReady()) throw new Error("TIKTOK_CONTENT_ACCESS_TOKEN not set.");
  const res = await fetch(`${CONTENT_BASE}/video/query/?fields=id,statistics`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONTENT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filters: { video_ids: [videoId] } }),
  });
  if (!res.ok) throw new Error(`TikTok video query error ${res.status}`);
  const data = await res.json();
  return data?.data?.videos?.[0] || null;
}

/**
 * Boost a video with paid promotion.
 * NOTE: Verify TikTok's current minimum daily spend before relying on this.
 * Historical minimum has been $20+/day — may exceed current budget entirely.
 */
export async function boostVideo(videoId, amountUsd) {
  throw new Error("TikTok boost: TikTok for Business Ads API not yet wired. Verify minimum spend requirements first (historically $20+/day).");
}

/**
 * Get trending fitness-relevant hashtags and sounds.
 */
export async function getTrendingFitnessContent() {
  // TikTok Creative Center trend data
  // Alternative: scrape trends via web search in the analytics agent
  throw new Error("Trending data: TikTok Creative Center API needs separate credentials.");
}

/**
 * Get TikTok Shop orders (for fulfillment tracking).
 */
export async function getShopOrders() {
  if (!shopReady()) throw new Error("TikTok Shop credentials not set.");
  throw new Error("TikTok Shop orders: request signing not yet implemented.");
}
