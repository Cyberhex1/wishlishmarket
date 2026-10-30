// Offline tests for every hireable shopper: node --test shoppers.test.js
// A fake server stands in for each provider's API (same paths, headers and
// answer shapes as their docs and the live probes on 2026-10-29), for the
// search helpers, and for store pages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handle } from "./app.js";
import { PROVIDERS } from "./providers/index.js";
import { SEARCH_HELPERS } from "./search/index.js";
import { HOSTED, suggest, findGpu, LOCAL_MODELS } from "./public/shoppers/catalog.js";
import { strictSchema, closedSchema, extractJson, groundProducts, PICKS_SCHEMA } from "./public/shoppers/pipeline.js";
import { buildMessage } from "./providers/anthropic.js";

let mock, o, calls = [], serve = () => ({ status: 404, json: { error: "no route" } });
const PAGES = {
  "/shop/a": "<html>Widget A. In stock</html>", "/shop/b": "<html>Widget B</html>", "/shop/c": "<html>Widget C</html>",
  "/shop/d": "<html>Widget D</html>", "/shop/oos": "<html>Currently unavailable.</html>",
};

before(async () => {
  mock = http.createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (PAGES[path]) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(PAGES[path]); }
    if (path === "/shop/dead") { res.writeHead(404); return res.end(); }
    let b = ""; for await (const c of req) b += c;
    const body = b ? JSON.parse(b) : null;
    const call = { method: req.method, path, url: req.url, headers: req.headers, body };
    calls.push(call);
    const r = serve(call) || { status: 404, json: { error: "no route" } };
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.json));
  });
  await new Promise(r => mock.listen(0, r));
  o = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

const bases = () => ({
  openai: `${o}/openai/v1`, xai: `${o}/xai/v1`, anthropic: `${o}/anthropic/v1`, perplexity: `${o}/pplx`, openrouter: `${o}/or/v1`,
  deepseek: `${o}/ds`, mistral: `${o}/mistral/v1`, groq: `${o}/groq/v1`, "ollama-cloud": `${o}/ollama/v1`, "ollama-site": `${o}/ollama`,
  tavily: `${o}/tavily`, brave: `${o}/brave/v1`,
});
const env = extra => ({ AI_RETRIES: "0", LINK_ALLOW_PRIVATE: "true", AI_API_BASES: JSON.stringify(bases()), ...extra });
const go = (method, path, body, headers = {}, e = env()) => handle(new Request(`http://x${path}`, {
  method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body) }), e);
const reset = fn => { calls = []; serve = fn; };

// Fake, real-shaped keys, joined at run time so secret scanners don't flag them.
const A = "abcdefghijklmnopqrstuvwxyz";
const KEYS = {
  gemini: "AIza" + "SyA" + A.slice(0, 1).toUpperCase() + A.slice(1) + "0123456",
  openai: "sk-" + "proj-" + A + "012345", xai: "xai-" + A + "012345",
  anthropic: "sk-" + "ant-api03-" + A, perplexity: "pplx-" + A + "012345",
  openrouter: "sk-" + "or-v1-" + A + "0123", deepseek: "sk-" + A + "012345",
  mistral: "AbCdEfGhIjKlMnOp" + "QrStUvWxYz012345", groq: "gsk_" + A + "012345",
  "ollama-cloud": "0123456789abcdef0123456789abcdef" + ".ABCDEFGHIJKLMNOP", custom: "anything-goes-123",
};
const H = (id, extra = {}) => ({ "X-AI-Provider": id, "X-AI-Key": KEYS[id], ...extra });

// Picks the fake research "found": three live pages, one dead one.
const product = (rank, path, extra = {}) => ({ rank, type: "Widgets", name: `Widget ${path.slice(-1).toUpperCase()}`, brand: "Acme", store: "Example",
  price: 10 + rank, url: `${o}${path}`, why: "Fits", prosGeneral: ["Good"], consGeneral: ["Meh"], performance: 8, priceScore: 7, ...extra });
