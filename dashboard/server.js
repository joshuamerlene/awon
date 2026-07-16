/**
 * dashboard/server.js — Awon's web dashboard
 *
 * Serves the dashboard UI and a simple REST API for:
 *   GET  /api/status    — Awon's current state + budget summary
 *   GET  /api/blockers  — all blockers (pending + resolved)
 *   POST /api/blockers/:id/resolve — Josh resolves a blocker
 *   GET  /api/notes     — all notes Josh has left (proactive, not tied to a blocker)
 *   POST /api/notes     — Josh leaves Awon a free-text note for the next cycle
 *   POST /api/budget/add-funds     — Josh tops up Awon's available budget
 *   POST /api/budget/clear-payout  — Josh marks his owed payout as taken
 *   GET  /api/log       — recent action log
 *   GET  /api/memory    — Awon's sandbox/memory
 *   GET  /auth/tiktok            — kicks off TikTok OAuth (Login Kit v2)
 *   GET  /auth/tiktok/callback   — exchanges code for TIKTOK_CONTENT_ACCESS_TOKEN
 *   GET  /api/footage            — list raw footage Josh has uploaded
 *   POST /api/footage/upload     — Josh uploads raw video files for Awon to edit
 */

import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import multer from "multer";
import unzipper from "unzipper";
import { getAllBlockers, resolveBlocker, getPendingBlockers } from "../core/queue.js";
import { addNote, getAllNotes } from "../core/notes.js";
import { getLog } from "../core/logger.js";
import { loadMemory } from "../core/memory.js";
import { Ledger } from "../core/ledger.js";
import { getContentQueue } from "../agents/content.js";
import * as shopify from "../integrations/shopify.js";
import * as video from "../integrations/video.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "therivalisme";
const PORT = process.env.PORT || 3000;

