/**
 * integrations/design.js — brand text-design generator for POD print files
 *
 * Lets Awon put TEXT on merch instead of only the logo mark: "TRIM" (the
 * brand acronym), "DISCIPLINE FIRST", "THE RIVAL IS ME", etc — rendered in
 * Archivo Black (the same typeface the storefront uses for headings), ALL
 * CAPS, on a transparent background, at print resolution.
 *
 * The generated PNG is written to data/designs/ (persistent Railway Volume)
 * and served publicly by the dashboard at /designs/<file>.png — Printful's
 * mockup generator and order API pull the file from that URL.
 *
 * The font itself is downloaded once from Google Fonts' GitHub repo on first
 * use and cached on the Volume (the repo doesn't bundle binaries). If the
 * font can't be fetched or @napi-rs/canvas can't load, renderTextDesign
 * throws — callers catch and fall back to the logo design, so a failure here
 * can never block product creation.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = path.join(__dirname, "..", "data", "designs");
const FONT_DIR = path.join(__dirname, "..", "data", "fonts");
const FONT_PATH = path.join(FONT_DIR, "ArchivoBlack-Regular.ttf");
const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf";
const FONT_FAMILY = "Archivo Black";

export function designsDir() {
  if (!fs.existsSync(DESIGN_DIR)) fs.mkdirSync(DESIGN_DIR, { recursive: true });
  return DESIGN_DIR;
}

function publicBase() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return "https://awon-production-fc63.up.railway.app";
}

let canvasMod = null;
async function ensureFontAndCanvas() {
  if (!canvasMod) {
    canvasMod = await import("@napi-rs/canvas");
  }
  if (!fs.existsSync(FONT_PATH)) {
    fs.mkdirSync(FONT_DIR, { recursive: true });
    const res = await fetch(FONT_URL);
    if (!res.ok) throw new Error(`Font download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10_000) throw new Error("Font download came back suspiciously small — not saving.");
    fs.writeFileSync(FONT_PATH, buf);
  }
  canvasMod.GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
  return canvasMod;
}

// ── Per-product design registry ───────────────────────────────────────────
// Fulfillment needs to print the SAME design a product was created with —
// without this, every order shipped with the shared/default design (the
// logo) no matter what the listing showed. Keyed by Shopify product id.
const REGISTRY_PATH = path.join(__dirname, "..", "data", "design-registry.json");

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  } catch { /* corrupt registry shouldn't block anything */ }
  return {};
}

export function saveProductDesign(shopifyProductId, url) {
  if (!shopifyProductId || !url) return;
  const reg = loadRegistry();
  reg[String(shopifyProductId)] = url;
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function getProductDesign(shopifyProductId) {
  return loadRegistry()[String(shopifyProductId)] || null;
}

/**
 * Render a text design as a transparent-background, print-resolution PNG.
 *
 * @param {string} text  — the design text. "\n" splits lines. Rendered ALL CAPS.
 * @param {object} opts  — { color: "white" | "black" } (white = for dark garments, default)
 * @returns {{ url, path, filename }}
 */
export async function renderTextDesign(text, { color = "white" } = {}) {
  if (!text || !String(text).trim()) throw new Error("No design text given.");
  const { createCanvas } = await ensureFontAndCanvas();

  const lines = String(text).toUpperCase().split("\n").map(l => l.trim()).filter(Boolean).slice(0, 3);
  const fill = color === "black" ? "#000000" : "#FFFFFF";

  // Print-quality canvas: ~11in wide at 300dpi.
  const W = 3300;
  const MAX_TEXT_W = 3000;

  // Fit: start large, scale down to the widest line.
  let fontSize = 640;
  const measure = createCanvas(10, 10).getContext("2d");
  measure.font = `${fontSize}px "${FONT_FAMILY}"`;
  const widest = Math.max(...lines.map(l => measure.measureText(l).width));
  if (widest > MAX_TEXT_W) fontSize = Math.floor(fontSize * (MAX_TEXT_W / widest));

  const lineHeight = Math.round(fontSize * 1.12);
  const padY = Math.round(fontSize * 0.35);
  const H = padY * 2 + lineHeight * lines.length;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontSize}px "${FONT_FAMILY}"`;
  ctx.fillStyle = fill;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, padY + lineHeight * i + lineHeight / 2);
  });

  const slug = lines.join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 40) || "design";
  const filename = `design_${slug}_${color}_${Date.now()}.png`;
  const outPath = path.join(designsDir(), filename);
  fs.writeFileSync(outPath, canvas.toBuffer("image/png"));

  return { url: `${publicBase()}/designs/${filename}`, path: outPath, filename };
}

// ── AI graphic designs (OpenAI gpt-image-1) ─────────────────────────────────
// Lets Awon generate a real GRAPHIC — an emblem, crest, or illustration — as a
// print file, instead of only text or the logo mark. Transparent background,
// print resolution, written to data/designs/ and served at /designs/<file>.png
// exactly like the text designs, so the whole Printful pipeline is unchanged.
//
// Requires OPENAI_API_KEY in the environment. Without it, generateGraphicDesign
// throws and the caller falls back to a text/logo design — so a missing key (or
// any API failure) can never block product creation. Uses raw fetch (no SDK),
// so no new dependency to install.

const BRAND_ART_DIRECTION =
  "Design a bold, high-contrast graphic to be screen-printed on a premium DARK " +
  "athletic garment for the fitness brand 'The Rival Is Me' — a discipline / " +
  "self-mastery / faith / grit brand whose whole idea is that the rival you fight " +
  "is your own weaker, lazier self. Produce ONE centered emblem or illustration " +
  "with a strong, clean silhouette and vector-like shapes. Use a limited palette " +
  "that reads well on black fabric (mostly whites and greys, at most one restrained " +
  "accent color). No photographic background, no busy gradients that would muddy on " +
  "fabric, no mockup, no garment, no borders, no watermark. Output the artwork ALONE " +
  "on a fully transparent background. Do not add any text unless it is explicitly " +
  "requested in the brief.";

/** True if AI image generation is available (OPENAI_API_KEY present). */
export function hasImageGen() {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Generate a print-ready brand graphic from a short brief via OpenAI gpt-image-1.
 *
 * @param {string} brief — what the graphic should depict (e.g. "a sheathed sword
 *   wrapped in a laurel, minimalist line-emblem style"). Wrapped in the brand
 *   art direction above.
 * @param {object} opts  — { size: "1024x1024"|"1024x1536"|"1536x1024",
 *                           quality: "high"|"medium"|"low" }
 * @returns {{ url, path, filename }} same shape as renderTextDesign.
 */
export async function generateGraphicDesign(brief, { size = "1024x1024", quality = "high" } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set — cannot generate an AI graphic.");
  if (!brief || !String(brief).trim()) throw new Error("No design brief given.");

  const prompt = `${BRAND_ART_DIRECTION}\n\nTHE GRAPHIC TO CREATE: ${String(brief).trim()}`;

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size,
      quality,
      background: "transparent", // requires png output; gpt-image-1 returns b64 png
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI image gen ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image data.");
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 5000) throw new Error("AI image came back suspiciously small — not saving.");

  const slug = String(brief).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "graphic";
  const filename = `ai_${slug}_${Date.now()}.png`;
  const outPath = path.join(designsDir(), filename);
  fs.writeFileSync(outPath, buf);

  return { url: `${publicBase()}/designs/${filename}`, path: outPath, filename };
}

