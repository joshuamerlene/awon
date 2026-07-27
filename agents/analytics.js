/**
 * agents/analytics.js — Analytics Sub-Agent
 *
 * Surfaces what's actually working across the client pipeline: prospecting,
 * closing, delivery, and payout. Awon runs this periodically (not every
 * cycle — only when there's enough data to analyze).
 */

import { thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import * as clients from "../core/clients.js";
import { getClipQueue } from "./clipAgent.js";

export async function runAnalyticsAgent({ memory }) {
  log("sub-agent", "Analytics agent starting...");

  const allClients = clients.getAllClients();
  const clipQueue = getClipQueue();

  const result = await thinkJSON({
    system: PERSONAS.analyticsAgent,
    prompt: `Analyze the client pipeline and surface actionable insights.

Clients (${allClients.length} total):
${JSON.stringify(allClients.map(c => ({
  name: c.name,
  status: c.status,
  sourceChannel: c.sourceChannel,
  dealType: c.dealType,
  rateUsd: c.rateUsd,
  outreachCount: c.outreach?.length || 0,
  invoiceCount: c.invoices?.length || 0,
  invoicesPaid: (c.invoices || []).filter(i => i.status === "paid").length,
  clipsDelivered: c.clipsDelivered || 0,
  totalPaidUsd: c.totalPaidUsd || 0,
})), null, 2)}

Clip delivery queue (${clipQueue.length} total):
${JSON.stringify(clipQueue.slice(0, 20).map(c => ({
  client: c.clientName,
  status: c.status,
  viralScore: c.viralScore,
  queuedAt: c.queuedAt,
})), null, 2)}

Previous learnings:
${(memory.learnings || []).slice(0, 10).map(l => `- ${l.insight}`).join("\n") || "None yet."}

Return JSON:
{
  "topInsight": "single most important thing the data shows",
  "rankedInsights": [
    { "insight": "...", "action": "what Awon should do about it", "priority": "high|medium|low" }
  ],
  "pipelineHealth": "one-sentence read on where prospects are getting stuck, if anywhere",
  "bestClientProfile": "what the best-converting/best-paying clients have in common, if there's enough data yet",
  "recommendedFocus": "what the next 2 weeks should be optimized for"
}`,
  });

  log("sub-agent", `Analytics agent done. Top insight: ${result.topInsight}`);
  return result;
}
