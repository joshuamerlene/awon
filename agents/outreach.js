/**
 * agents/outreach.js — Outreach Agent
 *
 * Prospect discovery uses Anthropic's native hosted web_search tool
 * (core/claude.js `webSearch: true`) — a real Messages API tool, not a
 * separate vendor integration or API key. This is what keeps discovery
 * honest: candidates are grounded in actual search results Claude read this
 * cycle, not invented from training data. Discovery only runs when the
 * prospect pipeline is thin (see MIN_UNCONTACTED_PROSPECTS below) so it
 * doesn't burn search calls every cycle once there's a real backlog.
 *
 * What this agent does autonomously end to end: find real candidates via
 * live search, add them to the pipeline, draft real specific outreach copy,
 * and send it once contact info and RESEND_API_KEY are configured.
 */

import { think, thinkJSON, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import * as clients from "../core/clients.js";
import * as email from "../integrations/email.js";

const MIN_UNCONTACTED_PROSPECTS = 3;

async function discoverProspects({ memory }) {
  const existingNames = clients.getAllClients().map((c) => c.name);

  const result = await thinkJSON({
    system: PERSONAS.outreachAgent,
    prompt: `Search the web right now to find 2-4 REAL, SPECIFIC prospect candidates for the clip production business — actual creators/streamers/podcasters/brands, not generic categories.

Already in the pipeline (don't repeat these): ${existingNames.join(", ") || "none yet"}

Search for candidates matching the "good prospect" criteria from your persona: real regular long-form content cadence, real audience size signal, no visible dedicated short-form/clips presence. Look for a real contact path too (a business email listed in their channel/podcast "about" page or bio is common — note it if you find one, otherwise leave contactEmail null).

Return JSON:
{
  "candidates": [
    {
      "name": "the real creator/show/brand name you found",
      "sourceChannel": "where you found them, e.g. \\"YouTube search\\", \\"podcast directory\\"",
      "signal": "the specific real detail that made them a candidate — reference what you actually found",
      "contactEmail": "an actual email you found, or null",
      "notes": "1-2 sentences a human could verify — what they publish, roughly how often, why no clips presence yet"
    }
  ]
}

Only include candidates you actually found via search this turn — never fabricate a name, a stat, or an email. If search doesn't turn up anything solid, return an empty candidates array rather than inventing one.`,
    webSearch: true,
    fast: false,
  });

  let added = 0;
  for (const candidate of result.candidates || []) {
    if (!candidate.name || existingNames.includes(candidate.name)) continue;
    clients.addClient({
      name: candidate.name,
      contactEmail: candidate.contactEmail || null,
      sourceChannel: candidate.sourceChannel || "web-search",
      notes: `${candidate.signal || ""} ${candidate.notes || ""}`.trim(),
    });
    added++;
    log("action", `Discovered prospect via web search: "${candidate.name}" (${candidate.sourceChannel || "web"}).`);
  }
  return added;
}

export async function runOutreachAgent({ memory }) {
  log("sub-agent", "Outreach agent starting...");

  let discovered = 0;
  const uncontactedCount = clients.getProspects().filter((p) => (p.outreach || []).length === 0).length;
  if (uncontactedCount < MIN_UNCONTACTED_PROSPECTS) {
    try {
      discovered = await discoverProspects({ memory });
    } catch (err) {
      log("error", `Prospect discovery failed: ${err.message}`);
    }
  }

  const prospects = clients.getProspects().filter((p) => (p.outreach || []).length === 0);

  if (prospects.length === 0) {
    const msg = discovered === 0
      ? "No new prospects waiting on first contact, and this cycle's web search turned up nothing solid enough to add. Will try again next cycle, or add candidates via the dashboard."
      : `Discovered ${discovered} new prospect(s) this cycle but none are ready for outreach yet.`;
    log("sub-agent", `Outreach agent: ${msg}`);
    return { summary: msg, discovered, drafted: 0, sent: 0 };
  }

  let drafted = 0, sent = 0;

  for (const prospect of prospects) {
    try {
      const copy = await think({
        system: PERSONAS.outreachAgent,
        prompt: `Write a first-contact outreach email to this prospect.

Name/entity: ${prospect.name}
What we know about them: ${prospect.notes || "(no additional notes on file)"}
Source of this lead: ${prospect.sourceChannel || "unknown"}

Write the email body as clean HTML (short <p> tags only, no images, no heavy formatting). Reference something specific and real from the notes above — if there's nothing specific on file, keep it short and honest rather than inventing a fake specific detail. State the offer plainly: cut their existing footage into short-form clips, they keep full control of posting through their own account. End with a low-friction next step (a quick reply, not a big ask).

Return ONLY the HTML email body. No subject line, no commentary.`,
        fast: false,
      });

      drafted++;

      if (prospect.contactEmail && email.isConfigured()) {
        await email.sendEmail({
          to: prospect.contactEmail,
          subject: `Quick idea for your content`,
          html: copy,
        });
        clients.logOutreach(prospect.id, { channel: "email", summary: copy.replace(/<[^>]+>/g, " ").slice(0, 200) });
        sent++;
        log("action", `Sent outreach email to "${prospect.name}".`);
      } else {
        clients.logOutreach(prospect.id, { channel: "draft-only", summary: copy.replace(/<[^>]+>/g, " ").slice(0, 200) });
        log("action", `Drafted outreach for "${prospect.name}" but couldn't send — ${!prospect.contactEmail ? "no contact email on file" : "email sending not configured (RESEND_API_KEY/EMAIL_FROM)"}.`);
      }
    } catch (err) {
      log("error", `Outreach failed for "${prospect.name}": ${err.message}`);
    }
  }

  const summary = `${discovered} new prospect(s) discovered, ${drafted} outreach draft(s) written, ${sent} actually sent.`;
  log("sub-agent", `Outreach agent done. ${summary}`);
  return { summary, discovered, drafted, sent };
}
