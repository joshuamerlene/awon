/**
 * dashboard/server.js — Awon's web dashboard
 *
 * Serves the dashboard UI and a simple REST API for:
 *   GET  /api/status    — Awon's current state + budget summary
 *   GET  /api/blockers  — all blockers (pending + resolved)
 *   POST /api/blockers/:id/resolve — Josh resolves a blocker
 *   GET  /api/log       — recent action log
 *   GET  /api/memory    — Awon's sandbox/memory
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { getAllBlockers, resolveBlocker, getPendingBlockers } from "../core/queue.js";
import { getLog } from "../core/logger.js";
import { loadMemory } from "../core/memory.js";
import { Ledger } from "../core/ledger.js";

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
