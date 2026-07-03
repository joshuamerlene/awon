/**
 * core/ledger.js — Budget enforcement, funded like a real account
 *
 * Every dollar Awon spends flows through here first.
 * Reinvestment ratchet (his cut of confirmed net profit):
 *   budget < $50   → 70% of net profit reinvested
 *   budget $50-150 → 50% reinvested
 *   budget > $150  → 30% reinvested
 * The rest is tracked as ownerPayoutOwedUsd — Josh's share.
 *
 * Two ways money enters the account:
 *   1. addFunds() — Josh manually topping up with real money (e.g. the
 *      monthly $10 he fronts). Tracked separately as cumulativeFundedUsd.
 *   2. recordRevenue() — Awon's own reinvested cut of confirmed sales.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "..", "data", "ledger.json");

// NOTE: Railway's env var for this is STARTING_BUDGET_USD. BASE_BUDGET_USD is
// kept as a fallback alias in case it's ever used instead — whichever is set wins.
const STARTING_BUDGET = Number(process.env.STARTING_BUDGET_USD || process.env.BASE_BUDGET_USD || 10);

const DEFAULT_STATE = {
  baseBudgetUsd: STARTING_BUDGET,
  availableBudgetUsd: STARTING_BUDGET,
  ownerPayoutOwedUsd: 0,
  cumulativeNetProfitUsd: 0,
  cumulativeSpendUsd: 0,
  cumulativeFundedUsd: STARTING_BUDGET, // total real $ Josh has put in, including this starting amount
  adSubBudgetMaxPercent: Number(process.env.AD_SUBBUDGET_MAX_PERCENT || 40),
  transactions: [],
};

function load() {
  if (!fs.existsSync(LEDGER_PATH)) {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(DEFAULT_STATE, null, 2));
    return { ...DEFAULT_STATE };
  }
  return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
}

function save(state) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(state, null, 2));
}

function reinvestRate(available) {
  if (available < 50) return 0.7;
  if (available <= 150) return 0.5;
  return 0.3;
}

export class Ledger {
  constructor() { this.state = load(); }
  refresh() { this.state = load(); return this.state; }
  getAvailable() { return this.state.availableBudgetUsd; }
  getAdCap() { return (this.state.adSubBudgetMaxPercent / 100) * this.state.availableBudgetUsd; }

  canSpend(amount, category) {
    if (amount <= 0) return { allowed: false, reason: "Amount must be positive." };
    if (amount > this.state.availableBudgetUsd)
      return { allowed: false, reason: `$${amount} exceeds available $${this.state.availableBudgetUsd.toFixed(2)}.` };
    if (category === "ad_promotion") {
      const cap = this.getAdCap();
      const spent = this.state.transactions
        .filter((t) => t.type === "spend" && t.category === "ad_promotion")
        .reduce((s, t) => s + t.amount, 0);
      if (spent + amount > cap)
        return { allowed: false, reason: `Ad cap: $${spent.toFixed(2)} spent, cap $${cap.toFixed(2)}.` };
    }
    return { allowed: true };
  }

  recordSpend(amount, category, note = "") {
    const check = this.canSpend(amount, category);
    if (!check.allowed) throw new Error(`Spend rejected: ${check.reason}`);
    this.state.availableBudgetUsd -= amount;
    this.state.cumulativeSpendUsd += amount;
    this.state.transactions.push({ date: new Date().toISOString(), type: "spend", amount, category, note });
    save(this.state);
  }

  /**
   * Josh manually topping up Awon's budget with real money he's putting in
   * (e.g. the monthly $10). This is separate from reinvested profit — it's
   * new money from outside the business.
   */
  addFunds(amount, note = "") {
    if (amount <= 0) throw new Error("Amount must be positive.");
    this.state.availableBudgetUsd += amount;
    this.state.cumulativeFundedUsd = (this.state.cumulativeFundedUsd || 0) + amount;
    this.state.transactions.push({ date: new Date().toISOString(), type: "funding", amount, note: note || "Manual top-up from Josh" });
    save(this.state);
    return this.getSummary();
  }

  /**
   * Josh has actually taken his owed payout out (transferred it to himself
   * outside the app). Zeroes the running "owed" number so it reflects reality.
   */
  clearPayout(note = "") {
    const cleared = this.state.ownerPayoutOwedUsd;
    if (cleared <= 0) return this.getSummary();
    this.state.transactions.push({ date: new Date().toISOString(), type: "payout_cleared", amount: cleared, note: note || "Payout taken by Josh" });
    this.state.ownerPayoutOwedUsd = 0;
    save(this.state);
    return this.getSummary();
  }

  recordRevenue(revenue, cogs, note = "") {
    const net = revenue - cogs;
    const rate = reinvestRate(this.state.availableBudgetUsd);
    const reinvested = Math.max(0, net) * rate;
    const ownerShare = Math.max(0, net) - reinvested;
    this.state.availableBudgetUsd += reinvested;
    this.state.ownerPayoutOwedUsd += ownerShare;
    this.state.cumulativeNetProfitUsd += net;
    this.state.transactions.push({ date: new Date().toISOString(), type: "revenue", amount: revenue, cogs, net, reinvested, ownerShare, note });
    save(this.state);
  }

  getSummary() {
    return {
      availableBudgetUsd: +this.state.availableBudgetUsd.toFixed(2),
      ownerPayoutOwedUsd: +this.state.ownerPayoutOwedUsd.toFixed(2),
      cumulativeNetProfitUsd: +this.state.cumulativeNetProfitUsd.toFixed(2),
      cumulativeSpendUsd: +this.state.cumulativeSpendUsd.toFixed(2),
      cumulativeFundedUsd: +(this.state.cumulativeFundedUsd || 0).toFixed(2),
      adCapUsd: +this.getAdCap().toFixed(2),
      txCount: this.state.transactions.length,
    };
  }
}
