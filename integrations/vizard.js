/**
 * integrations/vizard.js — Vizard.ai clip-detection API
 *
 * Feed it a long-form source video (a client's stream VOD, podcast, or
 * interview) and it finds the highlight-worthy moments itself, scores them,
 * and renders finished vertical clips with captions baked in. This replaces
 * the manual "which seconds are worth cutting" judgment call that Awon used
 * to make blind against Josh's own pre-cut TikToks — client footage here is
 * long-form, so real highlight detection (not just filename/duration
 * bookkeeping) is the actual job.
 *
 * Docs: verified against Vizard's own official API skill/reference docs
 * (SKILL.md + api-reference.md, provided directly by Josh 2026-07-27) —
 * not just web search. Base URL, auth header, and the videos[] response
 * shape were already correct from the earlier build; videoType handling
 * below was NOT (see detectVideoSource) and would have silently failed on
 * anything that wasn't a YouTube link.
 */

const BASE = "https://elb-api.vizard.ai/hvizard-server-front/open-api/v1";

export function isConfigured() {
  return !!process.env.VIZARD_API_KEY;
}

function headers() {
  return {
    "Content-Type": "application/json",
    VIZARDAI_API_KEY: process.env.VIZARD_API_KEY,
  };
}

// Real Vizard error codes (api-reference.md), surfaced as readable messages
// instead of a bare "code 4007". 4007 in particular is NOT the same thing as
// Awon's own budget being low — it means Vizard's own account (monthly plan
// minutes) is out, a separate account Josh has to manage directly.
const ERROR_MESSAGES = {
  4001: "Invalid Vizard API key.",
  4002: "Clipping failed (or no speech detected, for AI-social-caption calls).",
  4003: "Vizard rate limit exceeded.",
  4004: "Unsupported video format.",
  4005: "Invalid URL, or video too long for this mode.",
  4006: "Illegal parameter in the request.",
  4007: "Vizard account is out of plan minutes/credits — needs a top-up or plan upgrade on vizard.ai directly. This is separate from Awon's own budget ledger.",
  4008: "Vizard failed to download the source video from the given URL — check the link is publicly reachable.",
};

function vizardError(prefix, data) {
  const msg = ERROR_MESSAGES[data.code] || data.errMsg || `unrecognized code ${data.code}`;
  const err = new Error(`${prefix}: ${msg}`);
  err.vizardCode = data.code;
  return err;
}

/**
 * Vizard needs to know the SOURCE PLATFORM (videoType), not just a URL — a
 * Google Drive link submitted as videoType 1 (direct file) or 2 (YouTube)
 * simply fails. Detect from the URL; anything unrecognized falls back to
 * "direct file" (videoType 1), which additionally requires an `ext` field.
 * Vizard does NOT support Dropbox as a source at all (not in their platform
 * list) — a Dropbox link will fall through to the direct-file guess below
 * and likely fail; don't accept Dropbox links from clients for this reason.
 */
function detectVideoSource(url) {
  // Hostname matching, not raw substring on the whole URL — a naive
  // `.includes("x.com")` check matches "dropbox.com" too (it contains the
  // literal substring "x.com"), misrouting it to Twitter/X. Caught by
  // actually testing this against real URLs, not just reading the docs.
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* falls through to direct-file guess below */ }
  const hostIs = (domain) => hostname === domain || hostname.endsWith(`.${domain}`);

  if (hostIs("youtube.com") || hostIs("youtu.be")) return { videoType: 2 };
  if (hostIs("drive.google.com")) return { videoType: 3 };
  if (hostIs("vimeo.com")) return { videoType: 4 };
  if (hostIs("streamyard.com")) return { videoType: 5 };
  if (hostIs("tiktok.com")) return { videoType: 6 };
  if (hostIs("twitter.com") || hostIs("x.com")) return { videoType: 7 };
  if (hostIs("twitch.tv")) return { videoType: 9 };
  if (hostIs("loom.com")) return { videoType: 10 };
  if (hostIs("facebook.com") || hostIs("fb.watch")) return { videoType: 11 };
  if (hostIs("linkedin.com")) return { videoType: 12 };
  const extMatch = url.toLowerCase().match(/\.(mp4|mov|avi|3gp)(\?|$)/);
  return { videoType: 1, ext: extMatch ? extMatch[1] : "mp4" };
}

/**
 * Submit a source video for clipping. videoUrl must be a publicly reachable
 * URL — Vizard fetches it server-side, we never upload the raw file
 * ourselves. preferLength: 0 = auto (let Vizard decide clip length).
 */
export async function submitVideoForClipping({ videoUrl, projectName, lang = "en", preferLength = [0] }) {
  if (!isConfigured()) throw new Error("VIZARD_API_KEY not set.");

  const source = detectVideoSource(videoUrl);

  const res = await fetch(`${BASE}/project/create`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      lang,
      preferLength,
      videoUrl,
      ...source, // videoType, plus ext when it's a direct-file guess
      ...(projectName ? { projectName } : {}),
    }),
  });

  const data = await res.json();
  if (data.code !== 2000 || !data.projectId) {
    throw vizardError("Vizard submit failed", data);
  }
  return { projectId: data.projectId, shareLink: data.shareLink };
}

/**
 * Poll a project. code 1000 = still processing (caller should retry later),
 * 2000 = done. Returns clips sorted by viral score (Vizard's own ordering).
 * Vizard's own guidance: processing can take 10-30 min for long/4K footage —
 * Awon currently only re-checks on its normal cycle cadence (default every
 * 8h), so real turnaround will usually be slower than Vizard's own
 * processing time. Fine for now; a tighter poll loop is a possible
 * fast-follow if delivery speed becomes the bottleneck.
 */
export async function queryProject(projectId) {
  const res = await fetch(`${BASE}/project/query/${projectId}`, {
    method: "GET",
    headers: headers(),
  });

  const data = await res.json();
  if (data.code === 1000) return { ready: false, videos: [] };
  if (data.code !== 2000) throw vizardError("Vizard query failed", data);

  return {
    ready: true,
    projectName: data.projectName,
    shareLink: data.shareLink,
    videos: (data.videos || []).map((v) => ({
      videoId: v.videoId,
      videoUrl: v.videoUrl, // temporary download link, valid ~7 days — download promptly
      durationMs: v.videoMsDuration,
      title: v.title,
      transcript: v.transcript,
      viralScore: Number(v.viralScore || 0),
      viralReason: v.viralReason,
      relatedTopic: v.relatedTopic,
      clipEditorUrl: v.clipEditorUrl,
    })),
  };
}

/** Download a finished clip's rendered video to a local path (fetch + stream to disk). */
export async function downloadClip(videoUrl, destPath) {
  const fs = await import("fs");
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Clip download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}
