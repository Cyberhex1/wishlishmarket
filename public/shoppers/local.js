// Local shoppers: AI models running on the user's own computer (Ollama,
// LM Studio, llama.cpp, vLLM, ...). WishlistMarket's server can't reach the
// user's computer, so the browser talks to the model directly, sends web
// searches through the backend's /api/search (with the user's search key),
// and hands the picks to /api/agent/finish, which checks every link and
// makes the list.
//
// Checked on 2026-10-29:
//   Ollama     POST http://localhost:11434/api/chat with `format` (a JSON schema)
//              and options.num_ctx; GET /api/tags lists pulled models. The site
//              must be in OLLAMA_ORIGINS or the browser is refused.
//   LM Studio  OpenAI-compatible at http://localhost:1234/v1 (chat/completions
//              with response_format json_schema; GET /models). "Enable CORS"
//              must be on. Default context is 4096 tokens, too short here.

import { SYSTEM, helperResearch, strictSchema, schemaHint, extractJson, rebuildInput } from "./pipeline.js";

const CTX = 16384;
const CALL_TIMEOUT = 10 * 60 * 1000; // big local models can be slow on long prompts

export class LocalError extends Error {
  constructor(message, hint, status) { super(message); this.hint = hint; this.status = status; }
}

const clean = base => String(base || "").trim().replace(/\/+$/, "");

async function timed(url, init = {}, ms = CALL_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// When fetch fails we can't see why. A no-cors request still goes through
// when the server is up, so it tells "not running" from "running but not
// allowing this site".
async function diagnose(runtime, base) {
  const root = runtime.api === "ollama" ? base : base.replace(/\/v1$/, "");
  let up = false;
  try { await timed(root, { mode: "no-cors" }, 5000); up = true; } catch (_) { /* not reachable */ }
  const origin = location.origin;
  if (up) {
    if (runtime.api === "ollama") return new LocalError("Ollama is running but isn't allowing this site to use it.",
      `Set OLLAMA_ORIGINS to ${origin} and restart Ollama (steps on the Shoppers page). If your browser asked to let this site use apps on your device, choose Allow.`);
    return new LocalError("The server is running but isn't allowing this site to use it.",
      runtime.id === "lmstudio" ? "In LM Studio's Developer tab, open Server Settings and turn on Enable CORS." : `Turn on CORS for ${origin} on your server.`);
  }
  return new LocalError(`Can't reach ${runtime.title || "the local server"} at ${base}.`,
    `Make sure it's running on this computer${runtime.api === "ollama" ? " (the Ollama app is open)" : runtime.id === "lmstudio" ? " (LM Studio's server is On)" : ""}, and use this site from a browser on the same computer (Chrome, Edge or Firefox). If the browser asked about apps on your device, choose Allow.`);
}

async function getJson(runtime, base, path, init, ms) {
  let r;
  try { r = await timed(`${base}${path}`, init, ms); }
  catch (e) {
    if (e.name === "AbortError") throw new LocalError("The local model took too long to answer.", "Try a smaller model, or a shorter request.", 504);
    throw await diagnose(runtime, base);
  }
  let j = null;
  try { j = await r.json(); } catch (_) { /* not JSON */ }
  if (!r.ok) {
    const m = j?.error?.message || j?.error || `${runtime.title || "Local server"} error ${r.status}`;
    const e = new LocalError(String(m), null, r.status);
    if (r.status === 404 && /model/i.test(m)) e.hint = runtime.api === "ollama" ? "That model isn't downloaded. Run: ollama pull <model>" : "Load the model in LM Studio first.";
    throw e;
  }
  return j || {};
}

// ---------- the two kinds of local API ----------

function ollamaApi(runtime, base) {
  return {
    async models() {
      const j = await getJson(runtime, base, "/api/tags", { method: "GET" }, 15000);
      return (j.models || []).map(m => ({ id: m.model || m.name, name: m.name, size_gb: m.size ? Math.round(m.size / 1e8) / 10 : null }));
    },
    async ask(model, { system, prompt, schema }) {
      const body = {
        model, stream: false,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt + (schema ? "\n\nAnswer with only the JSON object." : "") }],
        options: { num_ctx: CTX, temperature: 0.2 },
      };
      if (schema) body.format = schema;
      const j = await getJson(runtime, base, "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = j.message?.content || "";
      return { text, data: schema ? extractJson(text) : null, model: j.model || model, usage: { input: j.prompt_eval_count, output: j.eval_count } };
    },
  };
}

