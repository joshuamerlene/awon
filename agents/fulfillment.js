/**
 * agents/fulfillment.js — Fulfillment Agent (CJ Dropshipping + Printful POD)
 *
 * Runs each cycle. For every paid + unfulfilled Shopify order:
 *   1. Identifies line items that are CJ-sourced (tagged cj_dropship)
 *      or Printful POD (tagged pf_dropship, SKU "PF-<catalog_variant_id>")
 *   2. Creates the corresponding CJ / Printful fulfillment order
 *   3. Logs the supplier order ID and polls tracking on later cycles
 *
 * Printful orders are created as DRAFTS unless PRINTFUL_AUTO_CONFIRM=1 —
 * confirming an order charges the Printful billing method on file.
 * (The Manual/API-platform store doesn't auto-fulfill Shopify orders;
 * Awon owns the storefront and submits orders itself, same as CJ.)
 */

import { log } from "../core/logger.js";
import { addBlockerOnce } from "../core/queue.js";
import * as shopify from "../integrations/shopify.js";
import * as cj from "../integrations/cj.js";
import * as printful from "../integrations/printful.js";
import * as design from "../integrations/design.js";

// Shopify order fulfillment statuses we should act on
const UNFULFILLED = ["unfulfilled", "partial"];

export async function runFulfillmentAgent({ orders, memory }) {
  if (!cj.isConfigured() && !printful.isConfigured()) {
    log("system", "Fulfillment agent skipped — neither CJ_API_KEY nor PRINTFUL_API_KEY set.");
    return { fulfilled: 0, skipped: 0, errors: [] };
  }

  const errors = [];
  let fulfilled = 0;
  let skipped = 0;

  // Only process paid orders that still need fulfillment
  const actionableOrders = orders.filter(
    o => o.financial_status === "paid" && UNFULFILLED.includes(o.fulfillment_status || "unfulfilled")
  );

  if (actionableOrders.length === 0) {
    log("sub-agent", "Fulfillment agent: no paid+unfulfilled orders this cycle.");
    return { fulfilled: 0, skipped: 0, errors: [] };
  }

  log("sub-agent", `Fulfillment agent: checking ${actionableOrders.length} order(s) for CJ/Printful items...`);

  // Load all products once to check tags (avoid N+1 fetches)
  let productTagMap = {}; // shopify product_id → tags string
  try {
    const products = await shopify.getProducts();
    for (const p of products) {
      productTagMap[String(p.id)] = p.tags || "";
    }
  } catch (err) {
    log("error", `Fulfillment agent: failed to load product catalog — ${err.message}`);
    return { fulfilled: 0, skipped: 0, errors: [err.message] };
  }

  // Track which Shopify orders we've already sent to each supplier (persisted in memory)
  const alreadyFulfilled = new Set(memory.cjFulfilledOrderIds || []);
  const alreadyFulfilledPF = new Set(memory.pfFulfilledOrderIds || []);

  // Resolve the print design once per run — Printful order items need the file
  let pfDesignUrl = null;
  if (printful.isConfigured()) {
    try {
      pfDesignUrl = process.env.PRINTFUL_DESIGN_URL || await shopify.getStoreLogoUrl();
    } catch { /* handled per-order below */ }
  }

  for (const order of actionableOrders) {
    const shopifyOrderId = String(order.id);

    // ── Printful POD items ─────────────────────────────────────────────────
    if (printful.isConfigured() && !alreadyFulfilledPF.has(shopifyOrderId)) {
      const pfItems = [];
      for (const item of order.line_items || []) {
        const tags = productTagMap[String(item.product_id || "")] || "";
        if (!printful.isPFProduct(tags)) continue;
        const variantId = printful.variantIdFromSku(item.sku);
        if (!variantId) {
          log("system", `Fulfillment: product ${item.product_id} tagged pf_dropship but SKU "${item.sku}" has no PF variant id — skipping item "${item.title}"`);
          continue;
        }
        pfItems.push({
          variantId,
          quantity: item.quantity,
          retailPrice: item.price,
          // Per-product design (e.g. a text design) — falls back to the
          // shared logo design inside createFulfillmentOrder when null.
          designUrl: design.getProductDesign(item.product_id) || undefined,
        });
      }

      if (pfItems.length > 0) {
        const autoConfirm = ["1", "true", "yes"].includes(String(process.env.PRINTFUL_AUTO_CONFIRM || "").toLowerCase());
        try {
          const pfOrder = await printful.createFulfillmentOrder(order, pfItems, {
            designUrl: pfDesignUrl,
            confirm: autoConfirm,
          });
          log("action", `Fulfillment: Printful order ${autoConfirm ? "submitted" : "created as DRAFT"} — Printful ID: ${pfOrder.id}, Shopify order #${order.order_number}`);

          alreadyFulfilledPF.add(shopifyOrderId);
          memory.pfFulfilledOrderIds = [...alreadyFulfilledPF];
          memory.pfOrderMap = memory.pfOrderMap || {};
          memory.pfOrderMap[shopifyOrderId] = {
            printfulOrderId: pfOrder.id,
            shopifyOrderNumber: order.order_number,
            createdAt: new Date().toISOString(),
            status: pfOrder.status || (autoConfirm ? "pending" : "draft"),
          };
          fulfilled++;

          if (!autoConfirm) {
            addBlockerOnce({
              title: "A Printful order is waiting as a draft — confirm it to ship",
              context: `A customer paid for POD item(s) on Shopify order #${order.order_number}. I created Printful order ${pfOrder.id} as a DRAFT because PRINTFUL_AUTO_CONFIRM isn't enabled. Confirm it in the Printful dashboard (Orders) to start fulfillment — confirming charges your Printful billing method. To let me submit future orders automatically, set PRINTFUL_AUTO_CONFIRM=1 in Railway.`,
              options: ["I confirmed the order in Printful", "I set PRINTFUL_AUTO_CONFIRM=1 in Railway"],
              thread: "Once confirmed, I'll track shipping and report the tracking number here.",
            });
          }
        } catch (err) {
          const msg = `Printful fulfillment failed for Shopify order #${order.order_number}: ${err.message}`;
          log("error", msg);
          errors.push(msg);
        }
      }
    }

    // ── CJ dropship items ──────────────────────────────────────────────────
    if (!cj.isConfigured() || alreadyFulfilled.has(shopifyOrderId)) {
      skipped++;
      continue;
    }

    // Find line items that are CJ products
    const cjLineItems = [];
    for (const item of order.line_items || []) {
      const productId = String(item.product_id || "");
      const tags = productTagMap[productId] || "";

      if (!cj.isCJProduct(tags)) continue;

      // Get CJ variant ID from tags
      const vid = cj.extractCJVidFromTags(tags);
      if (!vid) {
        log("system", `Fulfillment: product ${productId} tagged cj_dropship but missing cj_vid — skipping item "${item.title}"`);
        continue;
      }

      cjLineItems.push({
        vid,
        sku: item.sku || "",
        quantity: item.quantity,
        storeLineItemId: item.id,
      });
    }

    if (cjLineItems.length === 0) {
      // Order has no CJ items — skip silently
      skipped++;
      continue;
    }

    // Determine best logistics for this order
    const countryCode = order.shipping_address?.country_code || "US";
    const logisticName = getLogisticName(countryCode, cjLineItems);

    try {
      log("sub-agent", `Fulfillment: creating CJ order for Shopify order #${order.order_number} (${cjLineItems.length} CJ item(s), logistics: ${logisticName})`);

      const cjOrderId = await cj.createFulfillmentOrder(order, cjLineItems, { logisticName });

      log("action", `Fulfillment: CJ order created — CJ ID: ${cjOrderId}, Shopify order #${order.order_number}`);

      // Remember this order so we don't double-submit
      alreadyFulfilled.add(shopifyOrderId);
      memory.cjFulfilledOrderIds = [...alreadyFulfilled];

      // Store CJ order ID for tracking
      memory.cjOrderMap = memory.cjOrderMap || {};
      memory.cjOrderMap[shopifyOrderId] = {
        cjOrderId,
        shopifyOrderNumber: order.order_number,
        createdAt: new Date().toISOString(),
        status: "created",
      };

      fulfilled++;
    } catch (err) {
      const msg = `Fulfillment failed for Shopify order #${order.order_number}: ${err.message}`;
      log("error", msg);
      errors.push(msg);
    }
  }

  // Check tracking on previously created CJ + Printful orders
  await updateTrackingInfo(memory);
  await updatePrintfulTracking(memory);

  log("sub-agent", `Fulfillment agent done — fulfilled: ${fulfilled}, skipped: ${skipped}, errors: ${errors.length}`);
  return { fulfilled, skipped, errors };
}

