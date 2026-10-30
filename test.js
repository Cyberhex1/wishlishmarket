// Offline tests against a fake Gemini and fake store pages: node --test test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handle } from "./app.js";
import { buildInteraction } from "./providers/gemini.js";
import { toItems, toPick } from "./agent.js";

const KEY = "AIzaTestKey_1234567890abcdef";
let mock, origin, base, calls = [], script = [];
const PAGES = {
  "/shop/ok": { status: 200, html: '<html><head><meta property="og:image" content="https://img.example/ok.jpg"></head>In stock</html>' },
  "/shop/oos": { status: 200, html: "<html>Currently unavailable.</html>" },
  "/shop/gone": { status: 200, html: "<html>This item is no longer available</html>" },
  "/shop/404": { status: 404, html: "nope" },
  "/shop/blocked": { status: 503, html: "robot check" },
  "/shop/to-search": { status: 302, location: "/s?k=thing" },
  "/shop/captcha": { status: 200, html: "<html>Enter the characters you see below. This item is no longer available</html>" },
  "/blocked": { status: 200, html: "Robot or human?" },
  "/shop/walmart-block": { status: 302, location: "/blocked?url=x" },
  "/s": { status: 200, html: "search results" },
};

before(async () => {
  mock = http.createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (PAGES[path]) {
      const p = PAGES[path];
      res.writeHead(p.status, p.location ? { Location: p.location } : { "Content-Type": "text/html" });
      return res.end(p.html || "");
    }
    let b = ""; for await (const c of req) b += c;
    const body = b ? JSON.parse(b) : null;
    calls.push({ method: req.method, url: req.url, key: req.headers["x-goog-api-key"], body });
    const next = script.length ? script.shift() : { status: 200, json: { id: "int_1", status: "completed", steps: [] } };
    const out = typeof next === "function" ? next(body, req) : next;
    res.writeHead(out.status, { "Content-Type": "application/json", ...(out.headers || {}) });
    res.end(JSON.stringify(out.json));
  });
  await new Promise(r => mock.listen(0, r));
  origin = `http://127.0.0.1:${mock.address().port}`;
  base = `${origin}/v1beta`;
});
after(() => mock.close());