const picks = () => ({ title: "Widgets", category: "Home & Kitchen", summary: "Widgets for the kitchen",
  products: [product(1, "/shop/a"), product(2, "/shop/dead"), product(3, "/shop/b"), product(4, "/shop/c")] });
const searchResults = () => [
  { title: "Widget A at Example", url: `${o}/shop/a`, content: "Widget A, $11" },
  { title: "Widget B at Example", url: `${o}/shop/b`, content: "Widget B, $13" },
  { title: "Widget C at Example", url: `${o}/shop/c`, content: "Widget C, $14" },
  { title: "Reddit thread", url: "https://www.reddit.com/r/widgets/x", content: "talk" },
];

// ---------- the catalog ----------

test("every provider is complete and has a résumé on the Hire page", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.info.id, id);
    for (const f of ["ask", "listModels", "checkKey", "friendly", "looksLikeKey"]) assert.equal(typeof p[f], "function", `${id}.${f}`);
    assert.ok(HOSTED[id]?.steps?.length, `${id} has setup steps`);
    if (id !== "custom") {
      assert.ok(p.info.default_model, `${id} default model`);
      assert.ok(p.looksLikeKey(KEYS[id]), `${id} accepts a real-shaped key`);
      assert.ok(!p.looksLikeKey("nope"), `${id} refuses junk`);
    }
  }
  for (const [id, s] of Object.entries(SEARCH_HELPERS)) {
    assert.equal(s.info.id, id);
    assert.ok(s.info.key_url && s.info.free && s.info.cost);
  }
});

test("GET /api/shoppers lists hosted (popular first), search helpers and local runtimes", async () => {
  const j = await (await go("GET", "/api/shoppers")).json();
  assert.deepEqual(j.hosted.slice(0, 3).map(h => h.id), ["gemini", "openai", "anthropic"]);
  assert.equal(j.hosted.find(h => h.id === "deepseek").searches, false);
  assert.equal(j.hosted.find(h => h.id === "openai").searches, true);
  assert.deepEqual(j.local.map(l => l.id), ["ollama-local", "lmstudio", "local-openai"]);
  assert.ok(j.local.every(l => l.runs === "browser"));
  assert.ok(j.search_helpers.find(s => s.id === "tavily").recommended);
});

// ---------- providers that search the web themselves ----------

test("OpenAI: Responses API with web_search, then strict JSON; dead links dropped", async () => {
  reset(c => {
    if (c.path !== "/openai/v1/responses") return;
    if (c.body.tools) return { status: 200, json: { id: "r1", status: "completed", output: [
      { type: "web_search_call", action: { type: "search", query: "best widgets" } },
      { type: "message", content: [{ type: "output_text", text: "Widget A is great...", annotations: [{ type: "url_citation", url: `${o}/shop/a`, title: "A" }] }] }] } };
    return { status: 200, json: { id: "r2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(picks()), annotations: [] }] }] } };
  });
  const r = await go("POST", "/api/agent/find-products", { request: "widgets", count: 3 }, H("openai"));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, `Bearer ${KEYS.openai}`);
  assert.deepEqual(calls[0].body.tools, [{ type: "web_search" }]);
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.model, "gpt-6.1-sol");
  const fmt = calls[1].body.text.format;
  assert.equal(fmt.type, "json_schema"); assert.equal(fmt.strict, true);
  assert.deepEqual(fmt.schema.properties.products.items.required.sort(), Object.keys(fmt.schema.properties.products.items.properties).sort());
  assert.equal(j.list.items.length, 3);
  assert.deepEqual(j.removed.map(x => x.reason), ["404"]);
  assert.deepEqual(j.sources, [{ title: "A", url: `${o}/shop/a` }]);
  assert.ok(!JSON.stringify(j).includes(KEYS.openai));
});

