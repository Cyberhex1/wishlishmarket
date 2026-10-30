// The shopping job every AI shopper does, shared by the server (agent.js) and
// the browser (local.js runs it against a model on the user's own computer).
//
// Two ways to research:
//   - Shoppers that search the web themselves (Gemini, OpenAI, Claude, Grok,
//     Perplexity, OpenRouter) get researchPrompt() with their search tool on,
//     then shapePrompt() turns their notes into PICKS_SCHEMA JSON.
//   - Shoppers without a search tool (DeepSeek, Mistral, Groq, Ollama, LM Studio,
//     other local models) use helperResearch(): the model writes search
//     queries, a search helper (Tavily, Brave, Perplexity Search or Ollama web
//     search) runs them, and the model picks products only from those results.
// Either way the server then link-checks every pick before a list is made.
//
// No imports: this file is loaded as-is by the browser.

export const SYSTEM = `You are a careful shopping researcher for the WishlistMarket site.
Rules:
- Research live. Never rely on memory for prices, stock or links.
- Only suggest products you found on the store's own product page, with that page's exact URL
  (for Amazon use https://www.amazon.com/dp/<ASIN>; for Walmart a /ip/ link). No search pages, no affiliate or redirect links.
- Respect the user's stores, budget, condition (new / renewed / used) and must-haves.
- Rank in the order you would actually recommend for this person's stated priorities,
  not only by price: rank 1 is what you would buy for them.
- Be honest about downsides. Keep text short and plain.`;

const lines = a => a.filter(Boolean).join("\n");

function about(r) {
  return [
    `Request: ${r.request}`,
    r.stores?.length ? `Stores to use: ${r.stores.join(", ")}` : "Stores: any major US store",
    r.budget ? `Budget: ${r.budget}` : "",
    r.condition ? `Condition: ${r.condition}` : "",
    r.location ? `Shopper location (for local stores and shipping): ${r.location}` : "",
    r.notes ? `Shopper notes: ${r.notes}` : "",
    r.avoid?.length ? `Do not suggest these again: ${r.avoid.join("; ")}` : "",
  ];
}

export function researchPrompt(r, want) {
  return lines([
    `Find the ${want} best products for this shopping request.`,
    ...about(r),
    "",
    "For each product give: rank, a short product type/group, exact name, brand, store, current price",
    "and how it is sold, the product page URL, stock status, why it fits, 2-4 pros and 2-4 cons versus",
    "similar products, a one-line comparison with the others on this list, and 0-10 ratings for",
    "performance (quality, reviews, specs, reliability vs peers) and price (10 = cheapest among peers).",
  ]);
}

export const SHAPE_SYSTEM = "Convert shopping research into JSON. Copy facts exactly; do not invent products, prices or URLs. Omit any product without a product-page URL.";

export function shapePrompt(notes, citations) {
  return `Research notes:\n${notes}\n\nSources found:\n${(citations || []).map(s => `- ${s.title}: ${s.url}`).join("\n") || "(none)"}`;
}

const PRODUCT = {
  type: "object",
  properties: {
    rank: { type: "integer" },
    type: { type: "string", description: "Product group, e.g. 'Wired USB headsets'" },
    name: { type: "string" },
    brand: { type: "string" },
    store: { type: "string" },
    price: { type: "number" },
    priceText: { type: "string" },
    url: { type: "string" },
    availability: { type: "string", enum: ["in_stock", "out_of_stock", "unknown"] },
    why: { type: "string" },
    prosGeneral: { type: "array", items: { type: "string" } },
    consGeneral: { type: "array", items: { type: "string" } },
    vsList: { type: "string" },
    performance: { type: "number" },
    priceScore: { type: "number" },
  },
  required: ["rank", "type", "name", "store", "url", "why"],
};

export const PICKS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short list name, e.g. 'Headsets with Mic'" },
    category: { type: "string", description: "Department, e.g. Electronics & Computers, Home & Kitchen, Health & Household" },
    summary: { type: "string", description: "One line on what the list is for" },
    products: { type: "array", items: PRODUCT },
  },
  required: ["title", "products"],
};

// Smaller models get a shorter schema: each product points at the search
// result it came from (`source`), so its link can be checked against it.
export const PICKS_FROM_RESULTS_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    category: { type: "string" },
    summary: { type: "string" },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "integer" },
          source: { type: "integer", description: "Number of the search result this product's page came from" },
          type: { type: "string" },
          name: { type: "string" },
          brand: { type: "string" },
          store: { type: "string" },
          price: { type: "number" },
          url: { type: "string" },
          why: { type: "string" },
          prosGeneral: { type: "array", items: { type: "string" } },
          consGeneral: { type: "array", items: { type: "string" } },
          performance: { type: "number" },
          priceScore: { type: "number" },
        },
        required: ["rank", "source", "type", "name", "store", "url", "why"],
      },
    },
  },
  required: ["title", "products"],
};

