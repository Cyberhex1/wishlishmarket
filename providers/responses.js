// Providers on the OpenAI Responses API (POST /v1/responses) with its hosted
// `web_search` tool: OpenAI itself and xAI (Grok).
// Request and response shapes checked against platform.openai.com/docs
// (Web search, Structured outputs) and docs.x.ai (Web Search tool) on 2026-10-29.

import { HttpError, fetchJson, baseFor, readOpenAIError } from "../lib.js";
import { strictSchema, schemaHint, extractJson } from "../public/shoppers/pipeline.js";
import { checkInput, maxTokens, addCitation, commonFriendly, unsupportedOption } from "./common.js";

export function responsesProvider(o) {
  const info = o.info;
  const base = c => baseFor(c, info.id, o.base);
  const headers = key => ({ "Content-Type": "application/json", Authorization: `Bearer ${key}` });
  const call = (c, key, path, init) => fetchJson(c, `${base(c)}${path}`, { ...init, headers: headers(key) }, readOpenAIError, info.name);

  function build(input) {
    const prompt = checkInput(input);
    const body = { model: input.model || info.default_model, input: prompt, store: false };
    if (input.system) body.instructions = input.system;
    const mt = maxTokens(input, 0);
    if (mt) body.max_output_tokens = mt;
    if (input.thinking && o.reasoning) body.reasoning = { effort: o.reasoning(input.thinking) };
    if (input.search) body.tools = [{ type: "web_search" }];
    if (input.schema) {
      body.text = { format: { type: "json_schema", name: "result", schema: strictSchema(input.schema), strict: true } };
    } else if (input.json) {
      body.text = { format: { type: "json_object" } };
      if (!/json/i.test(body.input)) body.input += "\n\nAnswer in JSON.";
    }
    return body;
  }

  function read(r) {
    let text = "";
    const citations = [], queries = [];
    for (const item of r.output || []) {
      if (item.type === "message") {
        for (const part of item.content || []) {
          if (part.type !== "output_text") continue;
          text += part.text || "";
          for (const a of part.annotations || []) if (a.type === "url_citation") addCitation(citations, a.url, a.title);
        }
      } else if (item.type === "web_search_call") {
        const a = item.action || {};
        if (a.query) queries.push(a.query);
        for (const q of a.queries || []) queries.push(q);
        for (const s of a.sources || []) addCitation(citations, s.url, s.title);
      }
    }
    if (!text && typeof r.output_text === "string") text = r.output_text;
    return { text, citations, queries };
  }

  async function ask(c, key, input) {
    let body = build(input);
    let r;
    try {
      r = await call(c, key, "/responses", { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      // A model or account without strict JSON support: ask for JSON in words.
      if (body.text && unsupportedOption(e, "format|schema|json")) {
        const { text: _drop, ...plain } = body;
        body = { ...plain, input: body.input + schemaHint(input.schema || { type: "object" }) };
        r = await call(c, key, "/responses", { method: "POST", body: JSON.stringify(body) });
      } else if (body.reasoning && unsupportedOption(e, "reasoning|effort")) {
        const { reasoning: _drop, ...rest } = body;
        body = rest;
        r = await call(c, key, "/responses", { method: "POST", body: JSON.stringify(body) });
      } else throw e;
    }
    if (r.status === "failed") throw new HttpError(502, r.error?.message || `${info.name} reported the request failed`);
    const { text, citations, queries } = read(r);
    const out = {
      id: r.id || null, model: r.model || body.model, status: r.status || "completed",
      truncated: r.status === "incomplete", text, citations, search_queries: [...new Set(queries)], usage: r.usage || null,
    };
    if (input.schema || input.json) {
      out.data = extractJson(text);
      if (!out.data) out.warning = "model did not return valid JSON";
    }
    return out;
  }

  async function listModels(c, key) {
    const r = await call(c, key, "/models", { method: "GET" });
    return (r.data || []).map(m => ({ id: m.id, name: m.id })).filter(m => !o.modelFilter || o.modelFilter(m.id));
  }

  return {
    info,
    looksLikeKey: o.looksLikeKey,
    ask, listModels, build, read,
    checkKey: (c, key) => call({ ...c, retries: 0 }, key, "/models", { method: "GET" }),
    friendly: e => commonFriendly(e, info),
  };
}
