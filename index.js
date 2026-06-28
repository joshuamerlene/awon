/**
 * index.js — Awon entry point
 *
 * Starts two things in one process:
 *   1. The dashboard web server (Express) — Josh's check-in interface
 *   2. Awon's decision loop (node-cron) — runs on schedule, around the clock
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
// Load config/.env locally (Railway injects env vars directly — no file needed)
config({ path: resolve(__dirname, "config/.env") });
import cron from "node-cron";
import { startDashboard } from "./dashboard/server.js";
import { runCycle } from "./core/awon.js";
import { log } from "./core/logger.js";

const LOOP_HOURS = Number(process.env.LOOP_INTERVAL_HOURS || 8);

// --- Start dashboard ---
startDashboard();

// --- Run first cycle immediately on boot ---
log("system", "Awon is online. Running first cycle now.");
runCycle().catch((err) => log("error", `Boot cycle failed: ${err.message}`));

// --- Schedule recurring cycles ---
const cronExpr = `0 */${LOOP_HOURS} * * *`;
cron.schedule(cronExpr, () => {
  log("system", `Scheduled cycle triggered (every ${LOOP_HOURS}h).`);
  runCycle().catch((err) => log("error", `Cycle failed: ${err.message}`));
});

log("system", `Awon scheduled to run every ${LOOP_HOURS} hours. Dashboard live.`);
