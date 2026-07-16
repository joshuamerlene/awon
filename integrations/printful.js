/**
 * integrations/printful.js — Printful POD API (Manual Order / API platform)
 *
 * ARCHITECTURE (reworked 2026-07-12):
 * The old flow created "sync products" via POST /store/products and relied on
 * Printful pushing them to Shopify. That endpoint only works for Printful
 * stores on the Manual Order / API platform — it hard-fails (400) for
 * Shopify-platform stores, which is what killed every POD creation attempt.
 *
 * New flow mirrors the CJ integration — Awon owns the storefront:
 *   1. Search the Printful CATALOG for a product (catalog API is platform-agnostic)
 *   2. Generate a mockup (best-effort) and create the listing DIRECTLY on
 *      Shopify via the Shopify API. Variant SKUs carry the Printful catalog
 *      variant id as "PF-<variant_id>"; products are tagged "pf_dropship".
 *   3. When a customer pays, the fulfillment agent submits an order to
 *      Printful via POST /orders with the catalog variant_id + the print file.
 *
 * ONE-TIME SETUP (Josh):
 *   - In Printful: create a store of type "Manual order platform / API"
 *     (Stores → Choose platform → Manual order platform / API).
 *   - Make sure the API token has access to that store.
 *   - In Railway: set PRINTFUL_STORE_ID to the new store's ID
 *     (required for account-level tokens; see GET /stores).
 *   - Optional: set PRINTFUL_AUTO_CONFIRM=1 to auto-submit orders for
 *     fulfillment (charges the Printful billing method immediately).
 *     Default is DRAFT — orders wait in Printful for manual confirmation.
 *
 * Auth: Bearer token (PRINTFUL_API_KEY env var)
 * Docs: https://developers.printful.com/docs/
 */

import * as shopify from "./shopify.js";

const BASE_URL = "https://api.printful.com";

// Optional standalone design file. Falls back to the Shopify store logo at
// call sites (shopify.getStoreLogoUrl()).
const BRAND_PRINT_FILE_URL = process.env.PRINTFUL_DESIGN_URL || null;

// Fitness/apparel keyword → Printful catalog product ID map (common ones).
// Dead IDs are self-healing now: if a mapped ID 404s, searchCatalog() falls
// through to a live catalog search instead of throwing. (188 "tank" and
// 439 "joggers" both died this way — hardcoded catalog IDs rot.)
const KEYWORD_TO_CATALOG_MAP = {
  "t-shirt":        71,   // Unisex Staple T-Shirt (Bella+Canvas)
  "tshirt":         71,
  "tee":            71,
  "shirt":          71,
  "heavyweight":    145,  // Unisex Heavy Cotton Tee (Gildan)
  "hoodie":         380,  // Unisex Premium Hoodie
  "zip hoodie":     377,  // Unisex Full Zip Hoodie
  "sweatshirt":     381,  // Unisex Sweatshirt
  "shorts":         508,  // Men's Athletic Shorts
  "long sleeve":    422,  // Unisex Long Sleeve Shirt
  "cap":            75,   // Dad Hat / Baseball Cap
  "hat":            75,
  "beanie":         102,  // Beanie
  "mug":            19,   // White Glossy Mug
  "bottle":         524,  // Sports Bottle
  "water bottle":   524,
  "tote":           131,  // Tote Bag
  "bag":            131,
  "phone case":     47,   // Phone Case
  "notebook":       268,  // Spiral Notebook
  "journal":        268,
  "poster":         1,    // Poster
  "sticker":        358,  // Sticker
};

