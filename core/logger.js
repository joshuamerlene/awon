/**
 * core/logger.js — Awon's action log
 *
 * Everything Awon does gets logged here. The dashboard shows this as
 * the activity feed. It's also Awon's audit trail.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "..", "data", "log.json");
const MAX_ENTRIES = 500;

function load() {
  if (!fs.existsSync(LOG_PATH)) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify([], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(LOG_PATH, "utf-8"));
}

/**
 * Log an action.
 * @param {"system"|"action"|"decision"|"error"|"blocker"|"sub-agent"} type
 * @param {string} message
 * @param {object} [meta] — optional extra data
 */
export function log(type, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    ...(Object.keys(meta).length ? { meta } : {}),
  };

  // Always print to console for Railway logs
  console.log(`[${entry.timestamp}] [${type.toUpperCase()}] ${message}`);
  if (Object.keys(meta).length) console.log("  →", JSON.stringify(meta));

  // Persist to file
  const entries = load();
  entries.unshift(entry); // newest first
  if (entries.length > MAX_ENTRIES) entries.splice(MAX_ENTRIES);
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

/** Get recent log entries (for dashboard). */
export function getLog(limit = 100) {
  return load().slice(0, limit);
}