test("OpenAI: a model without strict JSON falls back to asking in words", async () => {
  let n = 0;
  reset(c => {
    n++;
    if (c.body.text) return { status: 400, json: { error: { message: "Unsupported parameter: 'text.format' is not supported with this model.", type: "invalid_request_error" } } };
    return { status: 200, json: { output: [{ type: "message", content: [{ type: "output_text", text: '```json\n{"ok":true}\n```' }] }] } };
  });
  const j = await (await go("POST", "/api/ask", { prompt: "x", schema: { type: "object", properties: { ok: { type: "boolean" } } } }, H("openai"))).json();
  assert.deepEqual(j.data, { ok: true });
  assert.equal(n, 2);
  assert.match(calls[1].body.input, /JSON Schema/);
});

test("xAI Grok: same Responses shape at api.x.ai, no reasoning field, bad key 400 read as invalid key", async () => {
  reset(c => c.path === "/xai/v1/responses" && { status: 200, json: { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] } });
  const j = await (await go("POST", "/api/ask", { prompt: "hi", thinking: "high", search: true }, H("xai"))).json();
  assert.equal(j.text, "hi");
  assert.equal(calls[0].body.reasoning, undefined);
  assert.equal(calls[0].body.model, "grok-4.7");
  // xAI answers a bad key with 400 (seen live).
  reset(() => ({ status: 400, json: { code: "invalid-argument", error: "Incorrect API key provided: xa***. You can obtain an API key from https://console.x.ai." } }));
  const k = await (await go("GET", "/api/key-check", undefined, H("xai"))).json();
  assert.equal(k.key_works, false);
  assert.match(k.error, /isn't valid/);
});

test("Claude: Messages API headers, closed schema, web search tool, refusal fallbacks, pause_turn", async () => {
  let n = 0;
  reset(c => {
    if (c.path !== "/anthropic/v1/messages") return;
    n++;
    if (n === 1) return { status: 200, json: { id: "m1", model: "claude-opus-5-5", stop_reason: "pause_turn", content: [
      { type: "server_tool_use", name: "web_search", input: { query: "best widgets" } },
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: `${o}/shop/a`, title: "A" }] }] } };
    if (n === 2) return { status: 200, json: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "Widget A", citations: [{ url: `${o}/shop/b`, title: "B" }] }] } };
    return { status: 200, json: { id: "m3", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(picks()) }] } };
  });
  const r = await go("POST", "/api/agent/find-products", { request: "widgets", count: 3 }, H("anthropic"));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const first = calls[0];
  assert.equal(first.headers["x-api-key"], KEYS.anthropic);
  assert.equal(first.headers["anthropic-version"], "2026-10-21");
  assert.equal(first.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(first.body.fallbacks, "default");
  assert.equal(first.body.tools[0].type, "web_search_20260209");
  assert.equal(first.body.temperature, undefined);
  // the paused turn is handed back unchanged
  assert.equal(calls[1].body.messages.at(-1).role, "assistant");
  assert.equal(calls[1].body.messages.at(-1).content[0].type, "server_tool_use");
  const fmt = calls[2].body.output_config.format;
  assert.equal(fmt.schema.additionalProperties, false);
  assert.equal(fmt.schema.properties.products.items.additionalProperties, false);
  assert.equal(j.list.items.length, 3);
  assert.deepEqual(j.sources.map(s => s.title).sort(), ["A", "B"]);
});

test("Claude: Haiku uses the basic search tool and no fallbacks; refusal and missing beta handled", async () => {
  const { body, betas } = buildMessage({ prompt: "x", search: true, model: "claude-haiku-5-5" });
  assert.equal(body.tools[0].type, "web_search_20250305");
  assert.equal(body.fallbacks, undefined); assert.deepEqual(betas, []);
  let n = 0;
  reset(c => {
    n++;
    if (c.body.fallbacks) return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "fallbacks: unknown beta" } } };
    return { status: 200, json: { stop_reason: "refusal", content: [] } };
  });
  const r = await go("POST", "/api/ask", { prompt: "x" }, H("anthropic"));
  assert.equal(n, 2);
  assert.equal(calls[1].headers["anthropic-beta"], undefined);
  assert.equal(r.status, 422);
});

