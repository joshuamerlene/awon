/**
 * core/chatMemory.js — Awon's living memory of the business (ported from Ally)
 *
 * Josh talks to Awon in the dashboard chat. Awon stores durable "facts"
 * (truths about the brand/business) and "directives" (things to DO or
 * emphasize, some time-boxed) here. memoryBlock() is injected into EVERY
 * system prompt via core/claude.js, so every strategic decision, product
 * description, and content plan reflects the latest word from Josh —
 * without a code change.
 *
 * Stored volume-backed at data/chat-memory.json (survives deploys).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "chat-memory.json");

const DEFAULTS = {
  facts: [],      // { id, text, createdAt }               durable truths
  directives: [], // { id, text, createdAt, expiresAt, active }  timed or standing orders
  chat: [],       // { id, role: 'josh'|'awon', text, at } the working conversation
};

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function read() {
  if (!fs.existsSync(FILE)) return structuredClone(DEFAULTS);
  try {
    return { ...structuredClone(DEFAULTS), ...JSON.parse(fs.readFileSync(FILE, "utf-8")) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function write(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  return data;
}

function update(fn) {
  const data = read();
  fn(data);
  return write(data);
}

// ── Memory ──────────────────────────────────────────────────────────────────

/** Currently-in-effect memory (expired/ended directives filtered out). */
export function activeMemory() {
  const now = Date.now();
  const store = read();
  const facts = store.facts || [];
  const directives = (store.directives || []).filter(
    (d) => d.active !== false && (!d.expiresAt || new Date(d.expiresAt).getTime() > now)
  );
  return { facts, directives };
}

/** Mark expired directives inactive so campaigns stop themselves on time. */
export function pruneExpired() {
  const now = Date.now();
  update((d) => {
    for (const dir of d.directives) {
      if (dir.active !== false && dir.expiresAt && new Date(dir.expiresAt).getTime() <= now) {
        dir.active = false;
        dir.endedAt = new Date().toISOString();
      }
    }
  });
}

/** The text block appended to every system prompt (see core/claude.js). */
export function memoryBlock() {
  const { facts, directives } = activeMemory();
  if (!facts.length && !directives.length) return "";
  const lines = [];
  if (facts.length) {
    lines.push("What you currently know about the business (told to you directly by Josh):");
    for (const f of facts) lines.push(`- ${f.text}`);
  }
  if (directives.length) {
    lines.push("\nActive directions from Josh — honor these in every decision, product, and post:");
    for (const d of directives) {
      const until = d.expiresAt
        ? ` (in effect until ${new Date(d.expiresAt).toLocaleDateString("en-US")})`
        : "";
      lines.push(`- ${d.text}${until}`);
    }
  }
  return lines.join("\n");
}

export function addFact(text) {
  const f = { id: id(), text: String(text).trim(), createdAt: new Date().toISOString() };
  update((d) => d.facts.push(f));
  return f;
}

export function addDirective(text, durationDays = null) {
  const days = Number(durationDays) > 0 ? Number(durationDays) : null;
  const dir = {
    id: id(),
    text: String(text).trim(),
    createdAt: new Date().toISOString(),
    expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
    active: true,
  };
  update((d) => d.directives.push(dir));
  return dir;
}

/** Drop a fact, or end a directive early. */
export function forget(itemId) {
  update((d) => {
    d.facts = d.facts.filter((f) => f.id !== itemId);
    const dir = d.directives.find((x) => x.id === itemId);
    if (dir) {
      dir.active = false;
      dir.endedAt = new Date().toISOString();
    }
  });
}

// ── Chat log ────────────────────────────────────────────────────────────────

export function getChat(limit = 100) {
  return read().chat.slice(-limit);
}

export function appendChat(role, text) {
  const turn = { id: id(), role, text: String(text).trim(), at: new Date().toISOString() };
  update((d) => {
    d.chat.push(turn);
    if (d.chat.length > 300) d.chat.splice(0, d.chat.length - 300);
  });
  return turn;
}