async function pf(path, options = {}) {
  const apiKey = process.env.PRINTFUL_API_KEY;
  if (!apiKey) throw new Error("PRINTFUL_API_KEY not set");

  const storeId = process.env.PRINTFUL_STORE_ID;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(storeId ? { "X-PF-Store-Id": storeId } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Printful ${options.method || "GET"} ${path} → ${res.status}: ${body}`);
  }

  const json = await res.json();
  return json.result ?? json;
}

/**
 * Lists Printful stores on the account — use to find PRINTFUL_STORE_ID.
 */
export async function getStores() {
  return pf("/stores");
}

/**
 * Searches the Printful catalog for products matching a keyword.
 * Returns an array of { id, title, type, brand, ... }
 */
export async function searchCatalog(keyword) {
  const kw = keyword.toLowerCase().trim();

  // Try keyword map first (fast, no scan needed) — but if the mapped catalog
  // ID has been retired (404), fall through to a live search instead of dying.
  const catalogId = Object.entries(KEYWORD_TO_CATALOG_MAP).find(([k]) =>
    kw.includes(k) || k.includes(kw)
  )?.[1];

  if (catalogId) {
    try {
      const detail = await pf(`/products/${catalogId}`);
      if (detail?.product) return [detail.product];
    } catch (err) {
      if (!/404/.test(err.message)) throw err;
      // mapped ID is dead — fall through to live catalog search
    }
  }

  const allProducts = await pf("/products");
  return allProducts.filter(p =>
    p.title?.toLowerCase().includes(kw) ||
    p.type?.toLowerCase().includes(kw) ||
    p.type_name?.toLowerCase().includes(kw)
  ).slice(0, 5);
}

/**
 * Resolves a keyword to a Printful catalog product + variants.
 * Returns: { catalogProductId, title, type, brand, variants[] }
 */
export async function resolveCatalogProductForKeyword(keyword) {
  const results = await searchCatalog(keyword);
  if (!results || results.length === 0) {
    throw new Error(`No Printful catalog products found for keyword: "${keyword}"`);
  }

  const catalogProduct = results[0];
  const detail = await pf(`/products/${catalogProduct.id}`);

  // Filter to brand-appropriate variants: dark colors and common sizes
  const variants = (detail.variants || []).filter(v => {
    const color = (v.color || "").toLowerCase();
    const size = (v.size || "").toUpperCase();
    const goodColor = color.includes("black") || color.includes("dark") || color.includes("grey") || color.includes("white");
    const goodSize = ["XS", "S", "M", "L", "XL", "2XL", "OS"].includes(size);
    return goodColor || goodSize;
  }).slice(0, 40);

  return {
    catalogProductId: catalogProduct.id,
    title: catalogProduct.title,
    type: catalogProduct.type,
    brand: catalogProduct.brand,
    variants: variants.length > 0 ? variants : (detail.variants || []).slice(0, 40),
  };
}

/**
 * Best-effort mockup generation. Creates a mockup task for the catalog
 * product with the design applied, polls briefly for the result, and returns
 * an array of mockup image URLs. Returns [] on any failure — callers fall
 * back to the catalog's stock variant image.
 */
export async function generateMockups(catalogProductId, variantIds, designUrl, { placement = "front", maxWaitMs = 90_000 } = {}) {
  // maxWaitMs was 25s — Printful mockup tasks routinely take 30-60s+, so
  // nearly every task "failed" by timeout, silently fell back to the blank
  // stock garment photo, and the whole storefront looked like undesigned
  // merch. 90s covers the real distribution; failures now log a reason
  // instead of vanishing.
  const fail = (reason) => {
    console.error(`[printful] Mockup generation failed for catalog ${catalogProductId}: ${reason} — falling back to stock (blank) product image.`);
    return [];
  };
  try {
    let task;
    try {
      task = await pf(`/mockup-generator/create-task/${catalogProductId}`, {
        method: "POST",
        body: JSON.stringify({
          variant_ids: variantIds.slice(0, 5),
          format: "jpg",
          files: [{ placement, image_url: designUrl }],
        }),
      });
    } catch (err) {
      // Some product types don't have a "front" placement (mugs etc.)
      task = await pf(`/mockup-generator/create-task/${catalogProductId}`, {
        method: "POST",
        body: JSON.stringify({
          variant_ids: variantIds.slice(0, 5),
          format: "jpg",
          files: [{ placement: "default", image_url: designUrl }],
        }),
      });
    }

    const taskKey = task?.task_key;
    if (!taskKey) return fail("no task_key returned from create-task");

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const result = await pf(`/mockup-generator/task?task_key=${encodeURIComponent(taskKey)}`);
      if (result?.status === "completed") {
        const urls = (result.mockups || []).map(m => m.mockup_url).filter(Boolean);
        if (urls.length === 0) return fail("task completed but returned no mockup URLs");
        return urls;
      }
      if (result?.status === "failed") {
        return fail(`task failed: ${result?.error || JSON.stringify(result).slice(0, 200)}`);
      }
    }
    return fail(`timed out after ${Math.round(maxWaitMs / 1000)}s`);
  } catch (err) {
    return fail(err.message);
  }
}

/**
 * Builds a Shopify product payload from a Printful catalog product.
 * Variant SKUs carry the Printful catalog variant id ("PF-<id>") so the
 * fulfillment agent can route paid orders back to Printful.
 */
export function buildShopifyProduct({ title, description, catalogProduct, retailPrice = 34.99, images = [], brand = "The Rival Is Me" }) {
  const seen = new Set();
  const shopifyVariants = [];

  const colors = [...new Set(catalogProduct.variants.map(v => v.color).filter(Boolean))];
  const sizes = [...new Set(catalogProduct.variants.map(v => v.size).filter(Boolean))];
  const useColor = colors.length > 1;
  const useSize = sizes.length > 1;

  for (const v of catalogProduct.variants) {
    // Shopify rejects duplicate option combinations — dedupe
    const key = `${useColor ? v.color : ""}|${useSize ? v.size : ""}`;
    if ((useColor || useSize) && seen.has(key)) continue;
    seen.add(key);

    const variant = {
      price: Number(retailPrice).toFixed(2),
      sku: `PF-${v.id}`,
      inventory_management: null, // Printful prints on demand
      requires_shipping: true,
    };
    if (useColor && useSize) { variant.option1 = v.color; variant.option2 = v.size; }
    else if (useSize) { variant.option1 = v.size; }
    else if (useColor) { variant.option1 = v.color; }
    shopifyVariants.push(variant);
    if (shopifyVariants.length >= 100) break; // Shopify variant cap
  }

  const options = [];
  if (useColor && useSize) options.push({ name: "Color" }, { name: "Size" });
  else if (useSize) options.push({ name: "Size" });
  else if (useColor) options.push({ name: "Color" });

  const fallbackImage = catalogProduct.variants.find(v => v.image)?.image;
  const imageUrls = images.length > 0 ? images : (fallbackImage ? [fallbackImage] : []);

  return {
    title,
    body_html: description || `<p>${title}</p><p>Built for the ones who chose discipline. #THERIVALISME</p>`,
    vendor: brand,
    product_type: catalogProduct.type || "Apparel",
    tags: [`pf_catalog_pid:${catalogProduct.catalogProductId}`, "pf_dropship", "pod", "fitness"].join(", "),
    images: imageUrls.slice(0, 4).map(src => ({ src })),
    variants: shopifyVariants,
    ...(options.length > 0 ? { options } : {}),
    status: "active",
  };
}