test("Perplexity: Agent API with fast web search and max_steps; search_results become sources", async () => {
  reset(c => {
    if (c.path !== "/pplx/v1/agent") return;
    if (c.body.tools) return { status: 200, json: { id: "p1", status: "completed", output: [
      { type: "search_results", queries: ["widgets"], results: [{ url: `${o}/shop/a`, title: "A" }] },
      { type: "message", content: [{ type: "output_text", text: "notes", annotations: [] }] }] } };
    return { status: 200, json: { id: "p2", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(picks()) }] }] } };
  });
  const j = await (await go("POST", "/api/agent/find-products", { request: "widgets", count: 2 }, H("perplexity"))).json();
  assert.deepEqual(calls[0].body.tools, [{ type: "web_search", search_type: "fast", max_results: 10 }]);
  assert.equal(calls[0].body.max_steps, 6);
  assert.equal(calls[0].body.model, "openai/gpt-6.1-sol");
  assert.equal(calls[1].body.response_format.type, "json_schema");
  assert.equal(calls[1].body.response_format.json_schema.name, "result");
  assert.equal(calls[1].body.max_steps, 1);
  assert.equal(j.list.items.length, 2);
  assert.deepEqual(j.sources, [{ title: "A", url: `${o}/shop/a` }]);
});

test("OpenRouter: web plugin, attribution headers, url_citation annotations", async () => {
  reset(c => {
    if (c.path !== "/or/v1/chat/completions") return;
    if (c.body.plugins) return { status: 200, json: { choices: [{ finish_reason: "stop", message: { content: "notes",
      annotations: [{ type: "url_citation", url_citation: { url: `${o}/shop/a`, title: "A" } }] } }] } };
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(picks()) } }] } };
  });
  const j = await (await go("POST", "/api/agent/find-products", { request: "widgets", count: 3 }, H("openrouter"))).json();
  assert.deepEqual(calls[0].body.plugins, [{ id: "web", max_results: 8 }]);
  assert.equal(calls[0].headers["x-title"], "WishlistMarket");
  assert.equal(calls[0].body.model, "google/gemini-3.8-flash");
  assert.equal(calls[1].body.response_format.json_schema.strict, true);
  assert.deepEqual(j.sources, [{ title: "A", url: `${o}/shop/a` }]);
  assert.equal(j.list.items.length, 3);
});

// ---------- shoppers that use a search helper ----------

// A fake chat model that writes queries, then picks from the numbered results.
function chatShopper(path, { invent = false } = {}) {
  return c => {
    if (c.path === "/tavily/search") return { status: 200, json: { results: searchResults() } };
    if (c.path !== path) return;
    const text = JSON.stringify(c.body.messages || c.body.input || "");
    if (/search queries/.test(text)) return { status: 200, json: { choices: [{ message: { content: '{"queries":["kitchen widgets","widgets walmart"]}' } }] } };
    const products = [
      { rank: 1, source: 2, type: "Widgets", name: "Widget B", store: "Example", url: `${o}/shop/b`, why: "best" },
      { rank: 2, source: 1, type: "Widgets", name: "Widget A", store: "Example", url: invent ? "https://example.com/made-up" : `${o}/shop/a`, why: "ok" },
      { rank: 3, source: 9, type: "Widgets", name: "Ghost", store: "Nowhere", url: "https://ghost.example/x", why: "invented" },
    ];
    return { status: 200, json: { model: "m", choices: [{ message: { content: `<think>hmm</think>${JSON.stringify({ title: "Widgets", products })}` } }] } };
  };
}

