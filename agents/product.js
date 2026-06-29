/**
 * agents/product.js — Product Agent (Think + Execute)
 *
 * Awon's product arm. This agent:
 *   1. Analyzes the current Shopify catalog
 *   2. Identifies dead weight (archive) and repricing opportunities
 *   3. Researches new POD fitness products via Printify
 *   4. Creates and publishes new Printify products autonomously
 *   5. Flags the original non-POD products (bag + journal) for replacement
 *
 * Sub-agents return recommendations AND execute them.
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import * as shopify from "../integrations/shopify.js";
import * as printify from "../integrations/printify.js";

// Products that should be replaced by POD equivalents (titles are partial matches)
const LEGACY_PRODUCTS_TO_REPLACE = [
  "DISCIPLINE FIRST BLACKOUT BAG",
  "THE JOURNAL OF DISCIPLINE",
];

export async function runProductAgent({ products, orders, memory, ledger }) {
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

Printify available: ${printify.isConfigured() ? "YES — can create POD products autonomously" : "NO — PRINTIFY_API_KEY not set"}
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
      "printifySearchKeyword": "gym shirt",
      "suggestedTitle": "DISCIPLINE OR NOTHING — Training Tee",
      "suggestedDescription": "HTML description in The Rival Is Me voice",
      "retailPrice": 34.99,
      "contentAngle": "how to feature this on TikTok",
      "urgency": "add now|add soon|test first"
    }
  ],
  "newDropshipCandidates": [
    {
      "description": "product name and type (non-POD, e.g. supplements, equipment)",
      "searchTerms": ["term1"],
      "estimatedRetailPrice": 0.00,
      "estimatedCOGS": 0.00,
      "whyItFits": "...",
      "tiktokViralityScore": "low|medium|high",
      "urgency": "add now|add soon|test first"
    }
  ]
}

Be decisive. If the catalog needs cleanup, call it. If Printify is available, recommend 2-3 specific POD fitness products to add NOW.`,
  });

  log("sub-agent", `Analysis done. ${result.newPODProducts?.length || 0} POD candidates, ${result.kill?.length || 0} to kill, ${result.legacyToArchive?.length || 0} legacy to archive.`);

  // ── 3. Archive legacy products ────────────────────────────────────────────
  const legacyArchived = [];
  for (const productId of result.legacyToArchive || []) {
    try {
      await shopify.archiveProduct(productId);
      legacyArchived.push(productId);
      log("action", `Archived legacy product ${productId} — replaced by POD`);
    } catch (err) {
      log("error", `Failed to archive legacy product ${productId}: ${err.message}`);
    }
  }

  // ── 4. Archive underperformers ────────────────────────────────────────────
  for (const productId of result.kill || []) {
    // Don't double-archive
    if (legacyArchived.includes(productId)) continue;
    try {
      await shopify.archiveProduct(productId);
      log("action", `Archived underperformer ${productId}`);
    } catch (err) {
      log("error", `Archive failed (${productId}): ${err.message}`);
    }
  }

  // ── 5. Reprice ────────────────────────────────────────────────────────────
  for (const reprice of result.repriceSuggestions || []) {
    try {
      await shopify.updateProduct(reprice.productId, {
        variants: [{ price: String(reprice.newPrice) }],
      });
      log("action", `Repriced ${reprice.productId} → $${reprice.newPrice}: ${reprice.reasoning}`);
    } catch (err) {
      log("error", `Reprice failed (${reprice.productId}): ${err.message}`);
    }
  }

  // ── 6. Create new POD products via Printify ───────────────────────────────
  const createdPODProducts = [];

  if (printify.isConfigured()) {
    const urgentPOD = (result.newPODProducts || []).filter(p => p.urgency === "add now");
    log("sub-agent", `Creating ${urgentPOD.length} urgent POD product(s) via Printify...`);

    for (const candidate of urgentPOD) {
      try {
        // Find blueprint
        const blueprint = await printify.resolveBlueprintForKeyword(candidate.printifySearchKeyword);
        log("sub-agent", `Blueprint resolved: "${blueprint.blueprintTitle}" via ${blueprint.providerTitle}`);

        if (blueprint.variants.length === 0) {
          log("error", `No variants found for blueprint ${blueprint.blueprintId} — skipping`);
          continue;
        }

        // Enable the most common sizes/colors — enable all variants at retail price
        const retailPriceCents = Math.round((candidate.retailPrice || 34.99) * 100);
        const enabledVariants = blueprint.variants.slice(0, 50).map(v => ({
          id: v.id,
          price: retailPriceCents,
          is_enabled: true,
        }));

        // Create product (no custom design yet — Printify will use default/blank)
        const product = await printify.createProduct({
          title: candidate.suggestedTitle,
          description: candidate.suggestedDescription || `<p>${candidate.suggestedTitle}</p><p>Built for the ones who chose discipline.</p>`,
          blueprintId: blueprint.blueprintId,
          printProviderId: blueprint.printProviderId,
          variants: enabledVariants,
          printAreas: [
            {
              variant_ids: enabledVariants.map(v => v.id),
              placeholders: [
                {
                  position: "front",
                  images: [], // No design uploaded yet — Awon logs this as a next step
                },
              ],
            },
          ],
        });

        // Publish to Shopify
        await printify.publishProduct(product.id);

        createdPODProducts.push({
          printifyId: product.id,
          title: candidate.suggestedTitle,
          blueprintTitle: blueprint.blueprintTitle,
          retailPrice: candidate.retailPrice,
          contentAngle: candidate.contentAngle,
        });

        log("action", `POD product live: "${candidate.suggestedTitle}" — Printify ID ${product.id}`);

      } catch (err) {
        log("error", `Printify product creation failed for "${candidate.printifySearchKeyword}": ${err.message}`);
      }
    }
  } else {
    log("system", "Printify not configured (PRINTIFY_API_KEY missing) — POD product creation skipped. Set PRINTIFY_API_KEY in Railway to unlock.");
  }

  return {
    summary: result.summary,
    keep: result.keep,
    kill: result.kill,
    repriceSuggestions: result.repriceSuggestions,
    legacyArchived,
    createdPODProducts,
    newDropshipCandidates: result.newDropshipCandidates || [],
    // Legacy compat — awon.js still reads this
    newProductCandidates: [
      ...(result.newDropshipCandidates || []),
      ...(result.newPODProducts || []).filter(p => p.urgency !== "add now").map(p => ({
        description: p.suggestedTitle,
        searchTerms: [p.printifySearchKeyword],
        estimatedRetailPrice: p.retailPrice,
        whyItFits: p.contentAngle,
        tiktokViralityScore: "high",
        urgency: p.urgency,
      })),
    ],
  };
}
