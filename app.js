// WishlistMarket AI backend: bring-your-own AI agent.
//
// No shared AI key exists on the server. Each user plugs in their own:
//   1. a key sent with the request in the X-AI-Key header (kept in the
//      user's browser), which always wins, or
//   2. the key a signed-in user saved in their account (accounts/, stored
//      encrypted in D1).
// The router never logs or returns a key.
//
// Shared by worker.js (Cloudflare Worker), functions/api (Pages Function) and
// server.js (Node 18+).

import { HttpError, cfg, json } from "./lib.js";
import { PROVIDERS, DEFAULT_PROVIDER, searchesItself } from "./providers/index.js";
import { checkBaseUrl } from "./providers/custom.js";
import { SEARCH_HELPERS, DEFAULT_SEARCH, SEARCH_KEY_PREFIX, pickSearch, runSearch } from "./search/index.js";
import { findProducts, rebuildList, finishFromResearch } from "./agent.js";
import { HOSTED, SEARCH_INFO, LOCAL_RUNTIMES, LOCAL_NOTES, RESEARCHED, suggest } from "./public/shoppers/catalog.js";
import * as accounts from "./accounts/accounts.js";

function corsHeaders(c, req) {
  const origin = req.headers.get("Origin") || "";
  const allow = c.origins.includes("*") ? "*" : (c.origins.includes(origin) ? origin : c.origins[0] || "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AI-Key, X-AI-Provider, X-AI-Base-URL, X-Search-Key, X-Search-Provider, X-Backend-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function pickProvider(req, body) {
  const id = String(req.headers.get("X-AI-Provider") || body?.provider || DEFAULT_PROVIDER).toLowerCase();
  const p = PROVIDERS[id];
  if (!p) throw new HttpError(400, `unknown provider "${id}"`, { hint: `Supported: ${Object.keys(PROVIDERS).join(", ")}` });
  return p;
}

// A page on another site must not spend a signed-in user's saved key or
// write to their lists through their cookie.
function sameSiteOnly(req, who) {
  if (who?.via !== "session" || req.method === "GET") return;
  const origin = req.headers.get("Origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new HttpError(403, "Cross-site request refused");
  }
}

async function userKey(req, provider, who, env) {
  const sent = (req.headers.get("X-AI-Key") || "").trim();
  if (sent) {
    if (!provider.looksLikeKey(sent)) throw new HttpError(400, "that doesn't look like a valid key", { hint: `Copy the whole key from ${provider.info.key_url}` });
    return { key: sent };
  }
  if (who) {
    sameSiteOnly(req, who);
    const saved = await accounts.getUserAgentKey(env, who.user.id, provider.info.id);
    if (saved?.key) return saved;
  }
  if (provider.info.key_optional) return { key: "" };
  throw new HttpError(401, "no AI key", {
    hint: `Add your own ${provider.info.name} key (get one at ${provider.info.key_url}): save it in your account's AI settings, or send it in the X-AI-Key header. There is no shared key.`,
  });
}

// The "custom" shopper's server address, checked so the backend can't be
// pointed at the user's own network or at Cloudflare's insides.
function providerCtx(req, provider, c) {
  if (!provider.info.needs_base_url) return undefined;
  const raw = req.headers.get("X-AI-Base-URL");
  if (!raw) throw new HttpError(400, `${provider.info.name} needs the server's address`, { hint: "Send it in the X-AI-Base-URL header, e.g. https://my-server.example/v1" });
  return { baseUrl: checkBaseUrl(raw, c.allowPrivateLinks) };
}

// The search helper and key for a shopper without its own search tool:
// X-Search-Key wins, then a key saved in the account as "search-<id>". Ollama
// Cloud's own key also runs Ollama web search.
async function searchFor(req, body, who, env, provider, aiKey) {
  const id = String(req.headers.get("X-Search-Provider") || body?.search_provider || provider?.info.search_helper || DEFAULT_SEARCH).toLowerCase();
  const helper = pickSearch(id);
  const sent = (req.headers.get("X-Search-Key") || "").trim();
  if (sent) {
    if (sent.length > 500) throw new HttpError(400, "that search key is too long");
    return { helper, key: sent };
  }
  if (who) {
    sameSiteOnly(req, who);
    const saved = await accounts.getUserAgentKey(env, who.user.id, `${SEARCH_KEY_PREFIX}${helper.info.id}`);
    if (saved?.key) return { helper, key: saved.key };
  }
  if (aiKey && provider?.info.search_helper === helper.info.id) return { helper, key: aiKey };
  return { helper, key: null };
}

async function rateLimit(req, env, name, limit, windowSec) {
  if (!env?.DB) return; // no database (tests, local server): no counter
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  if (!(await accounts.allow(env, `${name}:${ip}`, limit, windowSec))) {
    throw new HttpError(429, "Too many requests from here. Try again in a little while.");
  }
}

function catalog() {
  return {
    researched: RESEARCHED,
    default: DEFAULT_PROVIDER,
    hosted: Object.values(PROVIDERS).map(p => ({ ...p.info, searches: searchesItself(p), ...(HOSTED[p.info.id] || {}) }))
      .sort((a, b) => (a.popular || 99) - (b.popular || 99)),
    search_helpers: Object.values(SEARCH_HELPERS).map(s => ({ ...s.info, ...(SEARCH_INFO[s.info.id] || {}) })),
    default_search: DEFAULT_SEARCH,
    local: Object.entries(LOCAL_RUNTIMES).map(([id, r]) => {
      const { pull, ...rest } = r;
      return { id, runs: "browser", ...rest };
    }),
    local_notes: LOCAL_NOTES,
  };
}

// body.save: true writes the agent's list into the signed-in user's lists.
async function maybeSave(req, env, who, body, out) {
  if (body.save !== true) return out;
  if (!who) throw new HttpError(401, "Sign in to save lists", { hint: "The list is still in this answer; sign in and save it again." });
  if (who.scope !== "write") throw new HttpError(403, "This agent token is read-only");
  sameSiteOnly(req, who);
  return { ...out, list: await accounts.saveList(env, who.user.id, out.list), saved: true };
}

async function readBody(req) {
  if (!(req.headers.get("Content-Type") || "").includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  let body;
  try { body = await req.json(); } catch { throw new HttpError(400, "body is not valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  return body;
}

const ROUTES = {
  "GET /api/health": "is it running (no key needed)",
  "GET /api/providers": "AI providers a user can plug in",
  "GET /api/shoppers": "every shopper you can hire: hosted, search helpers, local runtimes",
  "GET /api/shoppers/suggest": "?gpu=RTX 4070&vram=12&ram=32&mac=1&os=windows -> the top 3 local models to hire",
  "POST /api/search": "{ query, max? } with X-Search-Provider + X-Search-Key (for shoppers running in the browser)",
  "GET /api/search/key-check": "test the key in X-Search-Key",
  "POST /api/agent/finish": "{ request, count?, stores?, data: { title, category, summary, products }, sources?, model?, save? } -> link-checked list",
  "GET /api/key-check": "test the key in X-AI-Key",
  "GET /api/models": "models the key in X-AI-Key can use",
  "POST /api/ask": "{ prompt, system?, model?, search?, urls?, json?, schema?, thinking?, max_tokens?, previous_id? }",
  "POST /api/agent/find-products": "{ request, stores?, count? (10), budget?, condition?, location?, notes?, projectId?, avoid?, model?, save?, search_provider? }",
  "POST /api/agent/rebuild-list": "{ list, count?, notes?, model?, save? }",
  "* /api/auth|me|data/...": "accounts: sign up, log in, the user's lists and saved AI settings (accounts/accounts.js)",
};

export async function handle(req, env) {
  const c = cfg(env || {});
  const h = corsHeaders(c, req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = `${req.method} ${path}`;
  let provider = null;

  try {
    if (accounts.isAccountsPath(path)) return await accounts.handle(req, env || {});
    if (path === "/" || path === "/api") return json({ name: "WishlistMarket AI backend", routes: ROUTES }, 200, h);

    if (route === "GET /api/health") {
      return json({ ok: true, byo_key: true, providers: Object.keys(PROVIDERS), search_helpers: Object.keys(SEARCH_HELPERS), auth_required: !!c.token }, 200, h);
    }
    if (route === "GET /api/providers") {
      return json({ default: DEFAULT_PROVIDER, providers: Object.values(PROVIDERS).map(p => ({ ...p.info, searches: searchesItself(p) })) }, 200, h);
    }
    if (route === "GET /api/shoppers") return json(catalog(), 200, { ...h, "Cache-Control": "public, max-age=300" });
    if (route === "GET /api/shoppers/suggest") {
      const q = url.searchParams;
      const input = { gpu: q.get("gpu")?.slice(0, 80) || undefined, vram: q.get("vram"), ram: q.get("ram"), mac: q.get("mac") === "1" || q.get("mac") === "true", os: q.get("os") || undefined };
      if (!input.gpu && !input.vram && !input.mac) throw new HttpError(400, "send gpu (a card name), vram (GB), or mac=1 with ram (GB)");
      return json(suggest(input), 200, h);
    }

    if (!ROUTES[route]) {
      const known = Object.keys(ROUTES).some(r => r.endsWith(` ${path}`));
      return json({ error: known ? "wrong method for this route" : "not found" }, known ? 405 : 404, h);
    }

    // Optional site-level gate (e.g. while the site is being tested). Its own
    // header, because Authorization carries the user's agent tokens (wm_...).
    if (c.token && req.headers.get("X-Backend-Token") !== c.token) {
      return json({ error: "unauthorized", hint: "send X-Backend-Token: <BACKEND_TOKEN>" }, 401, h);
    }

    const body = req.method === "POST" ? await readBody(req) : null;
    const who = await accounts.authenticate(req, env || {});

    // Routes that use a search key or no key at all.
    if (route === "POST /api/search" || route === "GET /api/search/key-check") {
      await rateLimit(req, env, "search", 300, 3600);
      const s = await searchFor(req, body, who, env || {}, null, null);
      if (!s.key) throw new HttpError(401, "no search key", { hint: `Add your own ${s.helper.info.name} key (get one at ${s.helper.info.key_url}) in the X-Search-Key header.` });
      try {
        if (route === "GET /api/search/key-check") {
          try { await s.helper.checkKey(c, s.key); return json({ search_provider: s.helper.info.id, key_works: true }, 200, h); }
          catch (e) {
            if (!(e instanceof HttpError) || e.status >= 500) throw e;
            return json({ search_provider: s.helper.info.id, key_works: false, error: s.helper.friendly(e) || e.message }, 200, h);
          }
        }
        const max = Math.max(1, Math.min(10, Number(body.max) || 8));
        return json({ search_provider: s.helper.info.id, results: await runSearch(c, s.helper, s.key, body.query, { max }) }, 200, h);
      } catch (e) {
        if (e instanceof HttpError && !e.details?.hint) e.details = { ...e.details, hint: s.helper.friendly(e) };
        throw e;
      }
    }
    if (route === "POST /api/agent/finish") {
      await rateLimit(req, env, "finish", 60, 3600);
      return json({ provider: "local", ...(await maybeSave(req, env, who, body, await finishFromResearch(c, body))) }, 200, h);
    }

    provider = pickProvider(req, body);
    const ctx = providerCtx(req, provider, c);
    const saved = await userKey(req, provider, who, env || {});
    const key = saved.key;
    if (body && !body.model && saved.model) body.model = saved.model;
    const agentOpts = async () => ({ ctx, search: searchesItself(provider) ? null : await searchFor(req, body, who, env || {}, provider, key) });

    switch (route) {
      case "GET /api/key-check":
        try { await provider.checkKey(c, key, ctx); return json({ provider: provider.info.id, key_works: true }, 200, h); }
        catch (e) {
          if (!(e instanceof HttpError) || e.status >= 500) throw e;
          return json({ provider: provider.info.id, key_works: false, error: provider.friendly(e) || e.message }, 200, h);
        }
      case "GET /api/models":
        return json({ provider: provider.info.id, default: provider.info.default_model, models: await provider.listModels(c, key, ctx) }, 200, h);
      case "POST /api/ask":
        if (body.search && !searchesItself(provider)) throw new HttpError(400, `${provider.info.name} can't search the web by itself`, { hint: "Use /api/agent/find-products, which pairs it with a search helper." });
        return json({ provider: provider.info.id, ...(await provider.ask(c, key, body, ctx)) }, 200, h);
      case "POST /api/agent/find-products":
        return json({ provider: provider.info.id, ...(await maybeSave(req, env, who, body, await findProducts(c, provider, key, body, await agentOpts()))) }, 200, h);
      case "POST /api/agent/rebuild-list":
        return json({ provider: provider.info.id, ...(await maybeSave(req, env, who, body, await rebuildList(c, provider, key, body, await agentOpts()))) }, 200, h);
    }
    return json({ error: "not found" }, 404, h);
  } catch (e) {
    const known = e instanceof HttpError;
    const status = known && e.status >= 400 && e.status < 600 ? e.status : 500;
    const out = { error: known ? e.message : "unexpected server error" };
    const hint = e.details?.hint || (known && provider ? provider.friendly(e) : null);
    if (hint) out.hint = hint;
    if (!known) console.error(route, e?.stack || e); // never logs headers, so keys stay out of logs
    return json(out, status, h);
  }
}
