/**
 * integrations/video.js — Video editing/remixing on Josh's raw footage
 *
 * Uses ffmpeg (bundled via @ffmpeg-installer/ffmpeg — no system install
 * needed, works on Railway out of the box) through the fluent-ffmpeg wrapper.
 *
 * Raw footage Josh uploads lives in data/raw-footage/ (on the persistent
 * Railway Volume — see core/notes.js header for why that matters). Edited
 * output goes to data/edited-clips/, ready to hand to tiktok.publishVideo().
 *
 * This is intentionally simple, programmatic editing — trim, join, caption
 * overlay, reframe to 9:16. Not a creative AI editor; Awon decides WHAT to
 * cut and WHAT to say (via Claude), this module actually cuts the video.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegPath.path);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, "..", "data", "raw-footage");
const EDITED_DIR = path.join(__dirname, "..", "data", "edited-clips");

function ensureDirs() {
  for (const dir of [RAW_DIR, EDITED_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

export function rawFootageDir() { return RAW_DIR; }
export function editedClipsDir() { return EDITED_DIR; }

/** List all raw footage files Josh has uploaded, newest first. */
export function listRawFootage() {
  ensureDirs();
  return fs.readdirSync(RAW_DIR)
    .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
    .map((f) => {
      const fullPath = path.join(RAW_DIR, f);
      const stat = fs.statSync(fullPath);
      return { filename: f, path: fullPath, sizeBytes: stat.size, uploadedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

/** Probe a video's duration (seconds), resolution, etc. */
export function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find((s) => s.codec_type === "video");
      resolve({
        durationSec: metadata.format.duration,
        width: videoStream?.width,
        height: videoStream?.height,
        sizeBytes: metadata.format.size,
      });
    });
  });
}

/** Trim a clip: start at startSec, keep durationSec. */
export function trimClip(inputPath, outputFilename, { startSec = 0, durationSec }) {
  ensureDirs();
  const outputPath = path.join(EDITED_DIR, outputFilename);
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath).setStartTime(startSec);
    if (durationSec) cmd = cmd.setDuration(durationSec);
    cmd
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .run();
  });
}

/** Concatenate multiple clips into one (must be same codec/resolution for reliable results). */
export function concatClips(inputPaths, outputFilename) {
  ensureDirs();
  const outputPath = path.join(EDITED_DIR, outputFilename);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    inputPaths.forEach((p) => cmd.input(p));
    cmd
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .mergeToFile(outputPath, path.join(EDITED_DIR, "_tmp"));
  });
}

/**
 * Reframe/scale a clip to TikTok's vertical 9:16 (1080x1920), cropping to fill
 * (no letterboxing) since that's what performs on the platform. Also caps
 * bitrate/format to something TikTok's upload API reliably accepts (H.264 mp4).
 */
export function prepareForTikTok(inputPath, outputFilename) {
  ensureDirs();
  const outputPath = path.join(EDITED_DIR, outputFilename);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters([
        "scale=1080:1920:force_original_aspect_ratio=increase",
        "crop=1080:1920",
      ])
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-pix_fmt yuv420p", "-movflags +faststart"])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .run();
  });
}

/**
 * Burn a text caption/hook onto the video (e.g. the first-2-seconds hook text
 * the content agent writes). Centered, bottom-third, white text with black
 * stroke — legible over any footage without needing per-video positioning.
 */
export function addTextOverlay(inputPath, outputFilename, text, { startSec = 0, durationSec } = {}) {
  ensureDirs();
  const outputPath = path.join(EDITED_DIR, outputFilename);
  // Escape ffmpeg drawtext special characters
  const safeText = text.replace(/[\\':]/g, (c) => `\\${c}`);
  const enableExpr = durationSec ? `:enable='between(t,${startSec},${startSec + durationSec})'` : "";

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(
        `drawtext=text='${safeText}':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.72${enableExpr}`
      )
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .run();
  });
}

/** Delete an edited clip once it's been posted (keep the edited-clips dir from growing forever). */
export function cleanupEditedClip(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // non-fatal — leftover files just take up volume space, not worth crashing a cycle over
  }
}