const env = extra => ({ GEMINI_API_BASE: base, AI_RETRIES: "2", LINK_ALLOW_PRIVATE: "true", ...extra });
const reset = (...s) => { calls = []; script = s; };
const req = (method, path, body, headers = {}, key = KEY) => new Request(`http://x${path}`, {
  method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(key ? { "X-AI-Key": key } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const post = (body, e = env(), headers, key) => handle(req("POST", "/api/ask", body, headers, key), e);
const out = text => ({ type: "model_output", status: "done", content: [{ type: "text", text }] });
const ok = (...steps) => ({ status: 200, json: { id: "i", status: "completed", steps } });

// ---------- bring your own key ----------

test("health needs no key and stores none", async () => {
  reset();
  const j = await (await handle(req("GET", "/api/health", undefined, {}, null), env())).json();
  assert.equal(j.ok, true);
  assert.equal(j.byo_key, true);
  assert.equal(j.auth_required, false);
  assert.ok(j.providers.includes("gemini") && j.providers.includes("openai") && j.providers.includes("anthropic"));
  assert.deepEqual(j.search_helpers, ["tavily", "brave", "perplexity", "ollama"]);
  assert.equal(calls.length, 0);
});

test("providers lists Gemini with where to get a key", async () => {
  const j = await (await handle(req("GET", "/api/providers", undefined, {}, null), env())).json();
  assert.equal(j.default, "gemini");
  assert.equal(j.providers[0].key_url, "https://aistudio.google.com/apikey");
});

test("no key means 401 with a hint, and a server env key is ignored", async () => {
  reset();
  const r = await post({ prompt: "hi" }, env({ GEMINI_API_KEY: "AIzaServerKeyShouldNotBeUsed_123" }), {}, null);
  assert.equal(r.status, 401);
  assert.match((await r.json()).hint, /your own/);
  assert.equal(calls.length, 0);
});

test("the caller's key is forwarded to Google and never echoed", async () => {
  reset(ok(out("hello")));
  const r = await post({ prompt: "hi" });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.equal(calls[0].key, KEY);
  assert.ok(!text.includes(KEY));
});

test("junk keys are refused before any call", async () => {
  reset();
  const r = await post({ prompt: "hi" }, env(), {}, "short");
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("unknown provider is a clear 400", async () => {
  const r = await post({ prompt: "hi" }, env(), { "X-AI-Provider": "nope" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).hint, /gemini/);
});

test("key-check reports a bad key in plain words (array-wrapped error, as seen live)", async () => {
  reset({ status: 400, json: [{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
    details: [{ reason: "API_KEY_INVALID" }] } }] });
  const j = await (await handle(req("GET", "/api/key-check"), env())).json();
  assert.equal(j.key_works, false);
  assert.match(j.error, /aistudio/);
});

test("key-check passes a good key", async () => {
  reset({ status: 200, json: { models: [] } });
  assert.equal((await (await handle(req("GET", "/api/key-check"), env())).json()).key_works, true);
});

// ---------- ask ----------

test("ask builds an Interactions request and reads model_output", async () => {
  reset({ status: 200, json: { id: "int_9", status: "completed", usage: { total_tokens: 12 }, steps: [out("Hello "), out("there")] } });
  const j = await (await post({ prompt: "hi", system: "be brief", thinking: "low", max_tokens: 100 })).json();
  assert.equal(j.text, "Hello there");
  assert.equal(j.provider, "gemini");
  assert.equal(calls[0].url, "/v1beta/interactions");
  assert.deepEqual(calls[0].body, { model: "gemini-3.8-flash", input: "hi", store: false, system_instruction: "be brief",
    generation_config: { thinking_level: "low", max_output_tokens: 100 } });
});

test("search returns citations and queries", async () => {
  reset(ok({ type: "google_search_call", arguments: { queries: ["q1"] } },
    { type: "model_output", content: [{ type: "text", text: "x", annotations: [{ url: "https://a.example", title: "A" }, { url: "https://a.example" }] }] }));
  const j = await (await post({ prompt: "x", search: true })).json();
  assert.deepEqual(calls[0].body.tools, [{ type: "google_search" }]);
  assert.deepEqual(j.citations, [{ title: "A", url: "https://a.example" }]);
  assert.deepEqual(j.search_queries, ["q1"]);
});

test("schema output is parsed; bad JSON is flagged", async () => {
  reset(ok(out('{"a":1}')), ok(out("nope")));
  assert.deepEqual((await (await post({ prompt: "x", schema: { type: "object" } })).json()).data, { a: 1 });
  const j = await (await post({ prompt: "x", json: true })).json();
  assert.equal(j.data, null);
  assert.match(j.warning, /valid JSON/);
});

test("retired default model falls back; a named model does not", async () => {
  const nf = { status: 404, json: { error: { message: "not found", status: "NOT_FOUND" } } };
  reset(nf, ok(out("ok")));
  const j = await (await post({ prompt: "x" })).json();
  assert.equal(j.model, "gemini-3.5-flash-lite");
  assert.equal(j.fell_back_from, "gemini-3.8-flash");
  reset(nf);
  const r = await post({ prompt: "x", model: "gone" });
  assert.equal(r.status, 404);
  assert.equal(calls.length, 1);
});

test("rate limits retry, then give 429 with a hint", async () => {
  const q = { status: 429, headers: { "Retry-After": "0" }, json: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } } };
  reset(q, ok(out("ok")));
  assert.equal((await (await post({ prompt: "x" })).json()).text, "ok");
  reset(q, q);
  const r = await post({ prompt: "x" }, env({ AI_RETRIES: "1" }));
  assert.equal(r.status, 429);
  assert.match((await r.json()).hint, /rate limit/);
});

test("continuations are stitched; incomplete is flagged; failed is 502", async () => {
  reset({ status: 200, json: { id: "i", status: "requires_continuation", continuation_token: "t", steps: [out("a ")] } },
        b => ok(out(b.continuation_token === "t" ? "b" : "WRONG")));
  assert.equal((await (await post({ prompt: "x" })).json()).text, "a b");
  reset({ status: 200, json: { id: "i", status: "incomplete", steps: [out("cut")] } });
  assert.equal((await (await post({ prompt: "x" })).json()).truncated, true);
  reset({ status: 200, json: { id: "i", status: "failed", steps: [] } });
  assert.equal((await post({ prompt: "x" })).status, 502);
});

test("request building: follow-ups, urls", () => {
  const b = buildInteraction({ prompt: "and?", previous_id: "int_1", urls: ["https://walmart.com/ip/1"] });
  assert.equal(b.store, true);
  assert.equal(b.previous_interaction_id, "int_1");
  assert.deepEqual(b.tools, [{ type: "url_context" }]);
});

test("input validation and routing", async () => {
  reset();
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ prompt: "x".repeat(60001) })).status, 413);
  assert.equal((await post({ prompt: "x", thinking: "max" })).status, 400);
  assert.equal((await post({ prompt: "x", urls: ["ftp://a"] })).status, 400);
  assert.equal((await post([1])).status, 400);
  assert.equal((await post("{")).status, 400);
  assert.equal((await handle(new Request("http://x/api/ask", { method: "POST", headers: { "X-AI-Key": KEY }, body: "{}" }), env())).status, 415);
  assert.equal((await handle(req("GET", "/api/ask"), env())).status, 405);
  assert.equal((await handle(req("GET", "/nope"), env())).status, 404);
  assert.equal(calls.length, 0);
});

