/**
 * integrations/cj.js — CJ Dropshipping API
 *
 * Handles:
 *   - Auth (apiKey → access token, cached in memory)
 *   - Product search & discovery
 *   - Adding products to CJ account + creating Shopify listings
 *   - Order fulfillment (create CJ order from a paid Shopify order)
 *   - Order status queries
 *
 * Required env vars:
 *   CJ_API_KEY  — from https://www.cjdropshipping.com/myCJ.html#/apikey
 *
 * CJ variant IDs are stored on Shopify products as tags:
 *   cj_vid:<variant_id>   — CJ variant UUID
 *   cj_pid:<product_id>   — CJ product UUID
 */

const BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const API_KEY = process.env.CJ_API_KEY;

// In-memory token cache — token is valid 15 days, same token returned within 24h
let _token = null;
let _tokenExpiry = 0;

export function isConfigured() {
  return !!API_KEY;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getToken() {
  if (!API_KEY) throw new Error("CJ_API_KEY not set — CJ offline.");

  // Return cached token if still valid (refresh 1h early)
  if (_token && Date.now() < _tokenExpiry - 3_600_000) return _token;

  const res = await fetch(`${BASE}/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: API_KEY }),
  });
  const data = await res.json();
  if (!data.result) throw new Error(`CJ auth failed: ${data.message}`);

  _token = data.data.accessToken;
  // accessTokenExpiryDate is ISO string — parse it
  _tokenExpiry = new Date(data.data.accessTokenExpiryDate).getTime();
  return _token;
}

async function cjFetch(path, options = {}) {
  const token = await getToken();
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "CJ-Access-Token": token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!data.result && data.code !== 200) {
    throw new Error(`CJ ${res.status} on ${options.method || "GET"} ${path}: ${data.message} (code ${data.code})`);
  }
  return data.data;
}

// ── Product Discovery ─────────────────────────────────────────────────────────

/**
 * Search CJ's catalog.
 * Returns array of products (nameEn, id/pid, sku, sellPrice, bigImage, etc.)
 */
export async function searchProducts({ keyword, page = 1, size = 20, categoryId, trending = false } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    ...(keyword ? { keyWord: keyword } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(trending ? { productFlag: "0" } : {}), // 0 = trending
    orderBy: "1", // sort by listing count (popularity)
    sort: "desc",
  });
  const data = await cjFetch(`/product/listV2?${params}`);
  // V2 wraps results in content[0].productList
  return data?.content?.[0]?.productList || [];
}

/**
 * Get full details for a CJ product (includes variants, images, description).
 */
export async function getProductDetails(pid) {
  const data = await cjFetch(`/product/query?pid=${pid}`);
  return data;
}

/**
 * Get all variants for a CJ product.
 */
export async function getProductVariants(pid) {
  const data = await cjFetch(`/product/variant/query?pid=${pid}`);
  return data?.variantList || [];
}

/**
 * Add a CJ product to your CJ account ("my products").
 * Required before you can create orders for it.
 */
export async function addToMyProducts(pid) {
  const data = await cjFetch("/product/addToMyProduct", {
    method: "POST",
    body: JSON.stringify({ pid }),
  });
  return data;
}

/**
 * Get categories from CJ (for targeted searching).
 * Returns nested category list.
 */
export async function getCategories() {
  const data = await cjFetch("/product/getCategory");
  return data || [];
}

// ── Shopify Product Creation from CJ ─────────────────────────────────────────

/**
 * Build a Shopify product payload from a CJ product.
 * Caller (product agent) should pass this to shopify.createProduct().
 * Tags include cj_pid and cj_vid for the default variant so fulfillment
 * agent can route orders back to CJ.
 */
export function buildShopifyProduct(cjProduct, { retailMultiplier = 2.5, brand = "The Rival Is Me" } = {}) {
  const variants = (cjProduct.variantList || []).map(v => {
    const cost = parseFloat(v.sellPrice || cjProduct.sellPrice || 0);
    const price = (cost * retailMultiplier).toFixed(2);
    return {
      option1: v.variantNameEn || v.sku,
      price,
      sku: v.sku,
      // Store CJ variant ID in SKU prefix so fulfillment can find it
      // Also stored in product tags below
      inventory_management: null, // no inventory tracking — CJ ships on demand
      requires_shipping: true,
    };
  });

  // Default to single variant if no variant list
  if (variants.length === 0) {
    const cost = parseFloat(cjProduct.sellPrice || 0);
    variants.push({
      price: (cost * retailMultiplier).toFixed(2),
      sku: cjProduct.sku,
      inventory_management: null,
      requires_shipping: true,
    });
  }

  // Build tag list — includes CJ IDs for fulfillment routing
  const defaultVid = cjProduct.variantList?.[0]?.vid || "";
  const tags = [
    `cj_pid:${cjProduct.id}`,
    ...(defaultVid ? [`cj_vid:${defaultVid}`] : []),
    "cj_dropship",
    "fitness",
  ].join(", ");

  return {
    title: cjProduct.nameEn,
    body_html: cjProduct.description || cjProduct.nameEn,
    vendor: brand,
    product_type: cjProduct.threeCategoryName || "Supplement",
    tags,
    images: cjProduct.bigImage ? [{ src: cjProduct.bigImage }] : [],
    variants,
    options: variants.length > 1 ? [{ name: "Variant", values: variants.map(v => v.option1) }] : [],
    status: "active",
  };
}

// ── Order Fulfillment ─────────────────────────────────────────────────────────

/**
 * Extract CJ variant ID from a Shopify product's tags.
 * Returns null if this product isn't a CJ product.
 */
export function extractCJVidFromTags(tagsString = "") {
  const match = tagsString.match(/cj_vid:([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

export function isCJProduct(tagsString = "") {
  return tagsString.includes("cj_dropship");
}

/**
 * Create a fulfillment order in CJ from a paid Shopify order.
 *
 * @param {object} shopifyOrder - Full Shopify order object
 * @param {Array}  lineItems    - [{vid, sku, quantity, storeLineItemId}] — CJ items only
 * @param {string} logisticName - CJ logistics service name (default: "CJPacket Ordinary")
 *
 * Returns the CJ orderId.
 */
export async function createFulfillmentOrder(shopifyOrder, lineItems, { logisticName = "CJPacket Ordinary" } = {}) {
  const addr = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};

  const payload = {
    orderNumber: String(shopifyOrder.order_number || shopifyOrder.id),
    shippingCustomerName: addr.name || `${addr.first_name || ""} ${addr.last_name || ""}`.trim(),
    shippingAddress: addr.address1 || "",
    shippingAddress2: addr.address2 || "",
    shippingCity: addr.city || "",
    shippingProvince: addr.province || addr.province_code || "",
    shippingCountry: addr.country || "",
    shippingCountryCode: addr.country_code || "US",
    shippingZip: addr.zip || "",
    shippingPhone: addr.phone || shopifyOrder.phone || "",
    email: shopifyOrder.email || "",
    logisticName,
    fromCountryCode: "CN",
    platform: "shopify",
    orderFlow: 1,
    products: lineItems.map(item => ({
      vid: item.vid,
      sku: item.sku,
      quantity: item.quantity,
      storeLineItemId: String(item.storeLineItemId || ""),
    })),
  };

  const data = await cjFetch("/shopping/order/createOrderV2", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return data?.orderId || data;
}

/**
 * Get status of a CJ order.
 */
export async function getOrderStatus(cjOrderId) {
  const data = await cjFetch(`/shopping/order/getOrderDetail?orderId=${cjOrderId}`);
  return {
    orderId: data?.orderId,
    status: data?.orderStatus,
    trackingNumber: data?.trackingNumber,
    trackingProvider: data?.trackingProvider,
    shippingStatus: data?.shippingStatus,
  };
}

/**
 * List recent CJ orders.
 */
export async function listOrders({ page = 1, size = 20 } = {}) {
  const data = await cjFetch(`/shopping/order/list?pageNum=${page}&pageSize=${size}`);
  return data?.list || [];
}
