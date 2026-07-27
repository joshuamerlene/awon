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
 * Docs: https://docs.vizard.ai/docs/quickstart
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

/**
 * Submit a source video for clipping. videoUrl must be a publicly reachable
 * URL (YouTube link, or a signed URL to client-uploaded footage) — Vizard
 * fetches it server-side, we never upload the raw file ourselves.
 *
 * preferLength: 0 = auto (let Vizard decide clip length), matches most
 * short-form use cases best. See docs/advanced for other values if a client
 * wants a specific target length.
 */
export async function submitVideoForClipping({ videoUrl, projectName, lang = "en", preferLength = [0] }) {
  if (!isConfigured()) throw new Error("VIZARD_API_KEY not set.");

  const res = await fetch(`${BASE}/project/create`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      lang,
      preferLength,
      videoUrl,
      videoType: 2, // remote URL (not a Vizard-hosted upload)
      ...(projectName ? { projectName } : {}),
    }),
  });

  const data = await res.json();
  if (data.code !== 2000 || !data.projectId) {
    throw new Error(`Vizard submit failed: ${data.errMsg || `code ${data.code}`}`);
  }
  return { projectId: data.projectId, shareLink: data.shareLink };
}

/**
 * Poll a project. code 1000 = still processing (caller should retry later),
 * 2000 = done. Returns clips sorted by viral score (Vizard's own ordering).
 */
export async function queryProject(projectId) {
  const res = await fetch(`${BASE}/project/query/${projectId}`, {
    method: "GET",
    headers: headers(),
  });

  const data = await res.json();
  if (data.code === 1000) return { ready: false, videos: [] };
  if (data.code !== 2000) throw new Error(`Vizard query failed: ${data.errMsg || `code ${data.code}`}`);

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
