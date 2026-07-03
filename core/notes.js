/**
 * core/notes.js — Josh's free-text notes to Awon
 *
 * Unlike blockers (which Awon raises when he's stuck), notes are
 * proactive: Josh can leave Awon an instruction or piece of context
 * at any time from the dashboard, without waiting for Awon to ask.
 * Awon reads unconsumed notes at the start of every cycle, folds them
 * into his strategic decision and product-agent prompts, and marks
 * them consumed once he's acted on them.
 *
 * Note shape:
 * {
 *   id          — unique ID
 *   createdAt   — when Josh left it
 *   text        — the raw note
 *   consumed    — false until Awon has read + acted on it in a cycle
 *   consumedAt  — timestamp of consumption
 *   response    — Awon's own short reply, written when he consumes the note
 *                 (null until then) — this is what makes it feel like an
 *                 actual interface instead of a one-way mailbox
 * }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTES_PATH = path.join(__dirname, "..", "data", "notes.json");

function load() {
  if (!fs.existsSync(NOTES_PATH)) {
    fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
    fs.writeFileSync(NOTES_PATH, JSON.stringify([], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(NOTES_PATH, "utf-8"));
}

function save(notes) {
  fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2));
}

/** Add a new note from Josh. Returns the note id. */
export function addNote(text) {
  if (!text || !text.trim()) throw new Error("Note text is required.");
  const notes = load();
  const note = {
    id: `note_${Date.now()}`,
    createdAt: new Date().toISOString(),
    text: text.trim(),
    consumed: false,
    consumedAt: null,
    response: null,
  };
  notes.push(note);
  save(notes);
  return note.id;
}

/** Get all notes Awon hasn't consumed yet (oldest first, so they're acted on in order). */
export function getUnconsumedNotes() {
  return load().filter((n) => !n.consumed);
}

/** Mark a note as consumed after a cycle has acted on it, with Awon's reply. */
export function markConsumed(id, response = null) {
  const notes = load();
  const note = notes.find((n) => n.id === id);
  if (note) {
    note.consumed = true;
    note.consumedAt = new Date().toISOString();
    if (response) note.response = response;
    save(notes);
  }
}

/** Get all notes (for dashboard display), newest first. */
export function getAllNotes() {
  return load().reverse();
}
