/**
 * core/chat.js — Josh's live chat with Awon (ported from Ally)
 *
 * Unlike notes (read once per 8-hour cycle), this is instant and two-way.
 * Josh tells Awon how the business is doing and what to focus on; Awon
 * replies immediately like a teammate AND quietly folds durable facts /
 * directives into his living memory (core/chatMemory.js), which is then
 * injected into every system prompt he thinks with.
 */

import { think, thinkJSON, PERSONAS } from "./claude.js";
import { addFact, addDirective, appendChat, getChat } from "./chatMemory.js";
import { log } from "./logger.js";

export async function handleChat(message) {
  const text = String(message || "").trim();
  if (!text) throw new Error("empty message");

  appendChat("josh", text);

  // 1) Pull out anything worth remembering (durable facts vs. things to DO).
  const saved = { facts: [], directives: [] };
  try {
    const ex = await thinkJSON({
      fast: true,
      maxTokens: 400,
      system: PERSONAS.awon,
      prompt:
        `Josh (your owner) just told you something in your private chat. Extract only what you should REMEMBER going forward.\n` +
        `- "facts": durable truths about The Rival Is Me (brand, customers, products, pricing, channels, policies, people).\n` +
        `- "directives": things you should DO or emphasize for a while (a campaign, a product push, a content focus). ` +
        `If it has a time limit, set durationDays (e.g. "for a week"=7, "this month"=30); if open-ended, null.\n` +
        `Ignore small talk, greetings, and one-off questions. If nothing durable, return empty arrays. ` +
        `Write each item as a short instruction to yourself, in the third person about the business.\n\n` +
        `JOSH SAID: "${text}"\n\n` +
        `Return JSON: {"facts":["..."],"directives":[{"text":"...","durationDays":7}]}`,
    });
    for (const f of ex.facts || []) if (f && String(f).trim()) saved.facts.push(addFact(f));
    for (const d of ex.directives || []) {
      if (d && d.text && String(d.text).trim()) saved.directives.push(addDirective(d.text, d.durationDays));
    }
  } catch (e) {
    log("error", `Chat memory extraction failed: ${e.message}`);
  }

  // 2) Awon replies — his system prompt already carries the just-updated
  //    memory (core/claude.js injects memoryBlock() into every think call).
  const history = getChat(10)
    .map((t) => `${t.role === "josh" ? "Josh" : "Awon"}: ${t.text}`)
    .join("\n");
  const timed = saved.directives.some((d) => d.expiresAt);
  let reply;
  try {
    reply = await think({
      system: PERSONAS.awon,
      maxTokens: 500,
      prompt:
        `You're talking privately with Josh — your owner — in the dashboard chat. This is NOT ` +
        `content or a public post; it's your working relationship. He steers, you execute. ` +
        `Reply briefly (1-4 sentences), direct and real — a trusted operator, not a press release. ` +
        (saved.facts.length || saved.directives.length
          ? `You just saved this to memory, so acknowledge specifically what you'll now do or keep in mind` +
            (timed ? ` and roughly when it wraps up` : "") +
            `. `
          : "") +
        `If he asked a question, answer it plainly. Never invent numbers — if you don't know, say what you'll check.\n\n` +
        (history ? `RECENT CHAT:\n${history}\n\n` : "") +
        `JOSH JUST SAID: "${text}"`,
    });
  } catch (e) {
    log("error", `Chat reply failed: ${e.message}`);
    reply = `Got it — saved. I'll fold that into what I do next cycle.`;
  }

  const awonTurn = appendChat("awon", reply.trim());
  if (saved.facts.length || saved.directives.length) {
    log("decision", `Chat with Josh: saved ${saved.facts.length} fact(s), ${saved.directives.length} directive(s) to living memory.`);
  }
  return { reply: awonTurn, saved };
}
