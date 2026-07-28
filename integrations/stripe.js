/**
 * integrations/stripe.js — Stripe invoicing (one-off clip deals + retainers)
 *
 * Josh creates the Stripe account himself (identity + bank verification —
 * a real login/money step, not something the agent can do). Once
 * STRIPE_SECRET_KEY is set, everything below runs autonomously: create the
 * client as a Customer, create + finalize + send an Invoice (Stripe emails
 * the client a hosted payment link automatically — no checkout page to
 * build), and poll status for reconciliation. Retainer clients use
 * Subscriptions instead of one-off Invoices so they auto-bill on schedule.
 *
 * Raw fetch against Stripe's REST API (no SDK) — same style as
 * integrations/printful.js elsewhere in this repo. Stripe's API takes
 * form-urlencoded bodies, not JSON.
 *
 * Docs: https://docs.stripe.com/api/invoices, https://docs.stripe.com/api/subscriptions
 */

const BASE = "https://api.stripe.com/v1";

export function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function authHeader() {
  return { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
}

function toForm(obj, prefix = "") {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of new URLSearchParams(toForm(value, name))) params.append(k, v);
    } else {
      params.append(name, value);
    }
  }
  return params;
}

async function stripeCall(method, path, body) {
  if (!isConfigured()) throw new Error("STRIPE_SECRET_KEY not set.");
  const opts = { method, headers: authHeader() };
  if (body) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = toForm(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} failed: ${data.error?.message || res.status}`);
  return data;
}

/** Find or create a Stripe Customer for a client by email. */
export async function findOrCreateCustomer({ email, name }) {
  const search = await stripeCall("GET", `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (search.data?.length > 0) return search.data[0];
  return stripeCall("POST", "/customers", { email, name });
}

/**
 * Create, finalize, and send a one-off invoice for a clip deliverable or
 * project fee. Stripe auto-emails the client a hosted payment page —
 * hosted_invoice_url is also returned in case it needs to go out through
 * our own outreach email instead.
 */
export async function createAndSendInvoice({ customerId, description, amountUsd, dueInDays = 7 }) {
  await stripeCall("POST", "/invoiceitems", {
    customer: customerId,
    amount: Math.round(amountUsd * 100),
    currency: "usd",
    description,
  });

  const invoice = await stripeCall("POST", "/invoices", {
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: dueInDays,
    auto_advance: true,
  });

  const finalized = await stripeCall("POST", `/invoices/${invoice.id}/finalize`, {});
  const sent = await stripeCall("POST", `/invoices/${invoice.id}/send`, {});

  return {
    invoiceId: sent.id,
    hostedInvoiceUrl: sent.hosted_invoice_url,
    amountDueUsd: (sent.amount_due || 0) / 100,
    status: sent.status,
    dueDate: sent.due_date ? new Date(sent.due_date * 1000).toISOString() : null,
    finalizedStatus: finalized.status,
  };
}

/** Check a specific invoice's payment status — used for revenue reconciliation each cycle. */
export async function getInvoiceStatus(invoiceId) {
  const invoice = await stripeCall("GET", `/invoices/${invoiceId}`, null);
  return {
    id: invoice.id,
    status: invoice.status, // draft | open | paid | uncollectible | void
    paid: invoice.status === "paid",
    amountPaidUsd: (invoice.amount_paid || 0) / 100,
    amountDueUsd: (invoice.amount_due || 0) / 100,
  };
}

/** List recently updated invoices — used each cycle to catch newly-paid ones without tracking every ID by hand. */
export async function listRecentInvoices({ limit = 20 } = {}) {
  const res = await stripeCall("GET", `/invoices?limit=${limit}`, null);
  return (res.data || []).map((invoice) => ({
    id: invoice.id,
    customerId: invoice.customer,
    status: invoice.status,
    paid: invoice.status === "paid",
    amountPaidUsd: (invoice.amount_paid || 0) / 100,
    amountDueUsd: (invoice.amount_due || 0) / 100,
    description: invoice.lines?.data?.[0]?.description || "",
    created: new Date(invoice.created * 1000).toISOString(),
  }));
}

/**
 * Set up a recurring retainer: a Stripe Price (flat monthly amount) plus a
 * Subscription on the client's Customer. Stripe auto-charges and auto-emails
 * on each billing cycle from here on — no per-month manual invoicing.
 */
export async function createRetainerSubscription({ customerId, monthlyAmountUsd, description }) {
  const product = await stripeCall("POST", "/products", { name: description });
  const price = await stripeCall("POST", "/prices", {
    product: product.id,
    unit_amount: Math.round(monthlyAmountUsd * 100),
    currency: "usd",
    recurring: { interval: "month" },
  });
  const subscription = await stripeCall("POST", "/subscriptions", {
    customer: customerId,
    items: { "0": { price: price.id } },
    collection_method: "send_invoice",
    days_until_due: 7,
  });
  return { subscriptionId: subscription.id, priceId: price.id, status: subscription.status };
}
