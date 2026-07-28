/**
 * core/clients.js — prospect/client/deal tracking
 *
 * Replaces the old "createdPODProducts" catalog concept with what this
 * business actually runs on: a pipeline of prospects → contacted →
 * active clients, each with a deal type (one-off project, per-clip rate, or
 * monthly retainer) and running payout status. Persisted the same way as
 * memory.js/ledger.js — a JSON file on the Railway Volume.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS_PATH = path.join(__dirname, "..", "data", "clients.json");

function load() {
  if (!fs.existsSync(CLIENTS_PATH)) {
    fs.mkdirSync(path.dirname(CLIENTS_PATH), { recursive: true });
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify([], null, 2));
    return [];
  }
  return JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf-8"));
}

function save(clients) {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(clients, null, 2));
}

export function getAllClients() {
  return load();
}

export function getClient(id) {
  return load().find((c) => c.id === id) || null;
}

/**
 * Add a prospect Awon has sourced (outreach agent) or a real client Josh has
 * closed by hand. status starts at "prospect" unless overridden.
 */
export function addClient({ name, contactEmail, sourceChannel, dealType, rateUsd, notes, status = "prospect" }) {
  const clients = load();
  const client = {
    id: `client_${Date.now()}`,
    createdAt: new Date().toISOString(),
    name,
    contactEmail: contactEmail || null,
    sourceChannel: sourceChannel || null, // e.g. "tiktok-ads-library", "youtube-scout", "referral"
    status, // prospect | contacted | negotiating | active | churned
    dealType: dealType || null, // "project" | "per-clip" | "retainer"
    rateUsd: rateUsd || null,
    stripeCustomerId: null,
    notes: notes || "",
    rightsAuthorized: false, // must be explicitly true before any footage from this client gets cut — see rightsReviewer persona
    outreach: [], // { date, channel, summary }
    invoices: [], // { invoiceId, amountUsd, status, sentAt }
    footageSubmissions: [], // { id, url, status: queued|processing|ready|delivered, vizardProjectId, submittedAt }
    clipsDelivered: 0,
    totalPaidUsd: 0,
  };
  clients.push(client);
  save(clients);
  return client;
}

export function updateClient(id, patch) {
  const clients = load();
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error(`Client ${id} not found.`);
  Object.assign(client, patch);
  save(clients);
  return client;
}

export function logOutreach(id, { channel, summary }) {
  const clients = load();
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error(`Client ${id} not found.`);
  client.outreach.push({ date: new Date().toISOString(), channel, summary });
  if (client.status === "prospect") client.status = "contacted";
  save(clients);
  return client;
}

export function attachInvoice(id, { invoiceId, amountUsd, hostedInvoiceUrl }) {
  const clients = load();
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error(`Client ${id} not found.`);
  client.invoices.push({ invoiceId, amountUsd, hostedInvoiceUrl, status: "open", sentAt: new Date().toISOString() });
  save(clients);
  return client;
}

/** Mark an invoice paid (called during revenue reconciliation) and roll it into the client's totals. */
export function markInvoicePaid(invoiceId, amountPaidUsd) {
  const clients = load();
  for (const client of clients) {
    const invoice = client.invoices.find((inv) => inv.invoiceId === invoiceId);
    if (invoice && invoice.status !== "paid") {
      invoice.status = "paid";
      invoice.paidAt = new Date().toISOString();
      client.totalPaidUsd = (client.totalPaidUsd || 0) + amountPaidUsd;
      if (client.status !== "active") client.status = "active";
      save(clients);
      return client;
    }
  }
  return null;
}

/** Add a footage URL the client has shared (a YouTube or Google Drive link — Vizard does not support Dropbox as a source). */
export function addFootageSubmission(clientId, { url }) {
  const clients = load();
  const client = clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Client ${clientId} not found.`);
  const submission = { id: `footage_${Date.now()}`, url, status: "queued", vizardProjectId: null, submittedAt: new Date().toISOString() };
  client.footageSubmissions.push(submission);
  save(clients);
  return submission;
}

export function updateFootageSubmission(clientId, submissionId, patch) {
  const clients = load();
  const client = clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Client ${clientId} not found.`);
  const submission = client.footageSubmissions.find((s) => s.id === submissionId);
  if (!submission) throw new Error(`Footage submission ${submissionId} not found.`);
  Object.assign(submission, patch);
  save(clients);
  return submission;
}

/** All footage submissions across all clients in a given status, flattened with clientId/clientName attached. */
export function getFootageByStatus(status) {
  const clients = load();
  const results = [];
  for (const client of clients) {
    for (const submission of client.footageSubmissions || []) {
      if (submission.status === status) {
        results.push({ ...submission, clientId: client.id, clientName: client.name, rightsAuthorized: !!client.rightsAuthorized });
      }
    }
  }
  return results;
}

export function getProspects() {
  return load().filter((c) => c.status === "prospect");
}

export function getActiveClients() {
  return load().filter((c) => c.status === "active" || c.status === "negotiating");
}
