/**
 * agents/content.js — Content Creation Sub-Agent
 *
 * Awon delegates all TikTok content strategy and creation here.
 * This agent mines existing footage, writes hooks and captions,
 * plans posting schedules, and identifies boost candidates.
 * Organic reach is always priority one.
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";

export async function runContentAgent({ videos, products, memory }) {
  log("sub-agent", "Content agent starting...");

  const result = await thinkJSON({
    system: PERSONAS.contentAgent,
    prompt: `Plan content for this cycle.

Available TikTok videos on @the.rival.is.me:
${videos.length > 0
  ? JSON.stringify(videos.map(v => ({
      id: v.id,
      description: v.title || v.description,
      viewCount: v.statistics?.play_count,
      likeCount: v.statistics?.like_count,
      duration: v.duration,
      createTime: v.create_time,
    })), null, 2)
  : "No TikTok videos available yet (API not fully wired). Plan hypothetical content strategy based on existing fitness journey footage."}

Current products to feature:
${JSON.stringify(products.map(p => ({ id: p.id, title: p.title, price: p.variants?.[0]?.price })), null, 2)}

What's been working (from memory):
${memory.contentNotes?.workingFormats?.join(", ") || "No data yet"}
${memory.contentNotes?.workingHooks?.join(", ") || ""}

Brand: The Rival Is Me. Raw, disciplined, real. Fitness journey content — workout clips, progress, discipline.

Return JSON:
{
  "summary": "one-sentence content plan for this cycle",
  "postsToPublish": [
    {
      "videoId": "existing video ID to use (or null if new content needed)",
      "caption": "full caption text including line breaks",
      "hashtags": ["hashtag1", "hashtag2"],
      "productId": "product to tag (or null)",
      "suggestedPostTime": "ISO timestamp (optimal time)",
      "hook": "the first line / verbal hook",
      "contentAngle": "discipline|transformation|product|challenge|motivation",
      "editingNotes": "trim to 0:00-0:15, add text overlay 'X' at 0:05, etc."
    }
  ],
  "productTags": [
    { "videoId": "...", "productId": "...", "caption": "updated caption" }
  ],
  "boostCandidate": {
    "videoId": "...",
    "amountUsd": 0.00,
    "reasoning": "specific performance data justifying this spend"
  } or null,
  "contentSeriesIdea": "a 3-video arc idea to build momentum this week",
  "trendingOpportunity": "any fitness trend or sound worth riding right now"
}

If no TikTok data is available, plan the strategy and mark videoId as null — Awon will execute when API is live. Don't return empty arrays, return your best recommendations.`,
  });

  log("sub-agent", `Content agent done. ${result.postsToPublish?.length || 0} posts planned, boost candidate: ${result.boostCandidate ? "yes" : "no"}`);
  return result;
}
