// Providers on the OpenAI Chat Completions format (POST .../chat/completions).
// Used for OpenRouter (which adds web search with its `web` plugin) and for
// shoppers that need a search helper: DeepSeek, Mistral, Groq, Ollama Cloud
// and any other OpenAI-compatible server.
//
// JSON: each provider says how it can be held to a schema (`json`):
//   "schema" response_format json_schema (strict), falls back to json_object, then to asking in words
//   "object" response_format json_object plus the schema in the prompt
//   "prompt" the schema in the prompt only
// so a model that doesn't take one option still answers.

import { HttpError, fetchJson, baseFor, readOpenAIError } from "../lib.js";
import { strictSchema, schemaHint, extractJson } from "../public/shoppers/pipeline.js";
import { checkInput, maxTokens, addCitation, commonFriendly, unsupportedOption } from "./common.js";

const JSON_STEPS = { schema: ["schema", "object", "prompt"], object: ["object", "prompt"], prompt: ["prompt"] };

export function chatProvider(o) {
  const info = o.info;
  const baseOf = (c, ctx) => {
    if (o.base) return baseFor(c, info.id, o.base);
    if (!ctx?.baseUrl) throw new HttpError(400, `${info.name} needs the server's address`, { hint: "Send it in the X-AI-Base-URL header, e.g. https://my-server.example/v1" });
    return ctx.baseUrl.replace(/\/$/, "");
  };
  const headers = key => ({ "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(o.headers || {}) });
  const call = (c, key, path, init, ctx) => fetchJson(c, `${baseOf(c, ctx)}${path}`, { ...init, headers: headers(key) }, readOpenAIError, info.name);

  function build(input, mode) {
    const prompt = checkInput(input);
    const messages = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    let user = prompt;
    const body = { model: input.model || info.default_model, messages, stream: false };
    const mt = maxTokens(input, o.maxTokens || 0);
    if (mt) body[o.maxTokensField || "max_tokens"] = mt;
    if (input.thinking && o.reasoning) Object.assign(body, o.reasoning(input.thinking));
    if (input.search) {
      if (!o.search) throw new HttpError(400, `${info.name} can't search the web by itself; use a search helper`);
      Object.assign(body, o.search(input));
    }
    if (input.schema || input.json) {
      const schema = input.schema || { type: "object" };
      if (mode === "schema" && input.schema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: strictSchema(schema) } };
      else if (mode === "object" || (mode === "schema" && !input.schema)) {
        body.response_format = { type: "json_object" };
        user += input.schema ? schemaHint(schema) : "\n\nAnswer with only a JSON object.";
      } else user += input.schema ? schemaHint(schema) : "\n\nAnswer with only a JSON object.";
    }
    messages.push({ role: "user", content: user });
    return body;
  }

  function read(r) {
    const choice = r.choices?.[0] || {};
    const msg = choice.message || {};
    let text = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.map(p => p.text || "").join("") : "";
    const citations = [];
    for (const a of msg.annotations || []) {
      const u = a.url_citation || a;
      addCitation(citations, u.url, u.title);
    }
    for (const u of r.citations || []) addCitation(citations, typeof u === "string" ? u : u.url, u.title);
    return { text, citations, finish: choice.finish_reason };
  }

  async function ask(c, key, input, ctx) {
    const steps = input.schema || input.json ? JSON_STEPS[o.json || "schema"] : [null];
    let r, body, lastErr;
    for (const mode of steps) {
      body = build(input, mode);
      try {
        r = await call(c, key, "/chat/completions", { method: "POST", body: JSON.stringify(body) }, ctx);
        break;
      } catch (e) {
        lastErr = e;
        if (!unsupportedOption(e, "response_format|json_schema|json_object|schema|structured")) throw e;
      }
    }
    if (!r) throw lastErr;
    const { text, citations, finish } = read(r);
    const out = {
      id: r.id || null, model: r.model || body.model, status: "completed", truncated: finish === "length",
      text, citations, search_queries: [], usage: r.usage || null,
    };
    if (input.schema || input.json) {
      out.data = extractJson(text);
      if (!out.data) out.warning = "model did not return valid JSON";
    }
    return out;
  }

  async function listModels(c, key, ctx) {
    const r = await call(c, key, o.modelsPath || "/models", { method: "GET" }, ctx);
    const list = (r.data || r.models || []).map(m => ({ id: m.id || m.name || m.model, name: m.name || m.id || m.model }));
    return o.modelFilter ? list.filter(m => o.modelFilter(m.id)) : list;
  }

  async function checkKey(c, key, ctx) {
    await call({ ...c, retries: 0 }, key, o.checkPath || o.modelsPath || "/models", { method: "GET" }, ctx);
  }

  return { info, looksLikeKey: o.looksLikeKey, ask, listModels, checkKey, build, read, friendly: e => (o.friendly && o.friendly(e)) || commonFriendly(e, info) };
}
