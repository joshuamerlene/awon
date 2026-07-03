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