export function startDashboard() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Simple auth middleware
  function auth(req, res, next) {
    const token = req.headers["x-dashboard-token"] || req.query.token;
    if (token === DASHBOARD_PASSWORD) return next();
    // Allow unauthenticated access to the HTML shell (auth happens client-side)
    if (req.path === "/" || req.path.endsWith(".html") || !req.path.startsWith("/api")) return next();
    res.status(401).json({ error: "Unauthorized. Pass ?token=<DASHBOARD_PASSWORD> or X-Dashboard-Token header." });
  }

  app.use(auth);

  // ── Status ────────────────────────────────────────────────────────────────
  app.get("/api/status", (req, res) => {
    try {
      const ledger = new Ledger();
      const memory = loadMemory();
      const pending = getPendingBlockers();
      res.json({
        online: true,
        lastCycle: memory.updatedAt,
        cycleCount: memory.cycleCount,
        strategy: memory.strategy,
        nextActions: memory.nextActions,
        budget: ledger.getSummary(),
        pendingBlockers: pending.length,
        tiktokConnected: !!process.env.TIKTOK_CONTENT_ACCESS_TOKEN,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Blockers ──────────────────────────────────────────────────────────────
  app.get("/api/blockers", (req, res) => {
    try {
      res.json(getAllBlockers());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/blockers/:id/resolve", (req, res) => {
    try {
      const { resolution } = req.body;
      if (!resolution) return res.status(400).json({ error: "resolution is required" });
      const blocker = resolveBlocker(req.params.id, resolution);
      res.json({ success: true, blocker });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Notes ─────────────────────────────────────────────────────────────────
  // Free-text notes Josh leaves proactively (not tied to a blocker Awon raised).
  // Awon reads unconsumed notes at the start of his next cycle.
  app.get("/api/notes", (req, res) => {
    try {
      res.json(getAllNotes());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notes", (req, res) => {
    try {
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ error: "text is required" });
      const id = addNote(text);
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Budget ────────────────────────────────────────────────────────────────
  app.post("/api/budget/add-funds", (req, res) => {
    try {
      const amount = Number(req.body?.amount);
      if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be a positive number" });
      const ledger = new Ledger();
      const summary = ledger.addFunds(amount, req.body?.note || "");
      res.json({ success: true, budget: summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/budget/clear-payout", (req, res) => {
    try {
      const ledger = new Ledger();
      const summary = ledger.clearPayout(req.body?.note || "");
      res.json({ success: true, budget: summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Log ───────────────────────────────────────────────────────────────────
  app.get("/api/log", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 100), 500);
      res.json(getLog(limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Memory / Sandbox ──────────────────────────────────────────────────────
  app.get("/api/memory", (req, res) => {
    try {
      res.json(loadMemory());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Raw footage upload (for Awon to edit/remix into TikTok content) ────────
  const footageUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, video.rawFootageDir()),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
    fileFilter: (req, file, cb) => {
      if (/\.(mp4|mov|m4v)$/i.test(file.originalname)) cb(null, true);
      else cb(new Error("Only .mp4, .mov, .m4v files are accepted."));
    },
  });

  app.get("/api/footage", (req, res) => {
    try {
      res.json(video.listRawFootage());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/footage/upload", footageUpload.array("files", 50), (req, res) => {
    try {
      res.json({ success: true, uploaded: (req.files || []).map((f) => f.filename) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Bulk footage import (zip) ──────────────────────────────────────────────
  // Accepts a .zip archive (e.g. a TikTok data export) and extracts every
  // video file inside into raw-footage. Entries are streamed one at a time,
  // so multi-GB archives don't blow up memory.
  const zipUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, os.tmpdir()),
      filename: (req, file, cb) => cb(null, `footage_import_${Date.now()}.zip`),
    }),
    limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB archive cap
    fileFilter: (req, file, cb) => {
      if (/\.zip$/i.test(file.originalname)) cb(null, true);
      else cb(new Error("Only .zip archives are accepted on this endpoint."));
    },
  });

  app.post("/api/footage/upload-zip", zipUpload.single("archive"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No zip uploaded (field name: archive)." });
    const extracted = [];
    let skipped = 0;
    try {
      const directory = await unzipper.Open.file(req.file.path);
      let i = 0;
      for (const entry of directory.files) {
        if (entry.type !== "File") continue;
        const base = path.basename(entry.path);
        if (!/\.(mp4|mov|m4v)$/i.test(base)) { skipped++; continue; }
        const safe = `${Date.now()}_${i++}-${base.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const dest = path.join(video.rawFootageDir(), safe);
        await new Promise((resolve, reject) =>
          entry.stream().pipe(fs.createWriteStream(dest)).on("finish", resolve).on("error", reject)
        );
        extracted.push(safe);
      }
      res.json({ success: true, extracted: extracted.length, skippedNonVideo: skipped, files: extracted });
    } catch (err) {
      res.status(500).json({ error: `Zip import failed: ${err.message}` });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  });

  // ── Content Queue ─────────────────────────────────────────────────────────
  app.get("/api/content-queue", (req, res) => {
    try {
      const queue = getContentQueue();
      const status = req.query.status; // filter by ?status=pending|posted
      const items = status ? queue.filter(i => i.status === status) : queue;
      res.json({ total: items.length, items: items.reverse() }); // newest first
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Archive All Products ──────────────────────────────────────────────────
  // One-time nuclear option: archive all active products so Awon rebuilds from scratch.
  app.post("/api/archive-all-products", async (req, res) => {
    try {
      const archived = await shopify.archiveAllProducts();
      res.json({ success: true, count: archived.length, products: archived });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── TikTok OAuth (Login Kit v2 / Content Posting API) ───────────────────────
  // Kicks off the real OAuth consent flow to get TIKTOK_CONTENT_ACCESS_TOKEN for
  // @the.rival.is.me. Required even for unaudited posting — audit status only
  // controls whether posts land public or SELF_ONLY, not whether OAuth works.
  app.get("/auth/tiktok", (req, res) => {
    const clientKey = process.env.TIKTOK_APP_KEY;
    if (!clientKey) return res.status(500).send("TIKTOK_APP_KEY not set in Railway env vars.");

    const redirectUri = `https://${req.get("host")}/auth/tiktok/callback`;
    const scopes = ["user.info.basic", "user.info.profile", "user.info.stats", "video.list", "video.publish", "video.upload"].join(",");
    const state = Math.random().toString(36).slice(2);

    const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(clientKey)}&scope=${encodeURIComponent(scopes)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    res.redirect(authUrl);
  });

  app.get("/auth/tiktok/callback", async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) return res.status(400).send(`<h1>TikTok OAuth Error</h1><p>${error}: ${error_description || ""}</p>`);
    if (!code) return res.status(400).send("Missing code parameter.");

    try {
      const clientKey = process.env.TIKTOK_APP_KEY;
      const clientSecret = process.env.TIKTOK_APP_SECRET;
      if (!clientKey || !clientSecret) {
        return res.send(`<h1>OAuth Code Received</h1><p><b>Code:</b> <code>${code}</code></p><p>Set TIKTOK_APP_KEY + TIKTOK_APP_SECRET in Railway env vars, then hit /auth/tiktok again.</p>`);
      }

      const redirectUri = `https://${req.get("host")}/auth/tiktok/callback`;
      const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
        body: new URLSearchParams({
          client_key: clientKey,
          client_secret: clientSecret,
          code: String(code),
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });

      const tokenData = await tokenRes.json();

      if (tokenData.access_token) {
        res.send(
          `<h1>✅ TikTok Connected!</h1>` +
          `<p><b>Access Token:</b> <code style="word-break:break-all">${tokenData.access_token}</code></p>` +
          `<p><b>Refresh Token:</b> <code style="word-break:break-all">${tokenData.refresh_token}</code></p>` +
          `<p><b>Expires in:</b> ${tokenData.expires_in}s &nbsp; <b>Scope:</b> ${tokenData.scope}</p>` +
          `<p>Add <code>TIKTOK_CONTENT_ACCESS_TOKEN=${tokenData.access_token}</code> (and ideally <code>TIKTOK_CONTENT_REFRESH_TOKEN=${tokenData.refresh_token}</code>) to Railway environment variables.</p>` +
          `<p style="color:#b45309">Note: this app is unaudited, so videos Awon posts will land as private (Only You) until you manually flip each one to public in the TikTok app. Check the dashboard's "Needs Your Input" section after each post.</p>`
        );
      } else {
        res.send(`<h1>Token Exchange Error</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      }
    } catch (err) {
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  // ── Shopify OAuth Callback ─────────────────────────────────────────────────
  // Called by Shopify after store owner approves app install.
  // Exchanges the one-time code for a permanent Admin API access token.
  app.get("/auth/callback", async (req, res) => {
    const { code, shop } = req.query;
    if (!code || !shop) return res.status(400).send("Missing code or shop parameters.");

    try {
      const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
      const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        // Fallback: display the code so it can be exchanged manually
        return res.send(
          `<h1>OAuth Code Received</h1><p><b>Shop:</b> ${shop}</p><p><b>Code:</b> <code>${code}</code></p>` +
          `<p>Set SHOPIFY_APP_CLIENT_ID + SHOPIFY_APP_CLIENT_SECRET in Railway env vars, then reinstall.</p>`
        );
      }

      const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });

      const tokenData = await tokenRes.json();

      if (tokenData.access_token) {
        res.send(
          `<h1>✅ Shopify Connected!</h1>` +
          `<p><b>Access Token:</b> <code style="word-break:break-all">${tokenData.access_token}</code></p>` +
          `<p><b>Scope:</b> ${tokenData.scope}</p>` +
          `<p>Add <code>SHOPIFY_ADMIN_API_ACCESS_TOKEN=${tokenData.access_token}</code> and ` +
          `<code>SHOPIFY_STORE_DOMAIN=${shop}</code> to Railway environment variables.</p>`
        );
      } else {
        res.send(`<h1>Token Exchange Error</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
      }
    } catch (err) {
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  });

  app.listen(PORT, () => {
    console.log(`[Dashboard] Awon dashboard running on port ${PORT}`);
  });
}