export const QUERIES_SCHEMA = {
  type: "object",
  properties: { queries: { type: "array", items: { type: "string" } } },
  required: ["queries"],
};

// ---------- schema helpers for strict structured-output APIs ----------

const clone = o => JSON.parse(JSON.stringify(o));

// Every object closed (additionalProperties: false). Claude and Perplexity want this.
export function closedSchema(schema) {
  const s = clone(schema);
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "object") n.additionalProperties = false;
    for (const v of Object.values(n.properties || {})) walk(v);
    if (n.items) walk(n.items);
  })(s);
  return s;
}

// OpenAI-style strict mode: closed objects, every property required, and the
// ones that were optional may be null instead.
export function strictSchema(schema) {
  const s = closedSchema(schema);
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "object" && n.properties) {
      const req = new Set(n.required || []);
      for (const [k, v] of Object.entries(n.properties)) {
        walk(v);
        if (!req.has(k)) {
          if (typeof v.type === "string") v.type = [v.type, "null"];
          if (Array.isArray(v.enum) && !v.enum.includes(null)) v.enum.push(null);
        }
      }
      n.required = Object.keys(n.properties);
    }
    if (n.items) walk(n.items);
  })(s);
  return s;
}

// Pull a JSON object out of a model's text answer (fences, a sentence first,
// a <think> block). Returns null if there is none.
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try { return JSON.parse(t); } catch { /* keep looking */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* keep looking */ } }
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// Text added to a prompt when the model can't be held to a schema by its API.
export function schemaHint(schema) {
  return `\n\nAnswer with only a JSON object (no other text) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

// ---------- research with a search helper ----------

const STORE_SITES = {
  amazon: "amazon.com", walmart: "walmart.com", target: "target.com", bestbuy: "bestbuy.com",
  lowes: "lowes.com", homedepot: "homedepot.com", costco: "costco.com", wayfair: "wayfair.com",
  ebay: "ebay.com", offerup: "offerup.com", newegg: "newegg.com", chewy: "chewy.com",
};

export function queriesPrompt(r, n) {
  return lines([
    `Write ${n} short web search queries (3 to 8 words each) that will find product pages for this shopping request.`,
    "Mix general queries with store-specific ones (add the store name). Do not add quotes or site: operators.",
    ...about(r),
    'Answer as JSON: {"queries": ["...", "..."]}',
  ]);
}

// Queries made without the model, used when a small model fumbles the JSON.
export function fallbackQueries(r, n) {
  const base = r.request.replace(/\s+/g, " ").trim().slice(0, 80);
  const q = [base, `best ${base}`];
  for (const s of r.stores || []) q.push(`${base} ${s}`);
  if (r.budget) q.push(`${base} ${r.budget}`);
  return [...new Set(q)].slice(0, n);
}

const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const normUrl = u => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return ""; } };

// Search results that can't be product pages are dropped before the model sees them.
function usefulResult(x) {
  const h = host(x.url);
  if (!h || /(^|\.)(youtube|reddit|facebook|instagram|tiktok|pinterest|x|twitter)\.com$/.test(h)) return false;
  try {
    const p = new URL(x.url).pathname;
    if (p === "/" || /^\/(s|search|browse|b)(\/|$)/.test(p)) return false;
  } catch { return false; }
  return true;
}

export function picksFromResultsPrompt(r, want, sources) {
  return lines([
    `Pick the ${want} best products for this shopping request, using ONLY the numbered search results below.`,
    ...about(r),
    "",
    "Search results:",
    ...sources.map((s, i) => `[${i + 1}] ${s.title}\n    ${s.url}\n    ${(s.snippet || "").replace(/\s+/g, " ").slice(0, 240)}`),
    "",
    "Rules: every product must come from one result above: set `source` to that result's number and copy its URL exactly.",
    "Skip results that are articles, reviews, category or search pages; use product pages only.",
    "Give rank (1 = what you would buy), a short product type, name, brand, store, price if shown, why it fits,",
    "2-3 pros and cons, and 0-10 performance and priceScore (10 = cheapest among these).",
  ]);
}

// Make every product's URL one the search actually returned. Products whose
// link the model invented are moved to the URL of the result they cite, or
// dropped when that doesn't make sense.
export function groundProducts(products, sources) {
  const byUrl = new Map(sources.map(s => [normUrl(s.url), s]));
  const out = [];
  const used = new Set();
  for (const p of Array.isArray(products) ? products : []) {
    if (!p || typeof p !== "object" || !p.name) continue;
    let url = normUrl(p.url);
    if (!byUrl.has(url)) {
      const src = sources[(p.source | 0) - 1];
      if (!src) continue;
      url = normUrl(src.url);
    }
    if (used.has(url)) continue;
    used.add(url);
    out.push({ ...p, url: byUrl.get(url)?.url || url });
  }
  return out;
}

// ask({ system, prompt, schema }) -> { text, data, usage, model }
// search(query) -> [{ title, url, snippet }]
export async function helperResearch({ ask, search, input, want, step = () => {} }) {
  const nQueries = Math.min(6, Math.max(3, Math.ceil(want / 3) + 1));
  step("Planning searches");
  let queries = [];
  try {
    const q = await ask({ system: SYSTEM, prompt: queriesPrompt(input, nQueries), schema: QUERIES_SCHEMA, small: true });
    queries = (q.data?.queries || []).map(String).map(s => s.trim()).filter(s => s && s.length < 150);
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) throw e;
  }
  if (queries.length < 2) queries = [...new Set([...queries, ...fallbackQueries(input, nQueries)])];
  queries = queries.slice(0, nQueries);

  step(`Searching the web (${queries.length} searches)`);
  const seen = new Set();
  const sources = [];
  const errors = [];
  for (const q of queries) {
    try {
      for (const x of await search(q)) {
        const u = normUrl(x.url);
        if (!u || seen.has(u) || !usefulResult(x)) continue;
        seen.add(u);
        sources.push({ title: String(x.title || u).slice(0, 160), url: x.url, snippet: String(x.snippet || "") });
      }
    } catch (e) {
      errors.push(e);
      if (e?.status === 401 || e?.status === 403 || e?.status === 402) throw e;
    }
  }
  if (!sources.length) {
    const e = new Error(errors[0]?.message || "The web search found no product pages for this request");
    e.status = errors[0]?.status || 502;
    throw e;
  }
  // Store pages first, then the rest; cap the list so small models keep up.
  const storeHosts = new Set(Object.values(STORE_SITES));
  const ranked = [...sources.filter(s => storeHosts.has(host(s.url))), ...sources.filter(s => !storeHosts.has(host(s.url)))].slice(0, 14);

  step("Choosing products");
  const picked = await ask({ system: SYSTEM, prompt: picksFromResultsPrompt(input, want, ranked), schema: PICKS_FROM_RESULTS_SCHEMA });
  const data = picked.data || {};
  const products = groundProducts(data.products, ranked);
  return {
    data: { title: data.title, category: data.category, summary: data.summary, products },
    sources: ranked.map(s => ({ title: s.title, url: s.url })),
    queries,
    model: picked.model,
    usage: picked.usage ? [picked.usage] : [],
  };
}

// ---------- list updates (shopping rule 5) ----------

// The request for rebuilding an existing list almost from scratch with
// today's info. Keeps the user's own notes as shopper notes.
export function rebuildInput(old, input = {}) {
  const needs = [...new Set(old.items.map(i => i.need).filter(Boolean))].slice(0, 30);
  const userNotes = [old.notes, ...old.items.map(i => i.notes)].filter(Boolean);
  const request = input.request || lines([
    `Rebuild this shopping list from scratch with today's best options: "${old.title}".`,
    old.summary ? `It is for: ${old.summary}` : "",
    needs.length ? `It covered: ${needs.join("; ")}` : "",
  ]);
  return {
    ...input,
    request,
    stores: input.stores || old.storeIds || [],
    count: input.count ?? Math.max(10, old.items.length),
    notes: [input.notes, ...userNotes].filter(Boolean).join(" | ").slice(0, 2000) || undefined,
  };
}

// Put back what a rebuild keeps from the old list: its id, title, project,
// stores, category, notes, and pictures for links that are still on it.
export function keepFromOld(list, old) {
  const oldImages = new Map();
  for (const it of old.items || []) for (const p of it.picks || []) if (p.url && p.image) oldImages.set(p.url, p.image);
  for (const it of list.items) {
    const p = it.picks[0];
    if (oldImages.has(p.url)) p.image = oldImages.get(p.url);
  }
  for (const k of ["id", "title", "projectId", "storeIds", "category", "createdAt", "notes"]) {
    if (old[k] !== undefined && old[k] !== "") list[k] = old[k];
  }
  list.updatedAt = new Date().toISOString();
  return list;
}