/**
 * Creates a POD product: mockup (best-effort) + Shopify listing.
 * Same signature the product agent and inner loop already use; returns the
 * created SHOPIFY product (callers only read .id).
 */
export async function createProduct({ title, description, catalogProductId, variants, retailPrice = 34.99, imageUrl }) {
  const designUrl = imageUrl || BRAND_PRINT_FILE_URL;
  if (!designUrl) {
    throw new Error("No design URL available (store logo unresolved and PRINTFUL_DESIGN_URL not set) — refusing to list a blank POD product.");
  }
  if (!variants || variants.length === 0) {
    throw new Error(`No variants available for catalog product ${catalogProductId}`);
  }

  const catalogProduct = { catalogProductId, variants, type: variants[0]?.product_type };
  const mockups = await generateMockups(catalogProductId, variants.map(v => v.id), designUrl);

  const payload = buildShopifyProduct({
    title,
    description,
    catalogProduct,
    retailPrice,
    images: mockups,
  });

  return shopify.createProduct(payload);
}

// ── Fulfillment ───────────────────────────────────────────────────────────────

export function isPFProduct(tagsString = "") {
  return tagsString.includes("pf_dropship");
}

/** Extract the Printful catalog variant id from a Shopify SKU ("PF-4012" → 4012). */
export function variantIdFromSku(sku = "") {
  const match = String(sku).match(/^PF-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Create a Printful order from a paid Shopify order.
 *
 * @param {object}  shopifyOrder — full Shopify order object
 * @param {Array}   items        — [{ variantId, quantity, retailPrice }] (PF items only)
 * @param {string}  designUrl    — print file URL for every item
 * @param {boolean} confirm      — submit for fulfillment immediately (charges billing).
 *                                 Default: draft (confirm manually in Printful).
 * Returns { id, status } of the Printful order.
 */
export async function createFulfillmentOrder(shopifyOrder, items, { designUrl, confirm = false } = {}) {
  // Items may carry their own designUrl (per-product designs, e.g. text
  // designs from integrations/design.js); the shared designUrl is the
  // fallback. Only fail if some item would end up with no print file at all.
  if (!designUrl && items.some(i => !i.designUrl)) {
    throw new Error("Printful fulfillment needs a design URL (store logo unresolved).");
  }

  const addr = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};
  const payload = {
    external_id: String(shopifyOrder.id),
    recipient: {
      name: addr.name || `${addr.first_name || ""} ${addr.last_name || ""}`.trim(),
      address1: addr.address1 || "",
      address2: addr.address2 || "",
      city: addr.city || "",
      state_code: addr.province_code || "",
      country_code: addr.country_code || "US",
      zip: addr.zip || "",
      phone: addr.phone || shopifyOrder.phone || "",
      email: shopifyOrder.email || "",
    },
    items: items.map(item => ({
      variant_id: item.variantId,
      quantity: item.quantity,
      retail_price: item.retailPrice != null ? String(item.retailPrice) : undefined,
      files: [{ url: item.designUrl || designUrl }],
    })),
  };

  const order = await pf(`/orders${confirm ? "?confirm=true" : ""}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { id: order?.id, status: order?.status };
}

/** Get a Printful order (status, shipments with tracking). */
export async function getOrder(printfulOrderId) {
  const order = await pf(`/orders/${printfulOrderId}`);
  const shipment = order?.shipments?.[0];
  return {
    id: order?.id,
    status: order?.status,
    trackingNumber: shipment?.tracking_number || null,
    trackingProvider: shipment?.carrier || null,
  };
}

/**
 * Gets available catalog categories (useful for browsing what Printful offers).
 */
export async function getCategories() {
  return pf("/categories");
}

/**
 * True if PRINTFUL_API_KEY is set.
 */
export function isConfigured() {
  return !!process.env.PRINTFUL_API_KEY;
}

/**
 * Returns catalog IDs Awon knows about — useful for the inner loop's research action.
 */
export function getKnownProductTypes() {
  return Object.entries(KEYWORD_TO_CATALOG_MAP).map(([keyword, id]) => ({ keyword, catalogId: id }));
}
