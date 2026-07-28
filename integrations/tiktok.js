/**
 * integrations/tiktok.js — TikTok Content Posting API
 *
 * This business (Awon Video, a direct-service clip production shop) never
 * posts to its own TikTok account as the distribution model — clients post
 * finished clips through their own audited accounts. What's left here is
 * strictly the optional portfolio/demo-reel channel: Awon Video's own TikTok,
 * used to show prospective clients editing quality, not to run the business.
 *
 * Docs: https://developers.tiktok.com/products/content-posting-api/
 *
 * Deep scrub, 2026-07-28: this file used to also carry a TikTok Shop
 * integration (product catalog sync from Shopify, order fulfillment, trending
 * fitness hashtags) built for the retired Rival Is Me apparel store. None of
 * those functions had a single caller left anywhere in the repo — Shopify
 * itself is gone (shopify.js/product.js/printful.js don't exist) — so they
 * were dead code, not dormant functionality. Removed rather than rebranded.
 *
 * Token lifecycle: the Content Posting API access token from OAuth expires
 * in ~24h. Rather than needing Josh to redo the OAuth consent flow daily,
 * this module persists the live access/refresh token pair in
 * data/tiktok_token.json (on the Volume, survives deploys) and silently
 * refreshes it before it expires. TIKTOK_CONTENT_ACCESS_TOKEN /
 * TIKTOK_CONTENT_REFRESH_TOKEN env vars only ever seed it the first time.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, "..", "data", "tiktok_token.json");

const APP_KEY     = process.env.TIKTOK_APP_KEY;
const APP_SECRET  = process.env.TIKTOK_APP_SECRET;

const CONTENT_BASE = "https://open.tiktokapis.com/v2";

// ─── Token persistence + auto-refresh ────────────────────────────────────────

function loadTokenState() {
  if (fs.existsSync(TOKEN_PATH)) {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  }
  // First run — seed from env vars (set once via the /auth/tiktok OAuth flow).
  const envAccess = process.env.TIKTOK_CONTENT_ACCESS_TOKEN;
  const envRefresh = process.env.TIKTOK_CONTENT_REFRESH_TOKEN;
  if (!envAccess) return null;
  const state = {
    accessToken: envAccess,
    refreshToken: envRefresh || null,
    // Conservative: treat env-seeded tokens as issued now, expiring in 23h
    // (TikTok's actual window is 24h — this just forces an early refresh).
    expiresAt: Date.now() + 23 * 3600 * 1000,
  };
  saveTokenState(state);
  return state;
}

function saveTokenState(state) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(state, null, 2));
}

/**
 * Refresh the access token using the stored refresh token.
 * TikTok issues a NEW refresh token on every refresh — must be saved too.
 */
async function refreshAccessToken(state) {
  if (!state.refreshToken) throw new Error("No TikTok refresh token available — reconnect via /auth/tiktok.");
  if (!APP_KEY || !APP_SECRET) throw new Error("TIKTOK_APP_KEY/TIKTOK_APP_SECRET not set — needed to refresh.");

  const res = await fetch(`${CONTENT_BASE}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: APP_KEY,
      client_secret: APP_SECRET,
      grant_type: "refresh_token",
      refresh_token: state.refreshToken,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`TikTok token refresh failed: ${JSON.stringify(data)}`);

  const newState = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || state.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in || 86400) - 3600) * 1000, // refresh 1h early
  };
  saveTokenState(newState);
  return newState;
}

/**
 * Get a valid access token, refreshing first if it's expired or close to it.
 * Every API call below should go through this instead of reading a static token.
 */
async function getAccessToken() {
  let state = loadTokenState();
  if (!state) return null;
  if (Date.now() >= state.expiresAt) {
    state = await refreshAccessToken(state);
  }
  return state.accessToken;
}

function contentReady() {
  return !!(process.env.TIKTOK_CONTENT_ACCESS_TOKEN || fs.existsSync(TOKEN_PATH));
}

/**
 * Store tokens from a fresh OAuth grant (called by the /auth/tiktok/callback
 * route). Persists to the volume-backed token file that getAccessToken()
 * reads and auto-refreshes — no manual env-var step, no tokens on screen.
 */
export function storeOAuthTokens({ accessToken, refreshToken, expiresIn }) {
  saveTokenState({
    accessToken,
    refreshToken: refreshToken || null,
    expiresAt: Date.now() + (Number(expiresIn || 86400) - 3600) * 1000, // refresh 1h early
  });
}

/**
 * TikTok's upload init is strict about chunking ("The chunk size is invalid",
 * seen live 2026-07-16 with a hardcoded chunk_size of 10MB on ~2MB clips):
 * for a single-chunk upload, chunk_size must EQUAL video_size. Single chunk
 * is allowed up to 64MB, which covers every clip this pipeline produces
 * (edited posts are 6-30s, a few MB). Anything bigger is refused loudly
 * rather than guessing at multi-chunk math we can't test.
 */
function buildFileUploadSourceInfo(videoPath) {
  const size = fs.statSync(videoPath).size;
  const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
  if (size > MAX_SINGLE_CHUNK) {
    throw new Error(`Video is ${(size / 1048576).toFixed(1)}MB — over TikTok's 64MB single-chunk limit. Produce shorter clips.`);
  }
  return { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 };
}