test("DeepSeek: plans searches, Tavily runs them, picks only from results (invented links fixed or dropped)", async () => {
  reset(chatShopper("/ds/chat/completions", { invent: true }));
  const r = await go("POST", "/api/agent/find-products", { request: "widgets", count: 5 }, H("deepseek", { "X-Search-Provider": "tavily", "X-Search-Key": "tvly-dev-abc123" }));
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const searches = calls.filter(c => c.path === "/tavily/search");
  assert.equal(searches.length, 2);
  assert.equal(searches[0].headers.authorization, "Bearer tvly-dev-abc123");
  assert.equal(searches[0].body.search_depth, "basic");
  const ask = calls.find(c => c.path === "/ds/chat/completions");
  assert.equal(ask.body.response_format.type, "json_object"); // DeepSeek has JSON mode, not schemas
  assert.match(ask.body.messages.at(-1).content, /JSON Schema/);
  assert.deepEqual(j.list.items.map(i => i.picks[0].url), [`${o}/shop/b`, `${o}/shop/a`]); // made-up link moved to its source; ghost dropped
  assert.ok(!j.sources.some(s => /reddit/.test(s.url)));
});

test("a shopper without search and without a search key gets a clear 400", async () => {
  reset(chatShopper("/ds/chat/completions"));
  const r = await go("POST", "/api/agent/find-products", { request: "widgets" }, H("deepseek"));
  assert.equal(r.status, 400);
  assert.match((await r.json()).hint, /search helper/);
  assert.equal(calls.length, 0);
  const a = await go("POST", "/api/ask", { prompt: "x", search: true }, H("mistral"));
  assert.equal(a.status, 400);
});

test("a bad search key says which key is wrong", async () => {
  reset(c => {
    if (c.path === "/tavily/search") return { status: 401, json: { detail: { error: "Unauthorized: missing or invalid API key." } } };
    return chatShopper("/groq/v1/chat/completions")(c);
  });
  const r = await go("POST", "/api/agent/find-products", { request: "widgets" }, H("groq", { "X-Search-Key": "tvly-bad" }));
  assert.equal(r.status, 401);
  assert.match((await r.json()).hint, /Tavily/);
});

test("Groq: strict json_schema with max_completion_tokens; falls back to json_object when refused", async () => {
  let refused = false;
  reset(c => {
    if (c.body?.response_format?.type === "json_schema") { refused = true; return { status: 400, json: { error: { message: "response_format `json_schema` is not supported by this model", type: "invalid_request_error" } } }; }
    return { status: 200, json: { choices: [{ message: { content: '{"a":1}' } }] } };
  });
  const j = await (await go("POST", "/api/ask", { prompt: "x", schema: { type: "object", properties: { a: { type: "integer" } } } }, H("groq"))).json();
  assert.ok(refused);
  assert.deepEqual(j.data, { a: 1 });
  assert.equal(calls[0].body.max_completion_tokens, 8000);
  assert.equal(calls[0].body.model, "openai/gpt-oss-120b");
  assert.equal(calls[1].body.response_format.type, "json_object");
});

