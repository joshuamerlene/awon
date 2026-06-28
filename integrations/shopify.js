/**
 * integrations/shopify.js — Shopify Admin REST API
 * Fully implemented. Requires SHOPIFY_ADMIN_API_ACCESS_TOKEN in .env.
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
