/**
 * integrations/email.js — outbound email (cold outreach + invoice delivery)
 *
 * Uses Resend (resend.com) — a single API key, no OAuth dance, sends over a
 * plain HTTP call. Josh signs up and verifies a sending domain himself (an
 * account + identity step — his job, not the agent's); once RESEND_API_KEY
 * and EMAIL_FROM are set, sending is fully autonomous from here.
 *
 * (Ally uses a Gmail-API/FluentSMTP pattern for its own sending — if Josh
 * wants both bots on one consistent email path later that's an easy swap,
 * this file is the only thing that would change.)
 *
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 */

const BASE = "https://api.resend.com";

export function isConfigured() {
  return !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;
}

/** Send a single email. Returns Resend's message id for logging/tracking. */
export async function sendEmail({ to, subject, html, replyTo }) {
  if (!isConfigured()) throw new Error("RESEND_API_KEY / EMAIL_FROM not set.");

  const res = await fetch(`${BASE}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Email send failed: ${data.message || res.status}`);
  return { id: data.id };
}