test("Mistral: strict schema; a bad key (detail field) is reported plainly", async () => {
  reset(() => ({ status: 401, json: { detail: "Invalid API Key" } }));
  const k = await (await go("GET", "/api/key-check", undefined, H("mistral"))).json();
  assert.equal(k.key_works, false);
  assert.match(k.error, /Mistral AI says this key isn't valid/);
});

test("Ollama Cloud: one key runs the model and Ollama web search; key check uses /api/me", async () => {
  reset(c => {
    if (c.path === "/ollama/api/web_search") return { status: 200, json: { results: searchResults() } };
    return chatShopper("/ollama/v1/chat/completions")(c);
  });
  const j = await (await go("POST", "/api/agent/find-products", { request: "widgets", count: 2 }, H("ollama-cloud"))).json();
  const s = calls.filter(c => c.path === "/ollama/api/web_search");
  assert.ok(s.length >= 2);
  assert.equal(s[0].headers.authorization, `Bearer ${KEYS["ollama-cloud"]}`);
  assert.ok(s[0].body.max_results <= 10);
  const ask = calls.find(c => c.path === "/ollama/v1/chat/completions");
  assert.equal(ask.body.response_format, undefined); // cloud models: schema goes in the prompt
  assert.equal(j.list.items.length, 2);
  reset(c => c.path === "/ollama/api/me" && { status: 401, json: { error: "invalid credentials" } });
  const k = await (await go("GET", "/api/key-check", undefined, H("ollama-cloud"))).json();
  assert.equal(k.key_works, false);
  assert.equal(calls[0].method, "POST");
});

test("Other online server: needs an https address, refuses the user's own network, needs a model", async () => {
  const noPrivate = env({ LINK_ALLOW_PRIVATE: "false" });
  let r = await go("POST", "/api/ask", { prompt: "x", model: "m" }, H("custom"), noPrivate);
  assert.equal(r.status, 400);
  r = await go("POST", "/api/ask", { prompt: "x", model: "m" }, H("custom", { "X-AI-Base-URL": "http://192.168.1.5:8000/v1" }), noPrivate);
  assert.equal(r.status, 400);
  r = await go("POST", "/api/ask", { prompt: "x", model: "m" }, H("custom", { "X-AI-Base-URL": "https://localhost/v1" }), noPrivate);
  assert.match((await r.json()).hint, /local shopper/);
  reset(c => c.path === "/custom/v1/chat/completions" && { status: 200, json: { choices: [{ message: { content: "ok" } }] } });
  r = await go("POST", "/api/ask", { prompt: "x" }, H("custom", { "X-AI-Base-URL": `${o}/custom/v1` }));
  assert.equal(r.status, 400); // no model
  r = await go("POST", "/api/ask", { prompt: "x", model: "my-model" }, { "X-AI-Provider": "custom", "X-AI-Base-URL": `${o}/custom/v1` });
  assert.equal((await r.json()).text, "ok"); // key is optional
  assert.equal(calls[0].headers.authorization, undefined);
});

// ---------- search route, finish route (used by local shoppers) ----------

test("POST /api/search runs the user's search helper (Brave format) and needs a key", async () => {
  reset(c => c.path === "/brave/v1/web/search" && { status: 200, json: { web: { results: [{ title: "<b>A</b>", url: `${o}/shop/a`, description: "Widget", extra_snippets: ["$11"] }] } } });
  const j = await (await go("POST", "/api/search", { query: "widgets" }, { "X-Search-Provider": "brave", "X-Search-Key": "BSAabc" })).json();
  assert.deepEqual(j.results, [{ title: "A", url: `${o}/shop/a`, snippet: "Widget $11" }]);
  assert.equal(calls[0].headers["x-subscription-token"], "BSAabc");
  assert.match(calls[0].url, /q=widgets&count=8/);
  assert.equal((await go("POST", "/api/search", { query: "x" }, { "X-Search-Provider": "brave" })).status, 401);
  reset(() => ({ status: 422, json: { error: { code: "SUBSCRIPTION_TOKEN_INVALID", detail: "The provided subscription token is invalid." } } }));
  const k = await (await go("GET", "/api/search/key-check", undefined, { "X-Search-Provider": "brave", "X-Search-Key": "bad" })).json();
  assert.equal(k.key_works, false);
  assert.match(k.error, /Brave Search says this key isn't valid/);
});

test("POST /api/agent/finish link-checks a local shopper's picks; with list it finishes a rebuild", async () => {
  reset(() => {});
  let r = await go("POST", "/api/agent/finish", { request: "widgets", count: 5, data: picks(), sources: [{ title: "A", url: `${o}/shop/a` }], model: "qwen3.5:9b" });
  let j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.list.items.length, 3);
  assert.equal(j.removed.length, 1);
  assert.equal(j.model, "qwen3.5:9b");
  const old = { id: "widgets-amazon", title: "Widgets · Amazon", projectId: "kitchen", storeIds: ["amazon"], createdAt: "2026-01-01",
    items: [{ need: "Widget", notes: "must be blue", picks: [{ url: `${o}/shop/a`, image: "https://img/old.jpg" }] }] };
  r = await go("POST", "/api/agent/finish", { list: old, data: picks() });
  j = await r.json();
  assert.equal(j.list.id, "widgets-amazon");
  assert.equal(j.list.title, "Widgets · Amazon");
  assert.equal(j.list.items.find(i => i.picks[0].url === `${o}/shop/a`).picks[0].image, "https://img/old.jpg");
  assert.equal((await go("POST", "/api/agent/finish", { request: "x" })).status, 400);
});

// ---------- the GPU suggester ----------

test("suggest hires 3 local shoppers that fit the card, with roles", async () => {
  const j = await (await go("GET", "/api/shoppers/suggest?gpu=RTX%204090")).json();
  assert.equal(j.usable_gb, 24);
  assert.deepEqual(j.hired.map(h => h.role), ["Lead shopper", "Second opinion", "Quick shopper"]);
  assert.ok(j.hired.every(h => h.needs_gb <= 24));
  assert.notEqual(j.hired[0].maker, j.hired[1].maker);
  assert.match(j.hired[0].install, /^ollama pull /);
  assert.equal((await go("GET", "/api/shoppers/suggest")).status, 400);
});

test("suggest: card matching, AMD/Intel get LM Studio, Macs use unified memory, tiny cards get the cloud", () => {
  assert.equal(findGpu("3060").name, "GeForce RTX 3060 12GB");
  assert.equal(findGpu("rx 7900xtx").gb, 24);
  assert.equal(findGpu("arc b580").gb, 12);
  assert.equal(suggest({ gpu: "RX 6700 XT" }).runtime.runtime, "lmstudio");
  assert.equal(suggest({ gpu: "RX 7900 XTX" }).runtime.runtime, "ollama-local");
  assert.equal(suggest({ gpu: "Arc B580" }).runtime.runtime, "lmstudio");
  assert.match(suggest({ gpu: "Arc B580" }).hired[0].install, /LM Studio/);
  const mac = suggest({ mac: true, ram: 16 });
  assert.equal(mac.usable_gb, 10);
  assert.ok(mac.hired.every(h => h.needs_gb <= 10));
  const tiny = suggest({ vram: 2 });
  assert.equal(tiny.hired.length, 0);
  assert.match(tiny.message, /cloud shopper/);
  // a 12 GB card with 32 GB RAM may use a MoE model split with the CPU, marked as slower
  const split = suggest({ vram: 12, ram: 32 }).hired.find(h => /partly on your CPU/.test(h.fit));
  if (split) assert.ok(LOCAL_MODELS.find(m => m.tag === split.tag).moe);
  for (const vram of [4, 6, 8, 10, 12, 16, 20, 24, 32, 48, 96]) {
    const s = suggest({ vram, ram: 64 });
    assert.ok(s.hired.length >= 2, `${vram} GB gets a team`);
    assert.equal(new Set(s.hired.map(h => h.tag)).size, s.hired.length);
  }
});

// ---------- shared pipeline helpers ----------

test("schemas for strict APIs, JSON extraction and grounding", () => {
  const st = strictSchema(PICKS_SCHEMA);
  const item = st.properties.products.items;
  assert.deepEqual(item.required.sort(), Object.keys(item.properties).sort());
  assert.deepEqual(item.properties.brand.type, ["string", "null"]);
  assert.ok(item.properties.availability.enum.includes(null));
  assert.equal(closedSchema(PICKS_SCHEMA).additionalProperties, false);
  assert.equal(PICKS_SCHEMA.additionalProperties, undefined); // not changed in place
  assert.deepEqual(extractJson('Sure! {"a":{"b":"}"}} trailing'), { a: { b: "}" } });
  assert.deepEqual(extractJson("<think>{no}</think>\n```json\n{\"x\":1}\n```"), { x: 1 });
  assert.equal(extractJson("no json here"), null);
  const src = [{ url: "https://a.com/p/1" }, { url: "https://b.com/p/2" }];
  const g = groundProducts([{ name: "x", url: "https://a.com/p/1/" }, { name: "y", url: "https://made.up", source: 2 }, { name: "z", url: "https://nope", source: 7 }, { name: "dup", url: "https://a.com/p/1" }], src);
  assert.deepEqual(g.map(p => p.url), ["https://a.com/p/1", "https://b.com/p/2"]);
});
