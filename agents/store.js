/**
 * agents/store.js — Store Design Agent
 *
 * Awon's visual arm. This agent:
 *   1. Reads the current Shopify theme settings
 *   2. Evaluates whether the store looks on-brand for The Rival Is Me
 *   3. Proposes specific changes (hero text, colors, sections, imagery direction)
 *   4. Applies approved changes directly to the theme via settings_data.json
 *   5. Can update store pages (About, mission statement, etc.)
 *
 * Runs once per week — not every cycle. Visual changes shouldn't happen constantly.
 * Always checks: does this serve The Rival Is Me brand? If no, don't touch it.
 *
 * Requires Shopify scopes: read_themes, write_themes
 * If scopes missing, agent logs the gap and exits gracefully.
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import * as shopify from "../integrations/shopify.js";

// Brand-locked design rules — these override anything the AI suggests
const DESIGN_RULES = `
STORE DESIGN NON-NEGOTIABLES:
- Color palette: Dark/black backgrounds, white text, minimal accent color (deep red or gold acceptable)
- Typography: Bold, heavy-weight fonts for headings. Clean sans-serif for body.
- Imagery direction: Real training environments, not studio shoots. Raw > polished.
- Hero message: Must reference discipline, the rival within, or the mission
- No lifestyle fluff. No smiling faces in generic "gym clothes." Real work only.
- Premium positioning: clean whitespace, no cluttered discount banners
- Brand name "The Rival Is Me" must be prominently visible above the fold
- Tagline "BUILD DISCIPLINE FIRST" should appear somewhere on homepage
`;

export async function runStoreAgent({ memory }) {
  log("sub-agent", "Store agent starting — reading current theme...");

  // ── 1. Check if theme scopes are available ────────────────────────────────
  let currentSettings = null;
  let themeId = null;
  let themeName = null;

  try {
    const themeData = await shopify.getThemeSettings();
    currentSettings = themeData.settings;
    themeId = themeData.themeId;
    themeName = themeData.themeName;
    log("sub-agent", `Theme loaded: "${themeName}" (ID: ${themeId})`);
  } catch (err) {
    if (err.message.includes("403") || err.message.includes("401")) {
      log("system", "Store agent skipped — Shopify token missing read_themes/write_themes scopes. Add them in Shopify Admin → Apps → [your app] → Edit permissions, then update SHOPIFY_ADMIN_API_ACCESS_TOKEN in Railway.");
    } else {
      log("error", `Store agent: failed to load theme — ${err.message}`);
    }
    return { skipped: true, reason: err.message };
  }

  // ── 2. Get current pages ──────────────────────────────────────────────────
  let pages = [];
  try {
    pages = await shopify.getPages();
  } catch (_) {}

  // ── 3. AI evaluation + proposed changes ──────────────────────────────────
  const result = await thinkJSON({
    system: `${PERSONAS.awon}\n\nYou are evaluating and improving the Shopify storefront for The Rival Is Me. You have full access to update theme settings and pages. Every change must serve the brand.`,
    prompt: `Evaluate the current store design and propose specific changes.

Current theme: "${themeName}"

Current theme settings (settings_data.json):
${JSON.stringify(currentSettings, null, 2).slice(0, 8000)}

Current pages: ${pages.map(p => `${p.title} (handle: ${p.handle})`).join(", ") || "none"}

What's been selling / current strategy: ${memory.strategy || "Building from scratch — catalog is being rebuilt via Printful POD"}

${DESIGN_RULES}

Your job: Make this store look like The Rival Is Me — dark, disciplined, premium, real.

Return JSON:
{
  "assessment": "one sentence: does the store currently represent the brand?",
  "settingsChanges": {
    "description": "what you're changing and why",
    "patches": [
      {
        "path": "dot.notation.path.in.settings_data",
        "value": "new value",
        "reasoning": "why this change serves the brand"
      }
    ]
  },
  "heroTextSuggestion": "what the homepage hero headline should say",
  "pageUpdates": [
    {
      "handle": "about",
      "title": "About",
      "body_html": "<p>full HTML page content in The Rival Is Me voice</p>",
      "action": "update|create"
    }
  ],
  "imageryDirectionNote": "note to Josh about what photography/imagery would level up the store (Awon can't upload photos, but can advise)",
  "changesApplied": false
}

Only propose changes you're confident about. It is BETTER to change nothing than to make the store look generic. Every change must pass: 'does this make The Rival Is Me stronger?'`,
  });

  log("sub-agent", `Store assessment: ${result.assessment}`);

  // ── 4. Apply settings patches ─────────────────────────────────────────────
  let settingsApplied = false;
  const patches = result.settingsChanges?.patches || [];

  if (patches.length > 0) {
    try {
      // Deep-patch the settings object using dot-notation paths
      const updatedSettings = JSON.parse(JSON.stringify(currentSettings));

      for (const patch of patches) {
        try {
          setDeepValue(updatedSettings, patch.path, patch.value);
          log("action", `Theme patch: ${patch.path} → ${JSON.stringify(patch.value)} (${patch.reasoning})`);
        } catch (err) {
          log("error", `Could not apply patch ${patch.path}: ${err.message}`);
        }
      }

      await shopify.updateThemeSettings(themeId, updatedSettings);
      settingsApplied = true;
      log("action", `Theme settings updated — ${patches.length} change(s) applied to "${themeName}"`);
    } catch (err) {
      log("error", `Failed to apply theme settings: ${err.message}`);
    }
  } else {
    log("sub-agent", "Store agent: no settings changes needed this cycle");
  }

  // ── 5. Apply page updates ─────────────────────────────────────────────────
  for (const pageUpdate of result.pageUpdates || []) {
    try {
      if (pageUpdate.action === "update") {
        const existing = pages.find(p => p.handle === pageUpdate.handle);
        if (existing) {
          await shopify.updatePage(existing.id, {
            title: pageUpdate.title,
            body_html: pageUpdate.body_html,
          });
          log("action", `Updated store page: "${pageUpdate.title}"`);
        }
      } else if (pageUpdate.action === "create") {
        await shopify.createPage({
          title: pageUpdate.title,
          body_html: pageUpdate.body_html,
          handle: pageUpdate.handle,
        });
        log("action", `Created store page: "${pageUpdate.title}"`);
      }
    } catch (err) {
      log("error", `Page update failed (${pageUpdate.handle}): ${err.message}`);
    }
  }

  // Log imagery advice for Josh to see on dashboard
  if (result.imageryDirectionNote) {
    log("decision", `Store imagery note: ${result.imageryDirectionNote}`);
  }

  return {
    assessment: result.assessment,
    settingsApplied,
    patchesApplied: settingsApplied ? patches.length : 0,
    pagesUpdated: (result.pageUpdates || []).length,
    heroTextSuggestion: result.heroTextSuggestion,
    imageryDirectionNote: result.imageryDirectionNote,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set a value in a nested object using dot notation.
 * e.g. setDeepValue(obj, "sections.hero.settings.heading", "DISCIPLINE FIRST")
 */
function setDeepValue(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}
