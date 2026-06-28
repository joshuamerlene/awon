/**
 * agents/analytics.js — Analytics Sub-Agent
 *
 * Surfaces what's actually working. Awon runs this periodically
 * (not every cycle — only when there's enough data to analyze).
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";

export async function runAnalyticsAgent({ products, orders, videos, memory }) {
  log("sub-agent", "Analytics agent starting...");

  const result = await thinkJSON({
    system: PERSONAS.analyticsAgent,
    prompt: `Analyze performance data and surface actionable insights.

Orders (${orders.length} total):
${JSON.stringify(orders.slice(0, 20).map(o => ({
  id: o.id,
  revenue: o.total_price,
  items: o.line_items?.map(i => ({ title: i.title, qty: i.quantity })),
  date: o.created_at,
  fulfillment: o.fulfillment_status,
})), null, 2)}

TikTok videos performance:
${videos.length > 0
  ? JSON.stringify(videos.slice(0, 20).map(v => ({
      id: v.id,
      description: v.description?.slice(0, 100),
      plays: v.statistics?.play_count,
      likes: v.statistics?.like_count,
      shares: v.statistics?.share_count,
      comments: v.statistics?.comment_count,
      duration: v.duration,
    })), null, 2)
  : "No TikTok data available yet."}

Products:
${JSON.stringify(products.slice(0, 20).map(p => ({ id: p.id, title: p.title, price: p.variants?.[0]?.price })), null, 2)}

Previous learnings:
${memory.learnings.slice(0, 10).map(l => `- ${l.insight}`).join("\n") || "None yet."}

Return JSON:
{
  "topInsight": "single most important thing the data shows",
  "rankedInsights": [
    { "insight": "...", "action": "what Awon should do about it", "priority": "high|medium|low" }
  ],
  "winnersToDoubleDown": ["product/video/format names"],
  "losersToKill": ["product/video/format names"],
  "audiencePattern": "what the data reveals about the audience",
  "recommendedFocus": "what the next 2 weeks should be optimized for"
}`,
  });

  log("sub-agent", `Analytics agent done. Top insight: ${result.topInsight}`);
  return result;
}
