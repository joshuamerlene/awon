/**
 * core/imageBudget.js — monthly cap + spend tracking for AI image generation.
 *
 * This is SEPARATE from the product/ad ledger (core/ledger.js), which tracks
 * real money Josh funded for Printful/ads. This tracks OpenAI gpt-image-1
 * spend against a monthly cap so Awon can neither run up a surprise image bill
 * nor "generate 10,000 images overnight": a hard stop in code, PLUS a status
 * line injected into his planning prompt so he spends the budget deliberately.
 *
 * Volume-backed at data/image-budget.json (survives deploys). Rolls over to a
 * fresh envelope automatically when the calendar month changes.
 *
 * Cap: $10/month by default, override with IMAGE_BUDGET_USD in Railway.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "image-budget.json");

/** Monthly cap in USD (env override, default 10). */
export function monthlyCapUsd() {
  const v = Number(process.env.IMAGE_BUDGET_USD);
  return v > 0 ? v : 10;
}

// Estimated OpenAI gpt-image-1 cost per generated image (USD), by quality+size.
// These track OpenAI's published gpt-image-1 image-output estimates closely
// enough for budgeting; the point is a safe ceiling, not accounting precision.
const COST = {
  low:    { "1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016 },
  medium: { "1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063 },
  high:   { "1024x1024": 0.167, "1024x1536": 0.25,  "1536x1024": 0.25  },
};

export function estimateCost(size = "1024x1024", quality = "high") {
  return (COST[quality] && COST[quality][size]) || COST.high["1024x1024"];
}

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function read() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch { /* corrupt file shouldn't block generation logic */ }
  return { month: monthKey(), spentUsd: 0, count: 0, entries: [] };
}

function write(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
  return d;
}

// Load the current month's envelope, rolling over on month change.
function current() {
  const d = read();
  const m = monthKey();
  if (d.month !== m) return write({ month: m, spentUsd: 0, count: 0, entries: [] });
  return d;
}

const round = (n) => Math.round(Number(n) * 1000) / 1000;

export function status() {
  const d = current();
  const cap = monthlyCapUsd();
  const spent = round(d.spentUsd);
  return {
    month: d.month,
    capUsd: cap,
    spentUsd: spent,
    remainingUsd: round(cap - spent),
    count: d.count,
  };
}

/** True if an image at this size/quality still fits under the remaining cap. */
export function canAfford(size = "1024x1024", quality = "high") {
  return status().remainingUsd >= estimateCost(size, quality);
}

/** Record a generated image's cost. Returns the updated status. */
export function record(costUsd, meta = {}) {
  const d = current();
  d.spentUsd = round(d.spentUsd + Number(costUsd || 0));
  d.count += 1;
  d.entries.push({ at: new Date().toISOString(), costUsd: Number(costUsd || 0), ...meta });
  if (d.entries.length > 500) d.entries.splice(0, d.entries.length - 500);
  write(d);
  return status();
}

/** One-line, model-facing summary so agents choose AI images cost-consciously. */
export function budgetLine() {
  const s = status();
  return (
    `this month (${s.month}) you've spent $${s.spentUsd.toFixed(2)} of your $${s.capUsd.toFixed(2)} ` +
    `AI-image budget — $${s.remainingUsd.toFixed(2)} left, ${s.count} image(s) made. Each high-quality ` +
    `graphic costs about $${estimateCost().toFixed(2)}. It's real money and a hard cap: reach for an AI ` +
    `graphic only when it will genuinely help a product sell, and never burn the budget on low-impact pieces. ` +
    `When it's gone, designs fall back to text/logo until next month.`
  );
}