/**
 * Query creator info — required by TikTok's Direct Post UX guidelines before
 * rendering any post/review page. Returns nickname, allowed privacy options,
 * which interactions are disabled, and the max video duration.
 */
export async function getCreatorInfo() {
  const token = await getAccessToken();
  if (!token) throw new Error("TikTok not connected — visit /auth/tiktok to connect.");
  const res = await fetch(`${CONTENT_BASE}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`TikTok creator_info error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const d = json?.data || {};
  return {
    nickname: d.creator_nickname,
    username: d.creator_username,
    avatarUrl: d.creator_avatar_url,
    privacyLevelOptions: d.privacy_level_options || [],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxVideoPostDurationSec: d.max_video_post_duration_sec || null,
  };
}

/**
 * Check a post's processing status (publish/status/fetch) — guidelines want
 * users to be able to see whether their post has finished processing.
 */
export async function getPublishStatus(publishId) {
  const token = await getAccessToken();
  if (!token) throw new Error("TikTok not connected.");
  const res = await fetch(`${CONTENT_BASE}/post/publish/status/fetch/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ publish_id: publishId }),
  });
  if (!res.ok) throw new Error(`TikTok status fetch error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.data || {};
}

/**
 * Publish a video to TikTok.
 * Supports two modes:
 *   - videoPath: upload a local file (for agent-created/edited videos)
 *   - videoUrl: pull from URL (for existing CDN-hosted clips)
 */
export async function publishVideo({
  videoPath, videoUrl, caption, hashtags = [], productId = null,
  // Review-mode metadata (TikTok-compliant UX passes these explicitly).
  // When omitted, autonomous-mode defaults apply.
  privacyLevel = null,
  allowComment = true, allowDuet = true, allowStitch = true,
  brandOrganic = false, brandedContent = false,
}) {
  const token = await getAccessToken();
  if (!token) throw new Error("TikTok not connected — visit /auth/tiktok to connect.");

  const fullCaption = [caption, ...hashtags.map((h) => `#${h.replace(/^#/, "")}`)].join(" ");

  // IMPORTANT — privacy_level:
  // This app's production audit was rejected — TikTok flagged it as
  // "personal or company internal use," which the Content Posting API's
  // public review process doesn't approve for a single-brand self-posting
  // tool. Unaudited API clients (this Sandbox app) are still allowed to post
  // via Direct Post, but ONLY privately (SELF_ONLY) — the account owner then
  // has to manually flip each video to public in the TikTok app.
  // Do NOT change this to PUBLIC_TO_EVERYONE unless the app has actually
  // passed TikTok's audit — it will be rejected/fail otherwise.
  // Override only if TIKTOK_AUDITED=true is explicitly set once that changes.
  const effectivePrivacy = privacyLevel
    || (process.env.TIKTOK_AUDITED === "true" ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY");

  // Step 1: Initialize the upload
  const initRes = await fetch(`${CONTENT_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      post_info: {
        title: fullCaption,
        privacy_level: effectivePrivacy,
        disable_duet: !allowDuet,
        disable_comment: !allowComment,
        disable_stitch: !allowStitch,
        video_cover_timestamp_ms: 1000,
        ...(brandOrganic ? { brand_organic_toggle: true } : {}),
        ...(brandedContent ? { brand_content_toggle: true } : {}),
      },
      source_info: videoUrl
        ? { source: "PULL_FROM_URL", video_url: videoUrl }
        : buildFileUploadSourceInfo(videoPath),
    }),
  });

  if (!initRes.ok) {
    const body = await initRes.text();
    // Sandbox reality (hit live 2026-07-16): an unaudited client may only post
    // to accounts whose PROFILE is set to private — this is separate from the
    // per-post SELF_ONLY privacy level. Surface the actual fix instead of a
    // generic API error.
    if (body.includes("unaudited_client_can_only_post_to_private_accounts")) {
      throw new Error(
        "TikTok sandbox rule: the connected TikTok account must be a PRIVATE account for this unaudited app to post. " +
        "Fix in the TikTok app: Profile → Settings & privacy → Privacy → turn ON 'Private account'. " +
        "Posts still land SELF_ONLY; after posting you can flip the account back to public and set each video's visibility manually."
      );
    }
    throw new Error(`TikTok publish init error ${initRes.status}: ${body}`);
  }
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

  return { publishId, privacyLevel: effectivePrivacy };
}

export { contentReady };
