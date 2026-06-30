/**
 * integrations/printful.js — Printful POD API
 *
 * Printful is already connected to The Rival Is Me's Shopify store.
 * This integration lets Awon:
 *   1. Search the Printful catalog for fitness/apparel products
 *   2. Create sync products (Printful handles fulfillment, Shopify shows the listing)
 *   3. Publish products to the connected Shopify store
 *
 * Auth: Bearer token (PRINTFUL_API_KEY env var)
 * Docs: https://developers.printful.com/docs/
 *
 * NOTE: Printful requires design files (print files) on variants to publish.
 * Awon creates products in "draft" mode with a placeholder color/text brand mark,
 * and logs them for design review. A real design upload requires a hosted image URL.
 *
 * BRAND DESIGN PLACEHOLDER: We use a publicly hosted image of The Rival Is Me
 * wordmark. Replace BRAND_PRINT_FILE_URL with an actual design URL when available.
 */

const BASE_URL = "https://api.printful.com";

// Placeholder design — a simple black PNG with "THE RIVAL IS ME" text.
// Replace this with a real hosted design file URL when you have one.
const BRAND_PRINT_FILE_URL = process.env.PRINTFUL_DESIGN_URL || null;

// Fitness/apparel keyword → Printful catalog product ID map (common ones)
// Printful catalog IDs are stable. These are the most popular fitness items.
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
  "joggers":        439,  // Unisex Joggers
  "tank":           188,  // Unisex Tank Top
  "tank top":       188,
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

// Default brand colors for blank/solid products
const BRAND_COLORS = ["Black", "White", "Dark Grey Heather"];

async function pf(path, options = {}) {
  const apiKey = process.env.PRINTFUL_API_KEY;
  if (!apiKey) throw new Error("PRINTFUL_API_KEY not set");

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-PF-Store-Id": process.env.PRINTFUL_STORE_ID || "", // optional, auto-selects if only 1 store
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
 * Returns the Printful store ID connected to the merchant's Shopify store.
 */
export async function getStoreId() {
  const stores = await pf("/stores");
  if (!stores || stores.length === 0) throw new Error("No Printful stores found");
  return stores[0].id;
}

/**
 * Searches the Printful catalog for products matching a keyword.
 * Returns an array of { id, title, type, brand, variants[] }
 */
export async function searchCatalog(keyword) {
  const kw = keyword.toLowerCase().trim();

  // Try keyword map first (fast, no API call needed)
  const catalogId = Object.entries(KEYWORD_TO_CATALOG_MAP).find(([k]) =>
    kw.includes(k) || k.includes(kw)
  )?.[1];

  if (catalogId) {
    const product = await pf(`/products/${catalogId}`);
    return [product];
  }

  // Fall back to fetching the first page of catalog and filtering
  const allProducts = await pf("/products");
  return allProducts.filter(p =>
    p.title?.toLowerCase().includes(kw) ||
    p.type?.toLowerCase().includes(kw) ||
    p.type_name?.toLowerCase().includes(kw)
  ).slice(0, 5);
}

/**
 * Resolves a keyword to a Printful catalog product + variants.
 * Returns: { catalogProductId, title, variants[] }
 * Variants include size/color and the variant_id needed to create sync products.
 */
export async function resolveCatalogProductForKeyword(keyword) {
  const results = await searchCatalog(keyword);
  if (!results || results.length === 0) {
    throw new Error(`No Printful catalog products found for keyword: "${keyword}"`);
  }

  const catalogProduct = results[0];
  const detail = await pf(`/products/${catalogProduct.id}`);

  // Filter to brand-appropriate variants: Black and common sizes
  const variants = (detail.variants || []).filter(v => {
    const color = (v.color || "").toLowerCase();
    const size = (v.size || "").toUpperCase();
    // Prefer black/dark colors and common sizes
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
 * Creates a sync product in Printful (which auto-syncs to Shopify).
 *
 * @param {object} opts
 * @param {string} opts.title            — Product name on Shopify
 * @param {string} opts.description      — HTML description
 * @param {number} opts.catalogProductId — From resolveCatalogProductForKeyword
 * @param {Array}  opts.variants         — Catalog variants from resolveCatalogProductForKeyword
 * @param {number} opts.retailPrice      — Price in USD
 * @param {string} [opts.imageUrl]       — Design URL (PNG). Falls back to BRAND_PRINT_FILE_URL.
 */
export async function createProduct({ title, description, catalogProductId, variants, retailPrice = 34.99, imageUrl }) {
  const designUrl = imageUrl || BRAND_PRINT_FILE_URL;

  // Build sync_variants — each catalog variant gets a price and optionally a print file
  const syncVariants = variants.map(v => {
    const variant = {
      variant_id: v.id,
      retail_price: retailPrice.toFixed(2),
    };

    // Only attach files if we have a design URL
    if (designUrl) {
      variant.files = [
        {
          url: designUrl,
          position: "front",
        },
      ];
    }

    return variant;
  });

  if (syncVariants.length === 0) {
    throw new Error(`No variants available for catalog product ${catalogProductId}`);
  }

  const body = {
    sync_product: {
      name: title,
      description: description || `<p>${title}</p><p>Built for the ones who chose discipline. #THERIVALISME</p>`,
    },
    sync_variants: syncVariants,
  };

  const result = await pf("/store/products", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return result;
}

/**
 * Gets all sync products in the connected Printful store.
 */
export async function getProducts({ limit = 20 } = {}) {
  return pf(`/store/products?limit=${limit}`);
}

/**
 * Gets a single sync product by Printful sync product ID.
 */
export async function getProduct(syncProductId) {
  return pf(`/store/products/${syncProductId}`);
}

/**
 * Deletes (removes) a sync product from Printful + Shopify.
 */
export async function deleteProduct(syncProductId) {
  return pf(`/store/products/${syncProductId}`, { method: "DELETE" });
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