/**
 * Poll CJ for tracking updates on in-flight orders and log them.
 * In a future iteration this would push tracking to Shopify fulfillments.
 */
async function updateTrackingInfo(memory) {
  const orderMap = memory.cjOrderMap || {};
  const pendingOrders = Object.entries(orderMap).filter(
    ([, v]) => v.status === "created" || v.status === "processing"
  );

  for (const [shopifyOrderId, entry] of pendingOrders) {
    try {
      const status = await cj.getOrderStatus(entry.cjOrderId);
      if (status.trackingNumber && status.trackingNumber !== memory.cjOrderMap[shopifyOrderId].trackingNumber) {
        log("action", `Fulfillment: tracking update for Shopify order — CJ order ${entry.cjOrderId}: ${status.trackingProvider} ${status.trackingNumber}`);
        memory.cjOrderMap[shopifyOrderId].trackingNumber = status.trackingNumber;
        memory.cjOrderMap[shopifyOrderId].trackingProvider = status.trackingProvider;
        memory.cjOrderMap[shopifyOrderId].status = status.status || "processing";
      }
    } catch {
      // Non-fatal — tracking check fails sometimes, will retry next cycle
    }
  }
}

/**
 * Poll Printful for status/tracking updates on in-flight orders.
 */
async function updatePrintfulTracking(memory) {
  const orderMap = memory.pfOrderMap || {};
  const pending = Object.entries(orderMap).filter(
    ([, v]) => !["fulfilled", "canceled", "archived"].includes(v.status)
  );

  for (const [shopifyOrderId, entry] of pending) {
    try {
      const status = await printful.getOrder(entry.printfulOrderId);
      if (status.status && status.status !== entry.status) {
        log("action", `Fulfillment: Printful order ${entry.printfulOrderId} status → ${status.status}`);
        memory.pfOrderMap[shopifyOrderId].status = status.status;
      }
      if (status.trackingNumber && status.trackingNumber !== entry.trackingNumber) {
        log("action", `Fulfillment: tracking update — Printful order ${entry.printfulOrderId}: ${status.trackingProvider} ${status.trackingNumber}`);
        memory.pfOrderMap[shopifyOrderId].trackingNumber = status.trackingNumber;
        memory.pfOrderMap[shopifyOrderId].trackingProvider = status.trackingProvider;
      }
    } catch {
      // Non-fatal — will retry next cycle
    }
  }
}

/**
 * Pick the best CJ logistics option based on destination and product type.
 * Supplements need "CJPacket Liquid" for some countries.
 */
function getLogisticName(countryCode, lineItems) {
  // Simple heuristic — expand as needed
  switch (countryCode) {
    case "US":
      return "CJPacket Ordinary";
    case "GB":
    case "DE":
    case "FR":
    case "IT":
    case "ES":
      return "CJPacket EU";
    case "CA":
      return "CJPacket Ordinary";
    case "AU":
      return "CJPacket Ordinary";
    default:
      return "CJPacket Ordinary";
  }
}
