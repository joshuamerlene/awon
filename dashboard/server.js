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
 *   GET  /api/public/status      — unauthenticated: free-trial slot status for awonvideo.com
 *   POST /api/public/intake      — unauthenticated: the site's "Send Your Video" form lands here
 */

import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import multer from "multer";
import unzipper from "unzipper";
import { getAllBlockers, resolveBlocker, getPendingBlockers, addBlockerOnce } from "../core/queue.js";
import { addNote, getAllNotes } from "../core/notes.js";
import { handleChat } from "../core/chat.js";
import { getChat, activeMemory, forget as forgetMemory } from "../core/chatMemory.js";
import { getLog, log } from "../core/logger.js";
import { loadMemory } from "../core/memory.js";
import { Ledger } from "../core/ledger.js";
import * as clients from "../core/clients.js";
import * as freeTrial from "../core/freeTrial.js";
import { getClipQueue, markClipDelivered, rejectClip } from "../agents/clipAgent.js";
import * as video from "../integrations/video.js";
import * as tiktok from "../integrations/tiktok.js";
import { getReviewQueue, getReviewItem, updateReviewItem, isReviewMode } from "../core/reviewQueue.js";

// Origins allowed to call the unauthenticated /api/public/* routes from a
// browser. The Netlify preview URL stays here as a fallback even after the
// custom domain is wired, since it costs nothing to leave it and saves a
// redeploy if the domain ever needs to be re-pointed.
const PUBLIC_SITE_ORIGINS = [
  "https://awonvideo.com",
  "https://www.awonvideo.com",
  "https://cozy-babka-5c01ef.netlify.app",
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "therivalisme";
const PORT = process.env.PORT || 3000;

export function startDashboard() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));
  // Generated print designs (integrations/design.js) — must be publicly
  // fetchable (no token) so Printful's mockup generator and order API can
  // pull the files. Served from the persistent Volume.
  app.use("/designs", express.static(path.join(__dirname, "..", "data", "designs")));

  // CORS for the public marketing site (awonvideo.com) hitting /api/public/*
  // from a browser. Scoped to an explicit origin allowlist, not wide open —
  // this is the only part of the API a stranger's browser ever touches.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/public")) return next();
    const origin = req.headers.origin;
    if (PUBLIC_SITE_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Simple auth middleware
  function auth(req, res, next) {
    const token = req.headers["x-dashboard-token"] || req.query.token;
    if (token === DASHBOARD_PASSWORD) return next();
    // Allow unauthenticated access to the HTML shell (auth happens client-side)
    if (req.path === "/" || req.path.endsWith(".html") || !req.path.startsWith("/api")) return next();
    // The public site's own routes are meant to be hit with no token at all —
    // that's the whole point of them (see PUBLIC_SITE_ORIGINS / CORS above).
    if (req.path.startsWith("/api/public")) return next();
    res.status(401).json({ error: "Unauthorized. Pass ?token=<DASHBOARD_PASSWORD> or X-Dashboard-Token header." });
  }

  app.use(auth);

  // ── Public site intake (awonvideo.com "Send Your Video" form) ─────────────
  // Unauthenticated on purpose — see CORS block above. Kept minimal: this
  // never returns internal state (budget, strategy, memory), only the one
  // thing the site needs to decide which copy to show.
  app.get("/api/public/status", (req, res) => {
    try {
      res.json({ freeTrial: freeTrial.getFreeTrialStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/public/intake", (req, res) => {
    try {
      const { name, email, company, footageLink, message, consent } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "a valid email is required" });
      if (footageLink && !consent) {
        return res.status(400).json({ error: "consent is required when submitting a footage link" });
      }

      const trialStatusBefore = freeTrial.getFreeTrialStatus();
      const usingFreeTrial = trialStatusBefore.open;

      const notesParts = [`Submitted via awonvideo.com public intake form.`];
      if (company) notesParts.push(`Channel/company: ${company}`);
      if (message) notesParts.push(`Message: ${message}`);

      const client = clients.addClient({
        name,
        contactEmail: email,
        sourceChannel: usingFreeTrial ? freeTrial.FREE_TRIAL_SOURCE : "website",
        notes: notesParts.join(" "),
      });

      let rightsAutoAuthorized = false;
      if (footageLink && consent) {
        clients.addFootageSubmission(client.id, { url: footageLink });
        clients.updateClient(client.id, {
          rightsAuthorized: true,
          notes: `${client.notes} Rights auto-authorized: footage submitted directly via the public site's intake form with the consent box checked.`,
        });
        rightsAutoAuthorized = true;
        log("action", `New client "${name}" (${email}) submitted footage directly via the site — rights auto-authorized, queued for Vizard.`);
      } else {
        log("action", `New prospect "${name}" (${email}) reached out via the site with no footage yet.`);
      }

      if (usingFreeTrial) freeTrial.checkAndFlagIfJustFilled();

      res.json({
        success: true,
        hadFootage: !!footageLink,
        rightsAutoAuthorized,
        freeTrial: usingFreeTrial,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Status ────────────────────────────────────────────────────────────────
  app.get("/api/status", (req, res) => {
    try {
      const ledger = new Ledger();
      const memory = loadMemory();
      const pending = getPendingBlockers();
      res.json({
        online: true,
        businessName: process.env.BUSINESS_NAME || "Awon",
        lastCycle: memory.updatedAt,
        cycleCount: memory.cycleCount,
        strategy: memory.strategy,
        nextActions: memory.nextActions,
        budget: ledger.getSummary(),
        pendingBlockers: pending.length,
        clientCount: clients.getAllClients().length,
        activeClientCount: clients.getActiveClients().length,
        freeTrial: freeTrial.getFreeTrialStatus(),
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

  // ── Chat (live, two-way — ported from Ally) ───────────────────────────────
  // Instant conversation with Awon. Durable facts/directives he extracts are
  // saved to living memory (chat-memory.json) and injected into every system
  // prompt from then on — including the next full cycle.
  app.get("/api/chat", (req, res) => {
    try {
      res.json(getChat(100));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || !String(message).trim()) return res.status(400).json({ error: "message is required" });
      const result = await handleChat(message);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chat-memory", (req, res) => {
    try {
      res.json(activeMemory());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/chat-memory/forget", (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: "id is required" });
      forgetMemory(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clients / pipeline ───────────────────────────────────────────────────
  app.get("/api/clients", (req, res) => {
    try {
      res.json(clients.getAllClients());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add a prospect/client. Prospect discovery isn't automated (no search API
  // wired in) — this is how Josh feeds candidates in until that exists.
  app.post("/api/clients", (req, res) => {
    try {
      const { name, contactEmail, sourceChannel, dealType, rateUsd, notes, status } = req.body || {};
      if (!name) return res.status(400).json({ error: "name is required" });
      const client = clients.addClient({ name, contactEmail, sourceChannel, dealType, rateUsd, notes, status });
      res.json({ success: true, client });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clients/:id", (req, res) => {
    try {
      const client = clients.updateClient(req.params.id, req.body || {});
      res.json({ success: true, client });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Explicit rights authorization — required before any of this client's
  // footage gets submitted for clipping. Confirming this is Josh's call.
  app.post("/api/clients/:id/authorize-rights", (req, res) => {
    try {
      const client = clients.updateClient(req.params.id, { rightsAuthorized: true });
      res.json({ success: true, client });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/clients/:id/footage", (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url) return res.status(400).json({ error: "url is required" });
      const submission = clients.addFootageSubmission(req.params.id, { url });
      res.json({ success: true, submission });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clip delivery queue ──────────────────────────────────────────────────
  app.get("/api/clips", (req, res) => {
    try {
      const queue = getClipQueue();
      const status = req.query.status;
      const items = status ? queue.filter((i) => i.status === status) : queue;
      res.json({ total: items.length, items: items.reverse() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/clips/:id/video", (req, res) => {
    const item = getClipQueue().find((i) => i.id === req.params.id);
    if (!item || !fs.existsSync(item.videoPath)) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.resolve(item.videoPath));
  });

  app.post("/api/clips/:id/mark-delivered", (req, res) => {
    try {
      markClipDelivered(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rejecting with a reason feeds the clip agent's next curation pass —
  // a real feedback loop, not a silent discard.
  app.post("/api/clips/:id/reject", (req, res) => {
    try {
      const item = rejectClip(req.params.id, req.body?.reason);
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Spend/revenue/funding history behind the summary numbers on /api/status.
  app.get("/api/ledger", (req, res) => {
    try {
      const ledger = new Ledger();
      const limit = Math.min(Number(req.query.limit || 50), 200);
      res.json({ summary: ledger.getSummary(), transactions: ledger.getRecentTransactions(limit) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

  // ── TikTok Review Queue (audit-compliant compose flow, /review.html) ──────
  // Dormant unless Josh wires up TIKTOK_CONTENT_ACCESS_TOKEN for an optional
  // portfolio/demo-reel channel — the business itself doesn't depend on it.
  app.get("/api/review", async (req, res) => {
    try {
      const items = getReviewQueue().filter(i => i.status === "pending");
      let creator = null, creatorError = null;
      try { creator = await tiktok.getCreatorInfo(); } catch (err) { creatorError = err.message; }
      res.json({ reviewMode: isReviewMode(), items, creator, creatorError });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stream a queued video for preview
  app.get("/api/review/:id/video", (req, res) => {
    const item = getReviewItem(req.params.id);
    if (!item || !fs.existsSync(item.videoPath)) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.resolve(item.videoPath));
  });

  // Publish with user-selected metadata (title, privacy, interactions, disclosure)
  app.post("/api/review/:id/publish", async (req, res) => {
    try {
      const item = getReviewItem(req.params.id);
      if (!item || item.status !== "pending") return res.status(404).json({ error: "Not found or already handled" });

      const { title, privacyLevel, allowComment, allowDuet, allowStitch, brandOrganic, brandedContent } = req.body || {};
      if (!privacyLevel) return res.status(400).json({ error: "Select a privacy status first — TikTok requires an explicit choice." });
      if (brandedContent && privacyLevel === "SELF_ONLY") {
        return res.status(400).json({ error: "Branded content visibility cannot be set to private." });
      }

      const { publishId, privacyLevel: applied } = await tiktok.publishVideo({
        videoPath: item.videoPath,
        caption: title != null && String(title).trim() ? String(title).trim() : item.caption,
        hashtags: [], // hashtags are already part of the edited caption/title shown to the user
        privacyLevel,
        allowComment: !!allowComment,
        allowDuet: !!allowDuet,
        allowStitch: !!allowStitch,
        brandOrganic: !!brandOrganic,
        brandedContent: !!brandedContent,
      });

      updateReviewItem(item.id, { status: "posted", publishId, postedAt: new Date().toISOString() });
      video.cleanupEditedClip(item.videoPath);
      log("action", `Josh reviewed and posted "${(title || item.caption || "").slice(0, 60)}..." via the review page (${publishId}, ${applied}).`);
      res.json({ success: true, publishId, privacyLevel: applied });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/review/:id/discard", (req, res) => {
    const item = getReviewItem(req.params.id);
    if (!item || item.status !== "pending") return res.status(404).json({ error: "Not found or already handled" });
    updateReviewItem(item.id, { status: "discarded", discardedAt: new Date().toISOString() });
    video.cleanupEditedClip(item.videoPath);
    log("action", `Josh discarded review-queue post "${(item.caption || "").slice(0, 60)}..."`);
    res.json({ success: true });
  });

  // Post-processing status (publish/status/fetch) so the UI can show progress
  app.get("/api/review/status/:publishId", async (req, res) => {
    try {
      res.json(await tiktok.getPublishStatus(req.params.publishId));
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
        // Persist tokens server-side (volume-backed, auto-refreshing).
        // NEVER render tokens in the browser — they were previously shown on
        // this page in plaintext, which is a credential leak (and an instant
        // problem in any screen recording, e.g. the TikTok audit demo video).
        tiktok.storeOAuthTokens({
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
        });
        log("system", `TikTok reconnected via OAuth — scopes: ${tokenData.scope}`);
        res.send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TikTok Connected · AWON</title>` +
          `<style>body{background:#080808;color:#e8e8e8;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh}` +
          `.card{background:#141414;border:1px solid #262626;border-radius:10px;padding:36px 44px;text-align:center;max-width:440px}` +
          `h1{font-size:22px;letter-spacing:1px;margin:0 0 10px}.ok{color:#c8f542;font-size:40px}p{color:#9a9a9a;font-size:14px;line-height:1.6}` +
          `a{display:inline-block;margin-top:18px;background:#c8f542;color:#000;text-decoration:none;font-weight:600;padding:10px 24px;border-radius:6px}</style></head>` +
          `<body><div class="card"><div class="ok">✓</div><h1>TIKTOK CONNECTED</h1>` +
          `<p>Awon is authorized to post to this TikTok account. Credentials are stored securely server-side and refresh automatically.</p>` +
          `<p>Scopes granted: ${tokenData.scope}</p>` +
          `<a href="/">Back to dashboard</a></div></body></html>`
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
