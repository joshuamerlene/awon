/**
 * agents/product.js — Product Research Sub-Agent
 *
 * Awon delegates product decisions here. This agent evaluates the
 * current catalog, identifies underperformers, and researches new
 * candidates for the fitness niche.
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";

export async function runProductAgent({ products, orders, memory, ledger }) {
  log("sub-agent", "Product agent starting...");

  const result = await thinkJSON({
    system: PERSONAS.productAgent,
    prompt: `Analyze the current product catalog and make recommendations.

Current catalog (${products.length} products):
${JSON.stringify(products.map(p => ({
  id: p.id,
  title: p.title,
  price: p.variants?.[0]?.price,
  status: p.status,
  tags: p.tags,
})), null, 2)}

Recent orders (${orders.length}):
${JSON.stringify(orders.map(o => ({
  id: o.id,
  total: o.total_price,
  items: o.line_items?.map(i => ({ product: i.title, qty: i.quantity, price: i.price })),
})), null, 2)}

Brand memory / what's working:
${memory.strategy}
${memory.learnings.slice(0, 5).map(l => `- ${l.insight}`).join("\n")}

Available budget for any paid tools/research: $${ledger.getAvailable().toFixed(2)}

Return JSON:
{
  "summary": "one sentence overview of catalog health",
  "keep": ["productId", ...],
  "kill": ["productId", ...],
  "repriceSuggestions": [
    { "productId": "...", "newPrice": 0.00, "reasoning": "..." }
  ],
  "newProductCandidates": [
    {
      "description": "product name and type",
      "searchTerms": ["term1", "term2"],
      "estimatedRetailPrice": 0.00,
      "estimatedCOGS": 0.00,
      "whyItFits": "brand and niche fit reasoning",
      "tiktokViralityScore": "low|medium|high",
      "urgency": "add now|add soon|test first"
    }
  ],
  "blockerNeeded": null
}

Be specific. If no action is needed on something, say so clearly. No filler.`,
  });

  log("sub-agent", `Product agent done. ${result.newProductCandidates?.length || 0} new candidates, ${result.kill?.length || 0} to archive.`);
  return result;
}
