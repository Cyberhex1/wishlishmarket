// Anthropic Claude through the Messages API (POST /v1/messages), API version
// 2026-10-21, with the server-side web_search tool. Checked against
// Anthropic's API docs on 2026-10-29:
//   - claude-opus-5-5 (default), claude-sonnet-5-5, claude-haiku-5-5 (cheapest)
//   - web_search_20260209 on Opus/Sonnet; Haiku uses web_search_20250305
//   - JSON via output_config.format (json_schema, every object closed)
//   - no temperature/top_p/top_k on this API version; thinking is adaptive by
//     default, depth is set with output_config.effort
//   - a long search can stop with stop_reason "pause_turn": send the turn back
//     and the server resumes it

import { HttpError, fetchJson, baseFor } from "../lib.js";
import { closedSchema, extractJson } from "../public/shoppers/pipeline.js";
import { checkInput, maxTokens, addCitation, commonFriendly, keyShape, unsupportedOption } from "./common.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const CHEAP_MODEL = "claude-haiku-5-5";
const VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_PAUSES = 4;

export const info = {
  id: "anthropic",
  name: "Anthropic Claude",
  key_url: "https://platform.claude.com/settings/keys",
  default_model: DEFAULT_MODEL,
  cheap_model: CHEAP_MODEL,
  features: ["search", "json", "schema", "thinking"],
};

export const looksLikeKey = keyShape(/^sk-ant-[A-Za-z0-9_\-]{20,300}$/);

function readError(data) {
  const e = data?.error;
  if (!e) return null;
  return { message: e.message, status: e.type, reason: e.type };
}

const base = c => baseFor(c, "anthropic", "https://api.anthropic.com/v1");

function call(c, key, path, init, betas) {
  const headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": VERSION };
  if (betas?.length) headers["anthropic-beta"] = betas.join(",");
  return fetchJson(c, `${base(c)}${path}`, { ...init, headers }, readError, "Claude");
}

// Server-side refusal fallbacks are on by default for the models that take
// the "default" form, so a declined turn is retried on another Claude model.
const takesFallbacks = m => /^claude-(opus-5-5|sonnet-5-5|fable-5-1|opus-5)$/.test(m);
const searchTool = m => /haiku/.test(m) ? "web_search_20250305" : "web_search_20260209";
const EFFORT = { minimal: "low", low: "low", medium: "medium", high: "high" };

export function buildMessage(input) {
  const prompt = checkInput(input);
  const model = input.model || DEFAULT_MODEL;
  const body = { model, max_tokens: maxTokens(input, 16000), messages: [{ role: "user", content: prompt }] };
  if (input.system) body.system = input.system;
  const oc = {};
  if (input.thinking) oc.effort = EFFORT[input.thinking];
  if (input.schema) oc.format = { type: "json_schema", schema: closedSchema(input.schema) };
  else if (input.json) body.messages[0].content += "\n\nAnswer with only a JSON object.";
  if (Object.keys(oc).length) body.output_config = oc;
  if (input.search) body.tools = [{ type: searchTool(model), name: "web_search", max_uses: 8 }];
  const betas = [];
  if (takesFallbacks(model)) { body.fallbacks = "default"; betas.push(FALLBACK_BETA); }
  return { body, betas };
}

export function readMessage(m) {
  let text = "";
  const citations = [], queries = [];
  for (const b of m.content || []) {
    if (b.type === "text") {
      text += b.text || "";
      for (const cit of b.citations || []) addCitation(citations, cit.url, cit.title);
    } else if (b.type === "server_tool_use" && b.input?.query) {
      queries.push(b.input.query);
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result") addCitation(citations, r.url, r.title);
    }
  }
  return { text, citations, queries };
}

async function send(c, key, body, betas) {
  try {
    return { m: await call(c, key, "/messages", { method: "POST", body: JSON.stringify(body) }, betas), body, betas };
  } catch (e) {
    // If the account can't use refusal fallbacks, send the plain request.
    if (body.fallbacks && unsupportedOption(e, "fallback|beta")) {
      const { fallbacks: _drop, ...plain } = body;
      return { m: await call(c, key, "/messages", { method: "POST", body: JSON.stringify(plain) }, []), body: plain, betas: [] };
    }
    throw e;
  }
}

export async function ask(c, key, input) {
  const built = buildMessage(input);
  let { m, body, betas } = await send(c, key, built.body, built.betas);
  // pause_turn: hand the paused turn back unchanged and the server carries on.
  const content = [...(m.content || [])];
  for (let i = 0; m.stop_reason === "pause_turn" && i < MAX_PAUSES; i++) {
    const next = { ...body, messages: [...body.messages, { role: "assistant", content: [...content] }] };
    ({ m } = await send(c, key, next, betas));
    content.push(...(m.content || []));
  }
  if (m.stop_reason === "refusal") {
    throw new HttpError(422, "Claude declined this request", { hint: "Try wording the request differently." });
  }
  const { text, citations, queries } = readMessage({ content });
  const out = {
    id: m.id || null, model: m.model || body.model, status: "completed",
    truncated: m.stop_reason === "max_tokens" || m.stop_reason === "pause_turn",
    text, citations, search_queries: [...new Set(queries)], usage: m.usage || null,
  };
  if (input.schema || input.json) {
    out.data = extractJson(text);
    if (!out.data) out.warning = "model did not return valid JSON";
  }
  return out;
}

export async function listModels(c, key) {
  const r = await call(c, key, "/models?limit=100", { method: "GET" });
  return (r.data || []).map(m => ({ id: m.id, name: m.display_name || m.id, input_limit: m.max_input_tokens, output_limit: m.max_tokens }));
}

export async function checkKey(c, key) {
  await call({ ...c, retries: 0 }, key, "/models?limit=1", { method: "GET" });
}

export function friendly(e) {
  if (e.status === 529 || e.details?.reason === "overloaded_error") return "Claude is busy right now. Try again in a minute.";
  if (e.status === 400 && /credit balance/i.test(e.message || "")) return "Your Anthropic account is out of credit. Add credit at platform.claude.com.";
  return commonFriendly(e, info);
}