test("optional site token and CORS", async () => {
  assert.equal((await post({ prompt: "x" }, env({ BACKEND_TOKEN: "s3" }))).status, 401);
  reset(ok(out("ok")));
  assert.equal((await post({ prompt: "x" }, env({ BACKEND_TOKEN: "s3" }), { "X-Backend-Token": "s3" })).status, 200);
  const pre = await handle(new Request("http://x/api/ask", { method: "OPTIONS", headers: { Origin: "https://a.com" } }), env({ ALLOWED_ORIGINS: "https://a.com" }));
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /X-AI-Key/);
});

test("models list pages and strips the prefix", async () => {
  reset({ status: 200, json: { models: [{ name: "models/gemini-3.8-flash" }], nextPageToken: "p2" } },
        { status: 200, json: { models: [{ name: "models/gemini-3.5-flash-lite" }] } });
  const j = await (await handle(req("GET", "/api/models"), env())).json();
  assert.deepEqual(j.models.map(m => m.id), ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
});

test("network failure is a clean 502", async () => {
  const r = await post({ prompt: "x" }, env({ GEMINI_API_BASE: "http://127.0.0.1:1/v1beta", AI_RETRIES: "0" }));
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Could not reach Gemini/);
});

// ---------- agent jobs ----------

const product = (rank, name, path, extra = {}) => ({ rank, type: rank <= 2 ? "Wired" : "Wireless", name, brand: "Acme", store: "amazon",
  price: 10 * rank, url: `${origin}${path}`, why: "fits", prosGeneral: ["a"], consGeneral: ["b"], vsList: "c", performance: 8, priceScore: 6, ...extra });

