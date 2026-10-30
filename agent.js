// Agent jobs: the shopping work Claude does by hand today, run on the
// user's own AI key. They return list objects in the Market's own format
// (one product per item, `type` + `rank`, 10 items by default) so the site
// can save them wherever it keeps lists.

import { HttpError } from "./lib.js";
import { SYSTEM, researchPrompt, SHAPE_SYSTEM, shapePrompt, PICKS_SCHEMA, helperResearch, rebuildInput, keepFromOld } from "./public/shoppers/pipeline.js";
import { searchesItself } from "./providers/index.js";
import { runSearch } from "./search/index.js";

const MAX_COUNT = 20;
const LINK_CONCURRENCY = 5;
const UA = "Mozilla/5.0 (compatible; WishlistMarket/1.0; +https://wishlistmarket.pages.dev)";

const KNOWN_STORES = {
  amazon: "amazon.com", walmart: "walmart.com", target: "target.com", bestbuy: "bestbuy.com",
  lowes: "lowes.com", homedepot: "homedepot.com", costco: "costco.com", wayfair: "wayfair.com",
  ebay: "ebay.com", offerup: "offerup.com", newegg: "newegg.com", chewy: "chewy.com",
};

const slug = s => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? +n : lo));
const round1 = n => Math.round(n * 10) / 10;
const today = () => new Date().toISOString().slice(0, 10);

function storeIdFor(url, fallback) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const [id, domain] of Object.entries(KNOWN_STORES)) if (host === domain || host.endsWith(`.${domain}`)) return id;
    return slug(host.split(".").slice(-2, -1)[0] || fallback);
  } catch { return slug(fallback || "store"); }
}

// ---------- link check ----------

function isPrivateHost(host) {
  return /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i.test(host) || !host.includes(".");
}

