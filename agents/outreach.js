/**
 * agents/outreach.js — Outreach Agent
 *
 * IMPORTANT HONEST LIMITATION: this agent does NOT discover brand-new
 * prospects out of thin air. Claude has no live web-search tool wired into
 * this server process (that's a Claude Code-only capability, not part of the
 * plain Anthropic API this repo calls) — so it never invents prospect names
 * from training data, which would just be hallucination wearing a
 * "research" label. Real autonomous lead discovery needs a real search API
 * (e.g. Serper.dev, Google Custom Search) wired into a future
 * integrations/search.js — that needs an API key Josh sets up, same
 * login-gated category as everything else external. Until then, prospects
 * come from clients.addClient() — added by Josh via the dashboard, or by a
 * future search integration once it exists.
 *
 * What this agent DOES do autonomously: draft real, specific outreach copy
 * for prospects already in the system, and send it once contact info and
 * RESEND_API_KEY are configured.
 */

import { think, PERSONAS } from "../core/claude.js";
import { log } from "../core/logger.js";
import * as clients from "../core/clients.js";
import * as email from "../integrations/email.js";

export async function runOutreachAgent({ memory }) {
  log("sub-agent", "Outreach agent starting...");

  const prospects = clients.getProspects().filter((p) => (p.outreach || []).length === 0);

  if (prospects.length === 0) {
    const msg = "No new prospects waiting on first contact. Prospect discovery isn't automated yet (no search API wired in) — add candidates via the dashboard, or wire integrations/search.js once an API key exists.";
    log("sub-agent", `Outreach agent: ${msg}`);
    return { summary: msg, drafted: 0, sent: 0 };
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

  const summary = `${drafted} outreach draft(s) written, ${sent} actually sent.`;
  log("sub-agent", `Outreach agent done. ${summary}`);
  return { summary, drafted, sent };
}
