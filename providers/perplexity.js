// Perplexity Agent API (POST https://api.perplexity.ai/v1/agent) with its
// built-in web_search tool. Checked against docs.perplexity.ai on 2026-10-29:
//   - models are "provider/model" ids; openai/gpt-6.1-sol is a strong default,
//     openai/gpt-6-luna is what Perplexity's own "fast" preset uses
//   - with a model and no effort preset, max_steps defaults to 1, so it is set
//   - anthropic/* models need max_output_tokens
//   - JSON via response_format { type: "json_schema", json_schema: { name, schema } }
//   - the answer comes back like the OpenAI Responses API (message/output_text,
//     url_citation annotations) plus search_results items

import { HttpError, fetchJson, baseFor, readOpenAIError } from "../lib.js";
import { closedSchema, extractJson } from "../public/shoppers/pipeline.js";
import { checkInput, maxTokens, addCitation, commonFriendly, keyShape } from "./common.js";

export const DEFAULT_MODEL = "openai/gpt-6.1-sol";
export const CHEAP_MODEL = "openai/gpt-6-luna";

export const info = {
  id: "perplexity",
  name: "Perplexity",
  key_url: "https://console.perplexity.ai",
  default_model: DEFAULT_MODEL,
  cheap_model: CHEAP_MODEL,
  features: ["search", "json", "schema", "thinking"],
};

export const looksLikeKey = keyShape(/^pplx-[A-Za-z0-9_\-]{20,300}$/);

const base = c => baseFor(c, "perplexity", "https://api.perplexity.ai");
const call = (c, key, path, init) => fetchJson(c, `${base(c)}${path}`,
  { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` } }, readOpenAIError, "Perplexity");

export function buildAgent(input) {
  const prompt = checkInput(input);
  const body = { model: input.model || DEFAULT_MODEL, input: prompt, store: false, max_output_tokens: maxTokens(input, 8000) };
  if (input.system) body.instructions = input.system;
  if (input.thinking) body.reasoning = { effort: input.thinking === "minimal" ? "low" : input.thinking };
  if (input.search) {
    body.tools = [{ type: "web_search", search_type: "fast", max_results: 10 }];
    body.max_steps = 6;
  } else {
    body.max_steps = 1;
  }
  if (input.schema) body.response_format = { type: "json_schema", json_schema: { name: "result", schema: closedSchema(input.schema) } };
  else if (input.json) body.input += "\n\nAnswer with only a JSON object.";
  return body;
}

export function readAgent(r) {
  let text = "";
  const citations = [], queries = [];
  for (const item of r.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type !== "output_text") continue;
        text += part.text || "";
        for (const a of part.annotations || []) addCitation(citations, a.url, a.title);
      }
    } else if (item.type === "search_results") {
      queries.push(...(item.queries || []));
      for (const s of item.results || []) addCitation(citations, s.url, s.title);
    }
  }
  return { text, citations, queries };
}

export async function ask(c, key, input) {
  const body = buildAgent(input);
  const r = await call(c, key, "/v1/agent", { method: "POST", body: JSON.stringify(body) });
  if (r.status === "failed") throw new HttpError(502, r.error?.message || "Perplexity reported the request failed");
  const { text, citations, queries } = readAgent(r);
  const out = {
    id: r.id || null, model: r.model || body.model, status: r.status || "completed", truncated: r.status === "incomplete",
    text, citations, search_queries: [...new Set(queries)], usage: r.usage || null,
  };
  if (input.schema || input.json) {
    out.data = extractJson(text);
    if (!out.data) out.warning = "model did not return valid JSON";
  }
  return out;
}

export async function listModels(c, key) {
  const r = await call(c, key, "/v1/models", { method: "GET" });
  return (r.data || []).map(m => ({ id: m.id, name: m.id }));
}

export async function checkKey(c, key) {
  await call({ ...c, retries: 0 }, key, "/v1/models", { method: "GET" });
}

export const friendly = e => commonFriendly(e, info);