const GONE = /(this (item|listing|page) (is )?no longer available|listing (has been |was )?(removed|ended)|item (has been |was )?(sold|removed)|this listing has expired|we couldn['’]t find (that|this) page|page not found)/i;
const BOT_WALL = /(enter the characters you see below|robot or human\?|are you a robot|verify you are a human|press (and|&) hold)/i;
const OUT = /(currently unavailable|out of stock|sold out|temporarily unavailable)/i;

function ogImage(html, base) {
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i)
    || html.match(/data-old-hires=["'](https:[^"']+)["']/i)            // Amazon main photo
    || html.match(/"hiRes":"(https:[^"]+)"/i)
    || html.match(/<img[^>]+id=["']landingImage["'][^>]+src=["'](https:[^"']+)["']/i);
  if (!m) return "";
  try { const u = new URL(m[1].replace(/&amp;/g, "&"), base); return u.protocol === "https:" ? u.href : ""; } catch { return ""; }
}

// Returns { ok, reason?, availability?, image?, finalUrl? }. ok:false means the
// pick should be removed (the shopping rules: 404/410, dead domain, listing
// gone, or bounced to a search/home page). Bot blocks keep the pick as unknown.
export async function checkLink(url, c) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: "no valid link" }; }
  if (!/^https?:$/.test(u.protocol) || (!c.allowPrivateLinks && isPrivateHost(u.hostname))) return { ok: false, reason: "no valid link" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.linkTimeoutMs);
  try {
    const r = await fetch(u.href, { redirect: "follow", signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" } });
    if (r.status === 404 || r.status === 410) return { ok: false, reason: String(r.status) };
    const finalUrl = r.url || u.href;
    try {
      const f = new URL(finalUrl);
      if (f.pathname === "/" || /^\/(s|search|browse|b)(\/|$)/.test(f.pathname) || f.searchParams.has("k") && f.pathname === "/s") {
        return { ok: false, reason: "redirects to a search or home page" };
      }
    } catch { /* keep going */ }
    const blocked = { ok: true, availability: "unknown", checked: false, note: `store blocked the check (${r.status})` };
    if (!r.ok || /\/(blocked|captcha|errors\/validateCaptcha)/i.test(new URL(finalUrl).pathname)) return blocked;
    const html = (await r.text()).slice(0, 600000);
    if (BOT_WALL.test(html)) return blocked;
    if (GONE.test(html)) return { ok: false, reason: "listing removed" };
    return { ok: true, checked: true, availability: OUT.test(html) ? "out_of_stock" : undefined, image: ogImage(html, finalUrl), finalUrl };
  } catch (e) {
    if (e.name === "AbortError") return { ok: true, availability: "unknown", checked: false, note: "store page timed out" };
    return { ok: false, reason: "site can't be reached" };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- turning model output into Market list items ----------

const txt = (v, n) => (v == null ? "" : String(v)).trim().slice(0, n);

export function toPick(p, checkedAt) {
  const performance = round1(clamp(p.performance, 0, 10));
  const priceScore = round1(clamp(p.priceScore, 0, 10));
  const pick = {
    rank: Math.max(1, Math.round(+p.rank) || 99),
    name: txt(p.name, 200),
    brand: txt(p.brand, 60),
    store: storeIdFor(p.url, p.store),
    price: Number.isFinite(+p.price) && +p.price > 0 ? Math.round(+p.price * 100) / 100 : null,
    priceText: txt(p.priceText || (+p.price > 0 ? `$${(+p.price).toFixed(2)}` : ""), 80),
    url: txt(p.url, 2000),
    image: "",
    why: txt(p.why, 600),
    prosGeneral: (Array.isArray(p.prosGeneral) ? p.prosGeneral : []).slice(0, 4).map(x => txt(x, 200)),
    consGeneral: (Array.isArray(p.consGeneral) ? p.consGeneral : []).slice(0, 4).map(x => txt(x, 200)),
    vsList: txt(p.vsList, 300),
    score: round1(0.6 * performance + 0.4 * priceScore),
    scoreParts: { performance, price: priceScore },
    checkedAt,
    availability: ["in_stock", "out_of_stock"].includes(p.availability) ? p.availability : "unknown",
  };
  return pick;
}

// One product per item, ranks 1..N in recommendation order, stored grouped by
// type (groups ordered by their best-ranked product).
export function toItems(picks) {
  const sorted = [...picks].sort((a, b) => a.rank - b.rank).map((p, i) => ({ ...p, rank: i + 1 }));
  const groups = new Map();
  for (const p of sorted) {
    const type = p._type || "Top picks";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(p);
  }
  const used = new Set();
  const items = [];
  for (const [type, ps] of groups) {
    for (const p of ps) {
      const named = p.brand && !p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? `${p.brand} ${p.name}` : p.name;
      let id = slug(named);
      while (used.has(id)) id += "-2";
      used.add(id);
      const { _type, ...pick } = p;
      items.push({ id, need: p.name, notes: "", type, rank: p.rank, picks: [pick] });
    }
  }
  return items;
}

function summarize(items, base) {
  const prices = items.map(i => i.picks[0]?.price).filter(n => n > 0);
  const range = prices.length ? `, $${Math.min(...prices).toFixed(2)}–$${Math.max(...prices).toFixed(2)}` : "";
  return `${base ? `${base.replace(/[.:]\s*$/, "")}: ` : ""}${items.length} items${range}.`;
}

// ---------- jobs ----------

function readRequest(input) {
  if (!input || typeof input.request !== "string" || !input.request.trim()) {
    throw new HttpError(400, "request (what to shop for, as text) is required");
  }
  if (input.request.length > 4000) throw new HttpError(413, "request is over 4000 characters");
  const count = Math.round(clamp(input.count ?? 10, 1, MAX_COUNT));
  const stores = Array.isArray(input.stores) ? input.stores.map(String).slice(0, 10) : [];
  return { ...input, request: input.request.trim(), count, stores };
}

// Research with the shopper's own search tool, then shape the notes into JSON.
async function nativeResearch(c, provider, key, r, want, ctx) {
  const research = await provider.ask(c, key, {
    model: r.model, system: SYSTEM, prompt: researchPrompt(r, want), search: true, thinking: r.thinking,
  }, ctx);
  if (!research.text.trim()) throw new HttpError(502, "the AI returned no research");
  const shaped = await provider.ask(c, key, {
    model: r.model, system: SHAPE_SYSTEM, prompt: shapePrompt(research.text, research.citations), schema: PICKS_SCHEMA,
  }, ctx);
  return { data: shaped.data || {}, sources: research.citations, model: shaped.model, usage: [research.usage, shaped.usage].filter(Boolean), warning: shaped.warning };
}

// Research for shoppers without a search tool: a search helper runs the
// queries the shopper writes, and the shopper picks only from those results.
function searchHelperResearch(c, provider, key, r, want, ctx, search) {
  if (!search?.helper || !search.key) {
    throw new HttpError(400, `${provider.info.name} needs a search helper to look things up on the web`, {
      hint: "Hire a search helper on the Shoppers page (Tavily is free for 1,000 searches a month) and add its key.",
    });
  }
  return helperResearch({
    input: r, want,
    ask: q => provider.ask(c, key, { model: r.model, system: q.system, prompt: q.prompt, schema: q.schema, thinking: q.small ? undefined : r.thinking }, ctx),
    search: async q => {
      try { return await runSearch(c, search.helper, search.key, q); }
      catch (e) {
        // Say which key is wrong: the search helper's, not the shopper's.
        if (e instanceof HttpError) e.details = { ...e.details, hint: search.helper.friendly(e) || e.details?.hint };
        throw e;
      }
    },
  });
}

// opts.ctx: { baseUrl } for the custom provider; opts.search: { helper, key }.
export async function findProducts(c, provider, key, input, opts = {}) {
  const r = readRequest(input);
  const want = Math.min(MAX_COUNT + 5, r.count + 4); // spares in case links fail
  const research = searchesItself(provider)
    ? await nativeResearch(c, provider, key, r, want, opts.ctx)
    : await searchHelperResearch(c, provider, key, r, want, opts.ctx, opts.search);
  return finishList(c, r, research);
}

// The research was done somewhere else (a local shopper in the browser):
// check its products the same way and make the list. With `list` (the old
// list) it finishes a rebuild: the browser already sent rebuildInput()'s request.
export async function finishFromResearch(c, input) {
  const old = input.list ? oldList(input) : null;
  const r = readRequest(old && !input.request ? rebuildInput(old, input) : input);
  const d = input.data;
  if (!d || typeof d !== "object" || !Array.isArray(d.products)) throw new HttpError(400, "data.products (the shopper's picks) is required");
  const sources = (Array.isArray(input.sources) ? input.sources : []).slice(0, 30)
    .filter(s => s && typeof s.url === "string").map(s => ({ title: String(s.title || s.url).slice(0, 200), url: s.url.slice(0, 2000) }));
  return finishList(c, r, {
    data: { title: d.title, category: d.category, summary: d.summary, products: d.products.slice(0, MAX_COUNT + 5) },
    sources, model: String(input.model || "").slice(0, 100) || null, usage: [],
  }).then(out => (old ? { ...out, list: keepFromOld(out.list, old) } : out));
}

// Link-check every pick, drop unreachable ones (shopping rule 5b), and make
// the Market list.
async function finishList(c, r, research) {
  const products = research.data?.products;
  if (!Array.isArray(products) || !products.length) throw new HttpError(502, "the AI did not return any products", { warning: research.warning });

  const checkedAt = today();
  const seen = new Set();
  const candidates = products
    .filter(p => p && typeof p === "object")
    .map(p => ({ ...toPick(p, checkedAt), _type: String(p.type || "").trim().slice(0, 60) || "Top picks" }))
    .filter(p => p.name && !seen.has(p.url) && seen.add(p.url));
  const removed = [];
  const checks = await mapLimit(candidates, LINK_CONCURRENCY, p => checkLink(p.url, c));
  const kept = [];
  candidates.forEach((p, i) => {
    const ch = checks[i];
    if (!ch.ok) { removed.push({ name: p.name, url: p.url, reason: ch.reason }); return; }
    if (ch.availability && p.availability !== "out_of_stock") p.availability = ch.availability;
    if (ch.image) p.image = ch.image;
    kept.push(p);
  });

  const items = toItems(kept.sort((a, b) => a.rank - b.rank).slice(0, r.count));
  const now = new Date().toISOString();
  const d = research.data;
  const list = {
    title: String(d.title || r.request).slice(0, 80),
    category: String(d.category || "").slice(0, 60),
    projectId: r.projectId || "",
    storeIds: r.stores.length ? r.stores.map(slug) : [...new Set(items.map(i => i.picks[0].store))],
    summary: summarize(items, d.summary ? String(d.summary).slice(0, 300) : ""),
    createdAt: now,
    updatedAt: now,
    items,
  };
  const warnings = [];
  if (items.length < r.count) warnings.push(`Only ${items.length} of ${r.count} products passed the checks.`);
  return { list, removed, warnings, sources: research.sources, model: research.model, usage: research.usage };
}

// Rebuild an existing list almost from scratch with today's info (shopping
// rule 5): keep its id, title, project, stores and the user's own notes;
// everything else is researched again. Old pictures are reused for the same link.
function oldList(input) {
  const old = input?.list;
  if (!old || typeof old !== "object" || !Array.isArray(old.items)) throw new HttpError(400, "list (the existing list object) is required");
  return old;
}

export async function rebuildList(c, provider, key, input, opts) {
  const old = oldList(input);
  const out = await findProducts(c, provider, key, rebuildInput(old, input), opts);
  keepFromOld(out.list, old);
  return out;
}
