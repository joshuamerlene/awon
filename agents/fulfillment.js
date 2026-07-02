/**
 * agents/fulfillment.js — CJ Dropshipping Fulfillment Agent
 *
 * Runs each cycle. For every paid + unfulfilled Shopify order:
 *   1. Identifies line items that are CJ-sourced (tagged cj_dropship)
 *   2. Creates a CJ fulfillment order for those items
 *   3. Logs the CJ order ID for tracking
 *
 * CJ products are identified by their Shopify product tags:
 *   cj_dropship  — marks a product as CJ-sourced
 *   cj_vid:<id>  — CJ variant UUID used to place the order
 *
 * This agent does NOT handle Printful/POD products — those auto-fulfill
 * via the Printful Shopify app.
 */

import { log } from "../core/logger.js";
import * as shopify from "../integrations/shopify.js";
import * as cj from "../integrations/cj.js";

// Shopify order fulfillment statuses we should act on
const UNFULFILLED = ["unfulfilled", "partial"];

export async function runFulfillmentAgent({ orders, memory }) {
  if (!cj.isConfigured()) {
    log("system", "Fulfillment agent skipped — CJ_API_KEY not set.");
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

  log("sub-agent", `Fulfillment agent: checking ${actionableOrders.length} order(s) for CJ items...`);

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

  // Track which Shopify orders we've already sent to CJ (persisted in memory)
  const alreadyFulfilled = new Set(memory.cjFulfilledOrderIds || []);

  for (const order of actionableOrders) {
    const shopifyOrderId = String(order.id);

    if (alreadyFulfilled.has(shopifyOrderId)) {
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

  // Check tracking on previously created CJ orders
  await updateTrackingInfo(memory);

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