function openaiApi(runtime, base, key) {
  const headers = { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  return {
    async models() {
      const j = await getJson(runtime, base, "/models", { method: "GET", headers }, 15000);
      return (j.data || []).map(m => ({ id: m.id, name: m.id })).filter(m => !/embed/i.test(m.id));
    },
    async ask(model, { system, prompt, schema }) {
      const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
      const body = { model, messages, stream: false, temperature: 0.2, max_tokens: 8000 };
      let j;
      if (schema) {
        try {
          j = await getJson(runtime, base, "/chat/completions", { method: "POST", headers,
            body: JSON.stringify({ ...body, response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: strictSchema(schema) } } }) });
        } catch (e) {
          // Servers without schema support: ask in words instead.
          if (e.status !== 400 && e.status !== 422) throw e;
        }
      }
      if (!j) {
        const m2 = schema ? [...messages.slice(0, -1), { role: "user", content: prompt + schemaHint(schema) }] : messages;
        j = await getJson(runtime, base, "/chat/completions", { method: "POST", headers, body: JSON.stringify({ ...body, messages: m2 }) });
      }
      const text = j.choices?.[0]?.message?.content || "";
      if (j.choices?.[0]?.finish_reason === "length" && runtime.id === "lmstudio" && !extractJson(text)) {
        throw new LocalError("The model ran out of room before finishing.", `Load the model in LM Studio with a context length of ${CTX} or more.`);
      }
      return { text, data: schema ? extractJson(text) : null, model: j.model || model, usage: j.usage || null };
    },
  };
}

export function connect(runtime, base, key) {
  const b = clean(base || runtime.base);
  return runtime.api === "ollama" ? ollamaApi(runtime, b) : openaiApi(runtime, b, key);
}

// Is the runtime reachable from this page, and does it have the model?
export async function testConnection(runtime, base, model, key) {
  const api = connect(runtime, base, key);
  const models = await api.models();
  const out = { ok: true, models };
  if (model && !models.some(m => m.id === model || m.id === `${model}:latest` || m.id.replace(/:latest$/, "") === model)) {
    out.ok = false;
    out.error = `${model} isn't downloaded yet.`;
    out.hint = runtime.api === "ollama" ? `Run: ollama pull ${model}` : "Download and load it in LM Studio, then try again.";
  }
  return out;
}

// ---------- the shopping job ----------

async function backend(path, { headers = {}, body }) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  if (!r.ok) { const e = new LocalError(j.error || `Error ${r.status}`, j.hint, r.status); throw e; }
  return j;
}

// member: { runtime (catalog entry incl. id, api, base), base?, model, key? }
// search: { provider, key? } (key can be left out when it's saved in the account)
// route: "agent/find-products" | "agent/rebuild-list"
export async function run(member, route, body, { search, onStep = () => {} } = {}) {
  if (!member.model) throw new LocalError("Pick a model for this local shopper first.");
  const api = connect(member.runtime, member.base, member.key);
  const input = route === "agent/rebuild-list" ? rebuildInput(body.list, body) : { ...body };
  if (!input.request) throw new LocalError("Tell the shopper what to shop for.");
  const count = Math.min(20, Math.max(1, Math.round(+input.count || 10)));
  const want = Math.min(25, count + 4);
  const sHeaders = { "X-Search-Provider": search?.provider || "tavily", ...(search?.key ? { "X-Search-Key": search.key } : {}) };

  // Make sure the model is reachable before any searches are spent.
  onStep("Connecting to your shopper");
  await api.models();

  const research = await helperResearch({
    input: { ...input, count }, want, step: onStep,
    ask: q => api.ask(member.model, q),
    search: async q => (await backend("/api/search", { headers: sHeaders, body: { query: q, max: 8 } })).results,
  });
  if (!research.data.products.length) {
    throw new LocalError("The shopper didn't pick any products from the search results.", "Try again, or hire a bigger model for this kind of list.");
  }
  onStep("Checking every link");
  const out = await backend("/api/agent/finish", { body: {
    ...input, count, list: body.list, save: body.save,
    data: research.data, sources: research.sources, model: research.model || member.model,
  } });
  return { ...out, provider: member.runtime.id, model: research.model || member.model, search_queries: research.queries };
}

// One plain question (no web search), e.g. to check the model answers at all.
export async function ask(member, { system = SYSTEM, prompt, schema }) {
  return connect(member.runtime, member.base, member.key).ask(member.model, { system, prompt, schema });
}