test("find-products: research, shape, link check, 10-item list format", async () => {
  const products = [
    product(3, "Gamma", "/shop/blocked"),
    product(1, "Alpha", "/shop/ok"),
    product(2, "Beta", "/shop/oos"),
    product(4, "Delta", "/shop/gone"),
    product(5, "Eps", "/shop/404"),
    product(6, "Zeta", "/shop/to-search"),
    product(7, "Alpha dup", "/shop/ok"),
  ];
  reset(ok({ type: "google_search_call", arguments: { queries: ["headset"] } },
          { type: "model_output", content: [{ type: "text", text: "research notes", annotations: [{ url: "https://src.example", title: "Src" }] }] }),
        ok(out(JSON.stringify({ title: "Headsets with Mic", category: "Electronics & Computers", summary: "Headsets under $50", products }))));
  const r = await handle(req("POST", "/api/agent/find-products", { request: "headset with mic under $50", stores: ["amazon"], count: 10 }), env());
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual(calls[0].body.tools, [{ type: "google_search" }]);
  assert.ok(calls[1].body.response_format.schema);
  assert.equal(calls[1].body.tools, undefined);
  const L = j.list;
  assert.equal(L.title, "Headsets with Mic");
  assert.deepEqual(L.storeIds, ["amazon"]);
  assert.deepEqual(L.items.map(i => i.picks[0].name), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(L.items.map(i => [i.type, i.rank]), [["Wired", 1], ["Wired", 2], ["Wireless", 3]]);
  assert.ok(L.items.every(i => i.picks.length === 1));
  const [a, b, g] = L.items.map(i => i.picks[0]);
  assert.equal(a.image, "https://img.example/ok.jpg");
  assert.equal(b.availability, "out_of_stock");
  assert.equal(g.availability, "unknown");
  assert.equal(a.score, 7.2); // 0.6*8 + 0.4*6
  assert.deepEqual(j.removed.map(x => [x.name, x.reason]), [["Delta", "listing removed"], ["Eps", "404"], ["Zeta", "redirects to a search or home page"]]);
  assert.match(j.warnings[0], /Only 3 of 10/);
  assert.deepEqual(j.sources, [{ title: "Src", url: "https://src.example" }]);
  assert.match(L.summary, /3 items, \$10\.00–\$30\.00/);
});

test("bot walls keep the pick as unknown instead of deleting it", async () => {
  const { checkLink } = await import("./agent.js");
  const c = { linkTimeoutMs: 3000, allowPrivateLinks: true };
  assert.deepEqual(await checkLink(`${origin}/shop/captcha`, c), { ok: true, availability: "unknown", checked: false, note: "store blocked the check (200)" });
  assert.equal((await checkLink(`${origin}/shop/walmart-block`, c)).availability, "unknown");
  assert.equal((await checkLink(`${origin}/shop/ok`, c)).image, "https://img.example/ok.jpg");
});

test("find-products refuses private/internal links without the test flag", async () => {
  reset(ok(out("notes")), ok(out(JSON.stringify({ title: "T", products: [product(1, "Alpha", "/shop/ok")] }))));
  const j = await (await handle(req("POST", "/api/agent/find-products", { request: "x" }), env({ LINK_ALLOW_PRIVATE: "false" }))).json();
  assert.equal(j.list.items.length, 0);
  assert.equal(j.removed[0].reason, "no valid link");
});

test("find-products input checks", async () => {
  reset();
  assert.equal((await handle(req("POST", "/api/agent/find-products", {}), env())).status, 400);
  assert.equal((await handle(req("POST", "/api/agent/find-products", { request: "x".repeat(4001) }), env())).status, 413);
  reset(ok(out("notes")), ok(out("{}")));
  assert.equal((await handle(req("POST", "/api/agent/find-products", { request: "x" }), env())).status, 502);
});

test("rebuild-list keeps id, title, project, stores, notes and old photos", async () => {
  const old = { id: "headsets", title: "Headset with Mic", projectId: "headset", storeIds: ["amazon", "walmart"], category: "Electronics",
    createdAt: "2026-10-01T00:00:00Z", summary: "Comfy headsets",
    items: [{ id: "x", need: "Headset with mic", notes: "Comfort first", picks: [{ url: `${origin}/shop/ok`, image: "/img/old.jpg" }] }] };
  reset(ok(out("notes")), ok(out(JSON.stringify({ title: "New name", products: [product(1, "Alpha", "/shop/ok")] }))));
  const j = await (await handle(req("POST", "/api/agent/rebuild-list", { list: old }), env())).json();
  assert.equal(j.list.id, "headsets");
  assert.equal(j.list.title, "Headset with Mic");
  assert.equal(j.list.projectId, "headset");
  assert.deepEqual(j.list.storeIds, ["amazon", "walmart"]);
  assert.equal(j.list.createdAt, "2026-10-01T00:00:00Z");
  assert.notEqual(j.list.updatedAt, old.createdAt);
  assert.equal(j.list.items[0].picks[0].image, "/img/old.jpg");
  assert.match(calls[0].body.input, /Comfort first/);
  assert.match(calls[0].body.input, /amazon, walmart/);
  assert.equal((await handle(req("POST", "/api/agent/rebuild-list", {}), env())).status, 400);
});

test("toPick clamps scores and toItems makes unique ids grouped by type", () => {
  const p = toPick({ rank: 2, name: "Acme X", brand: "Acme", url: "https://www.walmart.com/ip/1", performance: 14, priceScore: -3 }, "2026-10-29");
  assert.equal(p.store, "walmart");
  assert.deepEqual(p.scoreParts, { performance: 10, price: 0 });
  const items = toItems([{ ...p, _type: "B", rank: 3 }, { ...p, _type: "A", rank: 1 }, { ...p, _type: "B", rank: 2 }]);
  assert.deepEqual(items.map(i => [i.type, i.rank]), [["A", 1], ["B", 2], ["B", 3]]);
  assert.equal(new Set(items.map(i => i.id)).size, 3);
  assert.equal(items[0].id, "acme-x");
});
