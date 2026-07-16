/**
 * agents/product.js — Product Agent (Think + Execute)
 *
 * Awon's product arm. This agent:
 *   1. Analyzes the current Shopify catalog
 *   2. Identifies dead weight (archive) and repricing opportunities
 *   3. Researches new POD fitness products via Printful
 *   4. Creates and publishes new Printful products autonomously
 *   5. Flags the original non-POD products (bag + journal) for replacement
 *   6. Reads any notes Josh left (see core/notes.js) — e.g. flagging that a
 *      product is actually just a low-margin Amazon affiliate link — and, when
 *      a note points at one, sources an owned-margin CJ dropship replacement
 *      and swaps it in (candidate.replacesProductId gets archived once the
 *      replacement is confirmed live)
 *
 * Sub-agents return recommendations AND execute them.
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import { addBlockerOnce } from "../core/queue.js";
import * as shopify from "../integrations/shopify.js";
import * as printful from "../integrations/printful.js";
import * as cj from "../integrations/cj.js";
import * as design from "../integrations/design.js";

// Products that should be replaced by POD equivalents (titles are partial matches)
const LEGACY_PRODUCTS_TO_REPLACE = [
  "DISCIPLINE FIRST BLACKOUT BAG",
  "THE JOURNAL OF DISCIPLINE",
];

export async function runProductAgent({ products, orders, memory, ledger, notes = [] }) {
  log("sub-agent", "Product agent starting...");

  // ── 1. Identify legacy products that need to be replaced ─────────────────
  const legacyProducts = products.filter(p =>
    LEGACY_PRODUCTS_TO_REPLACE.some(name => p.title?.toUpperCase().includes(name.toUpperCase()))
  );
  if (legacyProducts.length > 0) {
    log("sub-agent", `Found ${legacyProducts.length} legacy non-POD product(s) flagged for replacement: ${legacyProducts.map(p => p.title).join(", ")}`);
  }

  // ── 2. Strategic analysis — what does the catalog need? ──────────────────
  const result = await thinkJSON({
    system: PERSONAS.productAgent,
    prompt: `Analyze the current product catalog and make recommendations for The Rival Is Me.

Current catalog (${products.length} products):
${JSON.stringify(products.map(p => ({
  id: p.id,
  title: p.title,
  price: p.variants?.[0]?.price,
  status: p.status,
  tags: p.tags,
  productType: p.product_type,
})), null, 2)}

Recent orders (${orders.length}):
${JSON.stringify(orders.map(o => ({
  id: o.id,
  total: o.total_price,
  items: o.line_items?.map(i => ({ product: i.title, qty: i.quantity, price: i.price })),
})), null, 2)}

Legacy products that MUST be replaced with POD equivalents (these are physical inventory products that don't fit the hands-off POD model):
${legacyProducts.map(p => `- ${p.title} (ID: ${p.id}, price: $${p.variants?.[0]?.price})`).join("\n") || "None found"}

Brand memory / current strategy:
${memory.strategy || "No strategy set yet"}
${(memory.learnings || []).slice(0, 5).map(l => `- ${l.insight}`).join("\n")}

Notes Josh left for you (proactive instructions/context — read carefully, these can point out things the catalog data alone won't tell you, like a product that LOOKS like a normal Shopify listing but is actually just an outbound Amazon affiliate link earning near-zero margin):
${notes.length > 0 ? notes.map(n => `- "${n.text}"`).join("\n") : "None."}

Printful available: ${printful.isConfigured() ? "YES — can create POD products autonomously (Printful is already connected to Shopify)" : "NO — PRINTFUL_API_KEY not set"}
CJ Dropshipping available: ${cj.isConfigured() ? "YES — can search CJ catalog and list supplements/gear on Shopify automatically" : "NO — CJ_API_KEY not set"}
Available budget: $${ledger.getAvailable().toFixed(2)}

Return JSON:
{
  "summary": "one sentence overview of catalog health",
  "keep": ["productId"],
  "kill": ["productId"],
  "repriceSuggestions": [
    { "productId": "...", "newPrice": 0.00, "reasoning": "..." }
  ],
  "legacyToArchive": ["productId"],
  "newPODProducts": [
    {
      "printfulSearchKeyword": "gym shirt",
      "suggestedTitle": "DISCIPLINE OR NOTHING — Training Tee",
      "suggestedDescription": "HTML description in The Rival Is Me voice",
      "retailPrice": 34.99,
      "contentAngle": "how to feature this on TikTok",
      "urgency": "add now|add soon|test first",
      "design": { "type": "logo|text", "text": "TRIM", "color": "white|black" }
    }
  ],
  "newDropshipCandidates": [
    {
      "description": "product name and type (non-POD, e.g. supplements, equipment)",
      "cjSearchKeyword": "whey protein powder",
      "estimatedRetailPrice": 0.00,
      "estimatedCOGS": 0.00,
      "whyItFits": "...",
      "tiktokViralityScore": "low|medium|high",
      "urgency": "add now|add soon|test first",
      "replacesProductId": "the existing catalog productId this replaces, e.g. a low-margin Amazon affiliate placeholder — null if this is a brand new addition"
    }
  ]
}

PRINT DESIGNS — each newPODProduct picks its own via "design":
- "type": "logo" prints the brand logo mark. "type": "text" renders your text in Archivo Black (the brand's own heading typeface), ALL CAPS, transparent background, front placement.
- Text designs are where the brand voice lives on merch. "TRIM" is the brand acronym for THE RIVAL IS ME — a strong, clean design on its own. Other good text: short discipline-forward statements, 1-3 words per line, max 2 lines (separate lines with \\n). Think "TRIM", "THE RIVAL\\nIS ME", "DISCIPLINE\\nFIRST", "NO ONE\\nIS COMING". Never long sentences.
- "color": "white" for dark garments (the brand default), "black" only when the product will be light-colored.
- Vary the catalog: don't put the identical design on everything — mix logo pieces and different text pieces.

HARD RULE on "kill" and "replacesProductId": products Josh added by hand are HIS. You may suggest removals in "kill" (they will be shown to him, not executed), but never target his manual listings with replacesProductId unless the listing is literally an Amazon affiliate link. An empty supplements or equipment collection is a catalog failure, not a cleanup win — prefer improving copy/imagery of existing listings over removing them.

Be decisive. If the catalog needs cleanup, call it. If Printful is available, recommend 2-3 specific POD fitness products to add NOW. Use printfulSearchKeyword values like: "t-shirt", "hoodie", "shorts", "joggers", "tank", "hat", "sweatshirt". If a note or the catalog itself points to Amazon-affiliate-link products (near-zero margin, not real inventory), treat replacing them with an owned-margin CJ dropship equivalent as high urgency — set "urgency": "add now" and fill in "replacesProductId" with that product's id so it gets swapped out, not just added alongside.`,
  });

  log("sub-agent", `Analysis done. ${result.newPODProducts?.length || 0} POD candidates, ${result.kill?.length || 0} to kill, ${result.legacyToArchive?.length || 0} legacy to archive.`);

  // Legacy products flagged for replacement are NOT archived here anymore.
  // They used to be archived at this point in the function — before Printful/
  // CJ had even been asked to create a replacement — so a bad Printful token
  // or dead CJ integration meant real merch got pulled down with nothing
  // live to replace it. Archiving now happens in step 8, after we know
  // whether a replacement actually went live this cycle. Declared here (empty)
  // so the dedup check just below has something to read; step 8 fills it in.
  const legacyArchived = [];

  // ── 4. "Underperformers" — SUGGEST, never auto-archive ───────────────────
  // This used to archive whatever the model put in "kill" immediately. With
  // zero orders there IS no performance data, so "underperformer" was really
  // "product the model didn't like" — and it kept unlisting products Josh
  // added by hand (supplements, equipment, CJ items), emptying whole
  // collections. Removing a live product is Josh's call: surface it as a
  // dashboard blocker and touch nothing.
  const killSuggestions = (result.kill || []).filter(id => !legacyArchived.includes(id));
  if (killSuggestions.length > 0) {
    const names = killSuggestions
      .map(id => products.find(p => String(p.id) === String(id))?.title || id)
      .join(", ");
    log("decision", `Model suggests removing ${killSuggestions.length} product(s) (${names}) — NOT archiving. Left live; flagged for Josh to decide.`);
    addBlockerOnce({
      title: "Product removal suggestions — your call, nothing was touched",
      context: `Based on brand fit (there's no sales data yet), I'd consider removing: ${names}. I have NOT archived anything — products you added stay up unless you say otherwise.`,
      options: ["Leave them all up", "I'll archive the ones I agree with myself"],
      thread: "Whatever you decide, I'll stop re-suggesting these.",
    });
  }

  // ── 5. Reprice ────────────────────────────────────────────────────────────
  for (const reprice of result.repriceSuggestions || []) {
    try {
      await shopify.repriceProduct(reprice.productId, reprice.newPrice);
      log("action", `Repriced ${reprice.productId} → $${reprice.newPrice}: ${reprice.reasoning}`);
    } catch (err) {
      log("error", `Reprice failed (${reprice.productId}): ${err.message}`);
    }
  }

  // ── 6. Create new POD products via Printful ──────────────────────────────
  const createdPODProducts = [];

  if (printful.isConfigured()) {
    const urgentPOD = (result.newPODProducts || []).filter(p => p.urgency === "add now");
    log("sub-agent", `Creating ${urgentPOD.length} urgent POD product(s) via Printful...`);

    // Resolve the store logo once for this batch — used as the print design
    // for every product this cycle. Josh confirmed logo/wordmark-only merch
    // is fine, so this removes the need for a separately hosted
    // PRINTFUL_DESIGN_URL — without it, products were syncing with no print
    // file at all (blank apparel).
    const logoUrl = await shopify.getStoreLogoUrl();
    log("system", logoUrl
      ? `Using store logo as print design: ${logoUrl}`
      : "Could not resolve a store logo — POD products will sync without a print file.");

    for (const candidate of urgentPOD) {
      try {
        // Resolve catalog product + variants
        const catalogProduct = await printful.resolveCatalogProductForKeyword(
          candidate.printfulSearchKeyword || candidate.printifySearchKeyword || "t-shirt"
        );
        log("sub-agent", `Catalog resolved: "${catalogProduct.title}" (${catalogProduct.variants.length} variants)`);

        if (catalogProduct.variants.length === 0) {
          log("error", `No variants found for "${candidate.printfulSearchKeyword}" — skipping`);
          continue;
        }

        // Resolve this product's print design: brand text rendered in
        // Archivo Black if the model asked for it, otherwise the logo.
        // A failed text render falls back to the logo — never blocks.
        let designUrl = logoUrl;
        if (candidate.design?.type === "text" && candidate.design?.text) {
          try {
            const rendered = await design.renderTextDesign(candidate.design.text, { color: candidate.design.color });
            designUrl = rendered.url;
            log("action", `Rendered brand text design "${String(candidate.design.text).replace(/\n/g, " / ")}" (${candidate.design.color || "white"}) for "${candidate.suggestedTitle}" → ${rendered.url}`);
          } catch (err) {
            log("error", `Text design render failed for "${candidate.suggestedTitle}" (${err.message}) — using store logo instead.`);
          }
        }

        // Create sync product — Printful auto-syncs to Shopify
        const product = await printful.createProduct({
          title: candidate.suggestedTitle,
          description: candidate.suggestedDescription || `<p>${candidate.suggestedTitle}</p><p>Built for the ones who chose discipline. #THERIVALISME</p>`,
          catalogProductId: catalogProduct.catalogProductId,
          variants: catalogProduct.variants,
          retailPrice: candidate.retailPrice || 34.99,
          imageUrl: designUrl,
        });

        // Remember which design this product was created with, so
        // fulfillment prints the same art the listing shows.
        if (designUrl && designUrl !== logoUrl) {
          design.saveProductDesign(product.id, designUrl);
        }

        createdPODProducts.push({
          printfulId: product.id,
          title: candidate.suggestedTitle,
          catalogTitle: catalogProduct.title,
          retailPrice: candidate.retailPrice,
          contentAngle: candidate.contentAngle,
        });

        log("action", `POD product live on Shopify: "${candidate.suggestedTitle}" — product ID ${product.id} (Printful catalog ${catalogProduct.catalogProductId})`);

      } catch (err) {
        log("error", `Printful product creation failed for "${candidate.printfulSearchKeyword}": ${err.message}`);
        if (/Manual Order \/ API platform/i.test(err.message)) {
          addBlockerOnce({
            title: "Printful store is the wrong platform type — POD is blocked",
            context: `Printful rejected the request because the connected store is a Shopify-platform store, and this API flow needs a "Manual order platform / API" store. One-time fix: in Printful go to Stores → Add store → choose "Manual order platform / API", then set PRINTFUL_STORE_ID in Railway to the new store's ID (I can list IDs via GET /stores). No Shopify-side changes needed — I create the Shopify listings myself.`,
            options: ["I created the Manual/API store and set PRINTFUL_STORE_ID", "Skip Printful for now"],
            thread: "Once the store ID points at a Manual/API store, POD creation will work on the next cycle.",
          });
        } else if (/401|invalid|unauthorized/i.test(err.message)) {
          addBlockerOnce({
            title: "Printful API key is invalid — no POD products can go live",
            context: `Printful is rejecting every request with a 401/Unauthorized error: "${err.message}". This means no new POD products can be created or synced to Shopify. Go to printful.com/dashboard/settings/api, regenerate the key, and update PRINTFUL_API_KEY in Railway's env vars.`,
            options: ["I've updated the Printful API key in Railway", "Skip Printful for now"],
            thread: "Once the key works again, I'll resume creating and publishing POD products.",
          });
        }
      }
    }
  } else {
    log("system", "Printful not configured (PRINTFUL_API_KEY missing) — POD product creation skipped. Set PRINTFUL_API_KEY in Railway to unlock.");
  }

  // ── 7. Source + list CJ dropship products ────────────────────────────────
  const createdCJProducts = [];

  if (cj.isConfigured()) {
    const urgentDropship = (result.newDropshipCandidates || []).filter(p => p.urgency === "add now");
    if (urgentDropship.length > 0) {
      log("sub-agent", `Sourcing ${urgentDropship.length} dropship product(s) from CJ...`);
    }

    for (const candidate of urgentDropship) {
      try {
        const keyword = candidate.cjSearchKeyword || candidate.description;
        const results = await cj.searchProducts({ keyword, size: 5 });

        if (results.length === 0) {
          log("system", `CJ search for "${keyword}" returned no results — skipping.`);
          continue;
        }

        // Relevance gate: CJ search regularly returns junk for niche terms
        // (a faucet sprayer for "pull-up bar", B12 drops for "nitric oxide
        // booster") and blindly listing results[0] put those on the store.
        // Cheap fast-model check: pick the result that's actually the same
        // kind of product, or skip the candidate entirely.
        let best = results[0];
        try {
          const pick = await thinkJSON({
            fast: true,
            maxTokens: 200,
            system: "You verify whether product search results match a sourcing request. Respond with JSON only.",
            prompt: `Sourcing request: "${candidate.description}"
CJ search results:
${results.map((r, i) => `${i}: ${r.nameEn} ($${r.sellPrice})`).join("\n")}

If one of these is genuinely the same kind of product as the request, return {"match": true, "index": <its number>}. If none are, return {"match": false}.`,
          });
          if (pick && pick.match === false) {
            log("system", `CJ search for "${keyword}" had no relevant match (top result: "${results[0].nameEn}") — skipping candidate.`);
            continue;
          }
          if (pick && Number.isInteger(pick.index) && results[pick.index]) best = results[pick.index];
        } catch {
          // Gate is best-effort — fall back to top result rather than stall sourcing.
        }
        log("sub-agent", `CJ best match for "${keyword}": "${best.nameEn}" @ $${best.sellPrice} (${best.listedNum} listings)`);

        // Dedupe guard: if this exact CJ product is already live on Shopify
        // (tagged cj_pid:<id> at creation), don't list it again. Search is
        // deterministic, so consecutive cycles pick the same best match —
        // without this check every cycle would create a duplicate listing.
        const alreadyListed = products.some(p => (p.tags || "").includes(`cj_pid:${best.id}`));
        if (alreadyListed) {
          log("system", `CJ product "${best.nameEn}" (${best.id}) is already listed on Shopify — skipping duplicate.`);
          continue;
        }

        // Add to my CJ products (required before ordering). Code 100002
        // ("already added") is treated as success inside addToMyProducts.
        await cj.addToMyProducts(best.id);

        // Get full details + variants
        const details = await cj.getProductDetails(best.id);
        const productWithVariants = { ...best, ...details };

        // Build and create Shopify listing
        const shopifyPayload = cj.buildShopifyProduct(productWithVariants, {
          retailMultiplier: 2.5,
          brand: "The Rival Is Me",
        });

        // Override title/description if candidate has suggestions
        if (candidate.suggestedTitle) shopifyPayload.title = candidate.suggestedTitle;
        if (candidate.suggestedDescription) shopifyPayload.body_html = candidate.suggestedDescription;

        const created = await shopify.createProduct(shopifyPayload);
        createdCJProducts.push({
          shopifyId: created.id,
          title: created.title,
          cjPid: best.id,
          cjSku: best.sku,
          cogs: cj.parseCJPrice(best.sellPrice),
          retailPrice: parseFloat(created.variants?.[0]?.price),
          replacedProductId: candidate.replacesProductId || null,
        });

        log("action", `CJ product live on Shopify: "${created.title}" — $${created.variants?.[0]?.price} retail, $${best.sellPrice} COGS`);

        // If this was replacing an existing low-margin listing, archive the
        // old one — but ONLY if it's verifiably an Amazon affiliate
        // placeholder (the one category Josh explicitly approved swapping
        // out). The model was pointing replacesProductId at Josh's own real
        // listings, which then got silently unlisted.
        if (candidate.replacesProductId) {
          const target = products.find(p => String(p.id) === String(candidate.replacesProductId));
          const isAffiliatePlaceholder = /amazon\.|amzn\./i.test(target?.body_html || "");
          if (isAffiliatePlaceholder) {
            try {
              await shopify.archiveProduct(candidate.replacesProductId);
              log("action", `Archived Amazon-affiliate listing ${candidate.replacesProductId} — replaced by CJ dropship product "${created.title}"`);
            } catch (archiveErr) {
              log("error", `Created replacement product but failed to archive old listing ${candidate.replacesProductId}: ${archiveErr.message}`);
            }
          } else {
            log("decision", `Replacement "${created.title}" is live, but target ${candidate.replacesProductId} ("${target?.title || "unknown"}") is NOT an Amazon affiliate listing — leaving it up. Removing real listings is Josh's call.`);
          }
        }

      } catch (err) {
        log("error", `CJ product listing failed for "${candidate.description}": ${err.message}`);
        addBlockerOnce({
          title: "CJ Dropshipping isn't successfully listing products",
          context: `CJ product listing keeps failing: "${err.message}". Dropship sourcing isn't producing anything right now — check CJ_API_KEY and CJ account status.`,
          options: ["I'll check the CJ integration/API key", "Skip CJ dropshipping for now"],
          thread: "Once CJ listing succeeds again, I'll resume sourcing dropship candidates.",
        });
      }
    }
  }

  // ── 8. Archive legacy products — only after confirming a real replacement
  //       actually went live this cycle (POD or CJ). Archiving used to
  //       happen up front based on the LLM's plan alone, so a broken
  //       Printful/CJ integration meant real merch got pulled with nothing
  //       to replace it.
  const legacyToArchive = result.legacyToArchive || [];
  const hasVerifiedReplacement = createdPODProducts.length > 0 || createdCJProducts.length > 0;

  if (legacyToArchive.length > 0) {
    if (hasVerifiedReplacement) {
      for (const productId of legacyToArchive) {
        try {
          await shopify.archiveProduct(productId);
          legacyArchived.push(productId);
          log("action", `Archived legacy product ${productId} — replacement confirmed live this cycle`);
        } catch (err) {
          log("error", `Failed to archive legacy product ${productId}: ${err.message}`);
        }
      }
    } else {
      log("decision", `Skipped archiving ${legacyToArchive.length} legacy product(s) — no POD/CJ replacement actually went live this cycle. Leaving them up rather than creating a gap.`);
      addBlockerOnce({
        title: "Legacy product(s) flagged for replacement, but nothing replaced them",
        context: `I identified ${legacyToArchive.length} legacy product(s) that should be replaced by POD/CJ equivalents, but every attempt to create the replacement failed this cycle. I'm leaving the old listing(s) live instead of pulling them with nothing to replace them. Check the Printful API key and CJ integration — see the other blocker(s) for specifics.`,
        options: ["I'll check Printful/CJ", "Archive them anyway even without a confirmed replacement"],
        thread: "Once a replacement is confirmed live, I'll archive the legacy listing in that same cycle.",
      });
    }
  }

  return {
    summary: result.summary,
    keep: result.keep,
    kill: result.kill,
    repriceSuggestions: result.repriceSuggestions,
    legacyArchived,
    createdPODProducts,
    createdCJProducts,
    newDropshipCandidates: result.newDropshipCandidates || [],
    // Legacy compat — awon.js still reads this
    newProductCandidates: [
      ...(result.newDropshipCandidates || []),
      ...(result.newPODProducts || []).filter(p => p.urgency !== "add now").map(p => ({
        description: p.suggestedTitle,
        searchTerms: [p.printfulSearchKeyword],
        estimatedRetailPrice: p.retailPrice,
        whyItFits: p.contentAngle,
        tiktokViralityScore: "high",
        urgency: p.urgency,
      })),
    ],
  };
}
