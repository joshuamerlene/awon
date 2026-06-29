/**
 * integrations/printify.js — Printify Print-on-Demand API
 *
 * Awon uses Printify to create and publish fitness apparel/gear to Shopify.
 * All fulfillment is handled by Printify — fully hands-off.
 *
 * Required env vars:
 *   PRINTIFY_API_KEY   — from printify.com/app/account/api-access
 *   PRINTIFY_SHOP_ID   — Shopify shop ID in Printify (auto-detected on first call)
 */

const BASE = "https://api.printify.com/v1";
const TOKEN = () => process.env.PRINTIFY_API_KEY;

import { log } from "../core/logger.js";

let _shopId = null;

async function req(path, options = {}) {
  if (!TOKEN()) throw new Error("PRINTIFY_API_KEY not set.");
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Printify ${res.status} on ${options.method || "GET"} ${path}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Shop ─────────────────────────────────────────────────────────────────────

export async function getShops() {
  return req("/shops.json");
}

/**
 * Returns the Printify shop ID linked to the Shopify store.
 * Auto-detected from env var PRINTIFY_SHOP_ID or by fetching shops list.
 */
export async function getShopId() {
  if (_shopId) return _shopId;
  if (process.env.PRINTIFY_SHOP_ID) {
    _shopId = process.env.PRINTIFY_SHOP_ID;
    return _shopId;
  }
  const shops = await getShops();
  if (!shops || shops.length === 0) throw new Error("No Printify shops found. Connect your Shopify store in printify.com.");
  _shopId = String(shops[0].id);
  log("system", `Printify shop auto-detected: ${_shopId} (${shops[0].title})`);
  return _shopId;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

/**
 * Search Printify's blueprint catalog by keyword.
 * Returns array of blueprints matching the query.
 */
export async function searchCatalog(keyword) {
  const blueprints = await req("/catalog/blueprints.json");
  if (!Array.isArray(blueprints)) return [];
  const kw = keyword.toLowerCase();
  return blueprints.filter(b =>
    b.title?.toLowerCase().includes(kw) ||
    b.description?.toLowerCase().includes(kw) ||
    b.brand?.toLowerCase().includes(kw)
  ).slice(0, 20);
}

/**
 * Get all blueprints (full catalog).
 */
export async function getCatalog() {
  return req("/catalog/blueprints.json");
}

/**
 * Get print providers for a blueprint.
 */
export async function getPrintProviders(blueprintId) {
  return req(`/catalog/blueprints/${blueprintId}/print_providers.json`);
}

/**
 * Get variants for a specific blueprint + print provider.
 */
export async function getVariants(blueprintId, printProviderId) {
  return req(`/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`);
}

// ── Products ──────────────────────────────────────────────────────────────────

/**
 * Get all products in the Printify shop.
 */
export async function getProducts() {
  const shopId = await getShopId();
  const data = await req(`/shops/${shopId}/products.json?limit=100`);
  return data?.data || [];
}

/**
 * Create a new print-on-demand product in Printify.
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.description  — HTML or plain text
 * @param {number} opts.blueprintId  — blueprint ID from catalog
 * @param {number} opts.printProviderId
 * @param {Array}  opts.variants     — [{ id: variantId, price: priceInCents, is_enabled: true }]
 * @param {Array}  opts.printAreas   — print area placeholders (see Printify docs)
 * @param {Array}  opts.images       — [{ src: "https://...", position: "front" }]
 */
export async function createProduct({ title, description, blueprintId, printProviderId, variants, printAreas, images = [] }) {
  const shopId = await getShopId();

  const body = {
    title,
    description,
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    variants,
    print_areas: printAreas || [
      {
        variant_ids: variants.map(v => v.id),
        placeholders: [
          {
            position: "front",
            images,
          },
        ],
      },
    ],
  };

  const product = await req(`/shops/${shopId}/products.json`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  log("action", `Printify product created: "${title}" (ID: ${product.id})`);
  return product;
}

/**
 * Publish a Printify product to Shopify.
 * After this, the product appears in the Shopify storefront.
 */
export async function publishProduct(printifyProductId) {
  const shopId = await getShopId();
  const result = await req(`/shops/${shopId}/products/${printifyProductId}/publish.json`, {
    method: "POST",
    body: JSON.stringify({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    }),
  });
  log("action", `Printify product ${printifyProductId} published to Shopify`);
  return result;
}

/**
 * Update an existing Printify product.
 */
export async function updateProduct(printifyProductId, updates) {
  const shopId = await getShopId();
  return req(`/shops/${shopId}/products/${printifyProductId}.json`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

/**
 * Delete a Printify product (removes from Printify AND Shopify).
 */
export async function deleteProduct(printifyProductId) {
  const shopId = await getShopId();
  await req(`/shops/${shopId}/products/${printifyProductId}.json`, { method: "DELETE" });
  log("action", `Printify product ${printifyProductId} deleted`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * One-shot: find a blueprint by keyword, pick the best US print provider,
 * and return { blueprintId, printProviderId, variants } ready for createProduct().
 *
 * Picks the first US-based provider, or first provider if none are US-based.
 */
export async function resolveBlueprintForKeyword(keyword) {
  const matches = await searchCatalog(keyword);
  if (matches.length === 0) throw new Error(`No Printify blueprint found for keyword: "${keyword}"`);

  const blueprint = matches[0];
  const providers = await getPrintProviders(blueprint.id);

  // Prefer US-based
  const usProviders = providers.filter(p => p.location?.country === "US" || p.title?.toLowerCase().includes("us"));
  const provider = usProviders[0] || providers[0];

  const variantsData = await getVariants(blueprint.id, provider.id);

  return {
    blueprintId: blueprint.id,
    blueprintTitle: blueprint.title,
    printProviderId: provider.id,
    providerTitle: provider.title,
    variants: variantsData?.variants || [],
  };
}

/**
 * Is Printify configured?
 */
export function isConfigured() {
  return !!process.env.PRINTIFY_API_KEY;
}
