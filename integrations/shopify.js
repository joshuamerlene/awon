/**
 * integrations/shopify.js — Shopify Admin REST API
 * Fully implemented. Requires SHOPIFY_ADMIN_API_ACCESS_TOKEN in .env.
 *
 * Note: Pages (createPage/updatePage/getPages) and Blog Articles
 * (getBlogs/createBlog/createArticle/getOrCreateDefaultBlog) are different
 * Shopify resources. Pages are static, one-off content (About, Terms) and do
 * NOT show up in a blog feed. Use the Blog Articles functions for anything
 * meant to read as a real, discoverable blog post.
 */

const DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN   = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

function base() { return `https://${DOMAIN}/admin/api/${VERSION}`; }
function headers() { return { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" }; }

async function req(path, options = {}) {
  if (!TOKEN) throw new Error("SHOPIFY_ADMIN_API_ACCESS_TOKEN not set — store offline.");
  const res = await fetch(`${base()}${path}`, { ...options, headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify ${res.status} on ${options.method || "GET"} ${path}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function getProducts() {
  const data = await req(`/products.json?limit=250&status=active`);
  return data?.products || [];
}

export async function getRecentOrders({ sinceISO } = {}) {
  const params = new URLSearchParams({ limit: "250", status: "any", ...(sinceISO ? { created_at_min: sinceISO } : {}) });
  const data = await req(`/orders.json?${params}`);
  return data?.orders || [];
}

export async function updateProduct(productId, updates) {
  const data = await req(`/products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: { id: productId, ...updates } }),
  });
  return data?.product;
}

export async function createProduct(productData) {
  const data = await req("/products.json", { method: "POST", body: JSON.stringify({ product: productData }) });
  return data?.product;
}

export async function archiveProduct(productId) {
  return updateProduct(productId, { status: "archived" });
}

// -- Collections --
// Products Awon creates go live storewide but weren't showing in the nav
// collections (e.g. MERCH / "frontpage" had only 3 items). These let him drop
// each new product into the right collection so the storefront looks as full
// as it is. Note: the Collect API only works on CUSTOM (manual) collections;
// smart/automated collections populate by their own rules, so a handle that
// resolves to a smart collection just returns null here (safe no-op).

export async function listCustomCollections() {
  const data = await req(`/custom_collections.json?limit=250`);
  return data?.custom_collections || [];
}

export async function findCollectionByHandle(handle) {
  const h = String(handle).toLowerCase();
  const cols = await listCustomCollections();
  return cols.find((c) => (c.handle || "").toLowerCase() === h || (c.title || "").toLowerCase() === h) || null;
}

export async function addProductToCollection(productId, collectionId) {
  const data = await req(`/collects.json`, {
    method: "POST",
    body: JSON.stringify({ collect: { product_id: productId, collection_id: collectionId } }),
  });
  return data?.collect;
}

// Best-effort: add a product to a custom collection by handle/title. Resolves
// the collection, skips silently if it isn't a custom (manual) collection, and
// never throws — a product is already live storewide regardless.
export async function addProductToCollectionByHandle(productId, handle) {
  try {
    const col = await findCollectionByHandle(handle);
    if (!col) return { ok: false, reason: `no custom collection "${handle}"` };
    await addProductToCollection(productId, col.id);
    return { ok: true, collectionId: col.id };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Reprice a product safely. The old approach — PUT /products/{id}.json with
 * `variants: [{ price }]` (no variant ids) — REPLACES the variant array, which
 * Shopify rejects with 422 "Options cannot be blank" on multi-variant products
 * and can silently clobber variants on single-variant ones. This updates each
 * existing variant's price through the variants endpoint instead.
 */
export async function repriceProduct(productId, newPrice) {
  const data = await req(`/products/${productId}.json`);
  const variants = data?.product?.variants || [];
  for (const v of variants) {
    await req(`/variants/${v.id}.json`, {
      method: "PUT",
      body: JSON.stringify({ variant: { id: v.id, price: String(newPrice) } }),
    });
  }
  return variants.length;
}

export async function createDiscount({ title, valueType = "percentage", value, code, startsAt, endsAt, usageLimit }) {
  const rule = await req("/price_rules.json", {
    method: "POST",
    body: JSON.stringify({ price_rule: {
      title, value_type: valueType, value,
      customer_selection: "all", target_type: "line_item",
      target_selection: "all", allocation_method: "across",
      starts_at: startsAt || new Date().toISOString(),
      ...(endsAt ? { ends_at: endsAt } : {}),
      ...(usageLimit ? { usage_limit: usageLimit } : {}),
    }}),
  });
  const priceRuleId = rule.price_rule.id;
  const codeData = await req(`/price_rules/${priceRuleId}/discount_codes.json`, {
    method: "POST",
    body: JSON.stringify({ discount_code: { code: code || title } }),
  });
  return { priceRule: rule.price_rule, discountCode: codeData.discount_code };
}

export async function getProductPerformance(productId, sinceISO) {
  const orders = await getRecentOrders({ sinceISO });
  let units = 0, revenue = 0;
  for (const o of orders) {
    for (const item of o.line_items || []) {
      if (String(item.product_id) === String(productId)) {
        units += item.quantity;
        revenue += Number(item.price) * item.quantity;
      }
    }
  }
  return { productId, unitsSold: units, revenue: +revenue.toFixed(2) };
}

/**
 * Archive ALL active products in the store in one call.
 * Returns array of archived product IDs.
 * Used when resetting the catalog to let Awon rebuild from scratch.
 */
export async function archiveAllProducts() {
  const products = await getProducts();
  const archived = [];
  for (const p of products) {
    try {
      await archiveProduct(p.id);
      archived.push({ id: p.id, title: p.title });
    } catch (err) {
      // Continue even if one fails
    }
  }
  return archived;
}

// ── Theme / Store Design ───────────────────────────────────────────────────────
// Requires scopes: read_themes, write_themes
// Add these in Shopify Admin → Apps → [your app] → Edit permissions → save → copy new token

/**
 * Get all themes. The active one has role: "main".
 */
export async function getThemes() {
  const data = await req("/themes.json");
  return data?.themes || [];
}

/**
 * Get the currently active (published) theme.
 */
export async function getActiveTheme() {
  const themes = await getThemes();
  return themes.find(t => t.role === "main") || themes[0] || null;
}

/**
 * Get a specific asset from a theme (e.g. config/settings_data.json).
 * @param {number} themeId
 * @param {string} assetKey  e.g. "config/settings_data.json"
 */
export async function getThemeAsset(themeId, assetKey) {
  const data = await req(`/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`);
  return data?.asset || null;
}

/**
 * Update a theme asset.
 * @param {number} themeId
 * @param {string} assetKey
 * @param {string} value  — string content of the file
 */
export async function updateThemeAsset(themeId, assetKey, value) {
  const data = await req(`/themes/${themeId}/assets.json`, {
    method: "PUT",
    body: JSON.stringify({ asset: { key: assetKey, value } }),
  });
  return data?.asset;
}

/**
 * Get the active theme's settings_data.json as a parsed object.
 * This controls colors, fonts, section content, hero images, banner text, etc.
 */
export async function getThemeSettings() {
  const theme = await getActiveTheme();
  if (!theme) throw new Error("No active theme found.");
  const asset = await getThemeAsset(theme.id, "config/settings_data.json");
  if (!asset?.value) throw new Error("settings_data.json not found in theme.");
  return { themeId: theme.id, themeName: theme.name, settings: JSON.parse(asset.value) };
}

/**
 * Write updated settings back to the active theme.
 * @param {number} themeId
 * @param {object} settings  — full settings_data.json object (not a partial patch)
 */
export async function updateThemeSettings(themeId, settings) {
  return updateThemeAsset(themeId, "config/settings_data.json", JSON.stringify(settings, null, 2));
}

/**
 * List all assets in a theme (useful for Awon to see what's customizable).
 */
export async function listThemeAssets(themeId) {
  const data = await req(`/themes/${themeId}/assets.json`);
  return data?.assets || [];
}

/**
 * Get all store pages (About, Terms, etc.)
 */
export async function getPages() {
  const data = await req("/pages.json");
  return data?.pages || [];
}

/**
 * Update a store page.
 */
export async function updatePage(pageId, updates) {
  const data = await req(`/pages/${pageId}.json`, {
    method: "PUT",
    body: JSON.stringify({ page: { id: pageId, ...updates } }),
  });
  return data?.page;
}

/**
 * Create a new store page.
 */
export async function createPage({ title, body_html, handle }) {
  const data = await req("/pages.json", {
    method: "POST",
    body: JSON.stringify({ page: { title, body_html, handle } }),
  });
  return data?.page;
}

// ── Blog Articles ────────────────────────────────────────────────────────────
// This is the REAL blog API — distinct from Pages above. Articles created here
// show up in a blog's feed/RSS and on the storefront (e.g. /blogs/news/my-post).
// A page created via createPage() does NOT do this even if it "succeeds" — it's
// just a static page nobody links to. Use these for actual blog content.

/**
 * Get all blogs on the store (a store usually has one, often called "News").
 */
export async function getBlogs() {
  const data = await req("/blogs.json");
  return data?.blogs || [];
}

/**
 * Create a new blog (rarely needed — most stores already have one).
 */
export async function createBlog(title) {
  const data = await req("/blogs.json", {
    method: "POST",
    body: JSON.stringify({ blog: { title } }),
  });
  return data?.blog;
}

/**
 * Get the store's default blog, creating one if none exists yet.
 * Caches nothing — cheap enough to call each time (one extra GET).
 */
export async function getOrCreateDefaultBlog() {
  const blogs = await getBlogs();
  if (blogs.length > 0) return blogs[0];
  return createBlog("Journal");
}

/**
 * Create and publish a real blog article.
 * @param {number} blogId
 * @param {{ title: string, body_html: string, tags?: string, author?: string }} article
 */
export async function createArticle(blogId, { title, body_html, tags, author }) {
  const data = await req(`/blogs/${blogId}/articles.json`, {
    method: "POST",
    body: JSON.stringify({
      article: {
        title,
        body_html,
        tags: tags || "",
        author: author || "The Rival Is Me",
        published: true,
      },
    }),
  });
  return data?.article;
}

// ── Files / Media ────────────────────────────────────────────────────────────
// Admin REST/GraphQL don't expose a direct "shop logo" field (that only
// exists on the Storefront API, which this app doesn't have a token for).
// The logo Josh set in Theme Settings lives in settings_data.json as a
// "shopify://shop_images/<filename>" reference, not a usable URL — resolving
// it to a real CDN URL requires a Files lookup by filename.

async function graphqlReq(query, variables = {}) {
  if (!TOKEN) throw new Error("SHOPIFY_ADMIN_API_ACCESS_TOKEN not set — store offline.");
  const res = await fetch(`${base()}/graphql.json`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify GraphQL ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/**
 * Resolve the store's theme logo (Theme Settings → Logo) to a public URL, so
 * it can be used as the Printful print file instead of needing a separately
 * hosted design asset. Best-effort — returns null (never throws) if no logo
 * is set or it can't be resolved, so callers can fall back gracefully rather
 * than have product creation fail over a missing logo.
 */
export async function getStoreLogoUrl() {
  // A dedicated print design beats the site logo: the theme logo needs a
  // visible background to read on the dark site header, while the PRINT file
  // should be transparent-background art. If PRINTFUL_DESIGN_URL is set in
  // Railway (e.g. the transparent logo uploaded to Shopify Files), use it and
  // skip theme-logo resolution entirely.
  if (process.env.PRINTFUL_DESIGN_URL) return process.env.PRINTFUL_DESIGN_URL;
  try {
    const { settings } = await getThemeSettings();
    const ref = settings?.current?.logo;
    if (!ref || typeof ref !== "string") return null;

    // Some stores/newer themes already store a direct URL — use as-is.
    if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
    if (ref.startsWith("//")) return `https:${ref}`;

    // "shopify://shop_images/<filename>" — resolve via the Files API.
    const match = ref.match(/^shopify:\/\/shop_images\/(.+)$/);
    if (!match) return null;
    const filename = decodeURIComponent(match[1]);

    const data = await graphqlReq(
      `query($q: String!) {
        files(first: 1, query: $q) {
          edges {
            node {
              ... on MediaImage { image { url } }
              ... on GenericFile { url }
            }
          }
        }
      }`,
      { q: `filename:${filename}` }
    );

    const node = data?.files?.edges?.[0]?.node;
    return node?.image?.url || node?.url || null;
  } catch (err) {
    return null;
  }
}
