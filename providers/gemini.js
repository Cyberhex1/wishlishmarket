// Google Gemini (AI Studio key) provider.
//
// Built on Google's Interactions API (POST /v1beta/interactions), which Google
// recommends for all new projects as of June 2026 (generateContent is legacy).
// Checked against ai.google.dev docs on 2026-10-29.

import { HttpError, fetchJson } from "../lib.js";

export const DEFAULT_MODEL = "gemini-3.8-flash";      // stable, best general pick
export const CHEAP_MODEL = "gemini-3.5-flash-lite";   // stable, fastest and cheapest
const FALLBACK_MODELS = [DEFAULT_MODEL, CHEAP_MODEL, "gemini-3.6-flash"];
const THINKING_LEVELS = ["minimal", "low", "medium", "high"];
const MAX_PROMPT_CHARS = 60000;
const MAX_CONTINUATIONS = 3;

export const info = {
  id: "gemini",
  name: "Google Gemini (AI Studio)",
  key_url: "https://aistudio.google.com/apikey",
  default_model: DEFAULT_MODEL,
  cheap_model: CHEAP_MODEL,
  features: ["search", "urls", "json", "schema", "thinking", "follow_ups"],
};

// Rough shape check so an obviously wrong key fails fast, without a call.
export function looksLikeKey(key) {
  return /^[A-Za-z0-9_\-]{20,200}$/.test(key);
}

// Google sometimes wraps the error object in an array.
function readError(data) {
  const g = (Array.isArray(data) ? data[0] : data)?.error;
  if (!g) return null;
  return { message: g.message, status: g.status, reason: (g.details || []).find(d => d.reason)?.reason };
}

function call(c, key, path, init) {
  return fetchJson(c, `${c.geminiBase}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
  }, readError, "Gemini");
}

// ---------- request building ----------

export function buildInteraction(input) {
  const prompt = input.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "prompt (non-empty string) is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(413, `prompt is over ${MAX_PROMPT_CHARS} characters`);

  // store is off by default: prompts can hold personal searches.
  const body = { model: input.model || DEFAULT_MODEL, input: prompt, store: input.store === true };
  if (input.system) {
    if (typeof input.system !== "string") throw new HttpError(400, "system must be a string");
    body.system_instruction = input.system;
  }
  if (input.previous_id) {
    body.previous_interaction_id = String(input.previous_id);
    body.store = true; // follow-ups only work on stored interactions
  }

  const gen = {};
  if (input.thinking) {
    if (!THINKING_LEVELS.includes(input.thinking)) throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
    gen.thinking_level = input.thinking;
  }
  if (input.max_tokens) gen.max_output_tokens = Math.max(1, Math.min(65536, Number(input.max_tokens) | 0));
  if (Object.keys(gen).length) body.generation_config = gen;

  const tools = [];
  if (input.search) tools.push({ type: "google_search" });
  if (input.urls) {
    if (!Array.isArray(input.urls) || input.urls.some(u => typeof u !== "string" || !/^https?:\/\//.test(u))) {
      throw new HttpError(400, "urls must be an array of http(s) links");
    }
    tools.push({ type: "url_context" });
    body.input = `${prompt}\n\nUse these pages:\n${input.urls.join("\n")}`;
  }
  if (tools.length) body.tools = tools;

  if (input.schema || input.json) {
    body.response_format = { type: "text", mime_type: "application/json" };
    if (input.schema) {
      if (typeof input.schema !== "object") throw new HttpError(400, "schema must be a JSON Schema object");
      body.response_format.schema = input.schema;
    }
  }
  return body;
}

// ---------- response parsing ----------

export function readInteraction(ix) {
  let text = "";
  const citations = [];
  const queries = [];
  for (const step of ix.steps || []) {
    if (step.type === "model_output") {
      for (const block of step.content || []) {
        if (block.type !== "text") continue;
        text += block.text || "";
        for (const a of block.annotations || []) {
          const url = a.url || a.uri;
          if (url && !citations.some(x => x.url === url)) citations.push({ title: a.title || url, url });
        }
      }
    } else if (step.type === "google_search_call") {
      queries.push(...(step.arguments?.queries || []));
    }
  }
  return { text, citations, queries };
}

async function runInteraction(c, key, body) {
  let ix = await call(c, key, "/interactions", { method: "POST", body: JSON.stringify(body) });
  let { text, citations, queries } = readInteraction(ix);
  // Long answers can stop with requires_continuation; resume with the token.
  for (let i = 0; ix.status === "requires_continuation" && ix.continuation_token && i < MAX_CONTINUATIONS; i++) {
    ix = await call(c, key, "/interactions", {
      method: "POST",
      body: JSON.stringify({ ...body, continuation_token: ix.continuation_token }),
    });
    const more = readInteraction(ix);
    text += more.text;
    for (const x of more.citations) if (!citations.some(y => y.url === x.url)) citations.push(x);
    queries.push(...more.queries);
  }
  if (ix.status === "failed") throw new HttpError(502, "Gemini reported the request failed", { id: ix.id });
  return {
    id: ix.id || null,
    model: body.model,
    status: ix.status || "completed",
    truncated: ix.status === "incomplete" || ix.status === "requires_continuation",
    text,
    citations,
    search_queries: [...new Set(queries)],
    usage: ix.usage || null,
  };
}

// Try the chosen model, then fall back to the next current model if Google
// says it doesn't exist (404), e.g. after a model is retired. A model the
// caller named on purpose is never swapped.
export async function ask(c, key, input) {
  const body = buildInteraction(input);
  const chain = input.model ? [body.model] : [...new Set([body.model, ...FALLBACK_MODELS])];
  let lastErr;
  for (const model of chain) {
    try {
      const out = await runInteraction(c, key, { ...body, model });
      if (model !== body.model) out.fell_back_from = body.model;
      if (body.response_format) {
        try { out.data = JSON.parse(out.text); } catch { out.data = null; out.warning = "model did not return valid JSON"; }
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (e.status !== 404) throw e;
    }
  }
  throw lastErr;
}

export async function listModels(c, key) {
  const out = [];
  let page = "";
  for (let i = 0; i < 5; i++) {
    const q = `/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`;
    const data = await call(c, key, q, { method: "GET" });
    for (const m of data.models || []) {
      out.push({ id: (m.name || "").replace(/^models\//, ""), name: m.displayName,
        input_limit: m.inputTokenLimit, output_limit: m.outputTokenLimit });
    }
    if (!data.nextPageToken) break;
    page = data.nextPageToken;
  }
  return out;
}

export async function checkKey(c, key) {
  await call({ ...c, retries: 0 }, key, "/models?pageSize=1", { method: "GET" });
}

export function friendly(e) {
  const s = e.status || 500;
  const g = e.details?.googleStatus;
  if (e.details?.reason === "API_KEY_INVALID" || (s === 400 && /api key/i.test(e.message))) {
    return "Your Gemini API key is not valid. Make a new one at https://aistudio.google.com/apikey";
  }
  if (s === 403) return "Your API key is not allowed to use that model or the Gemini API. Check the key's project in AI Studio.";
  if (s === 404) return "That model name doesn't exist (any more). GET /api/models lists the ones your key can use.";
  if (s === 429 || g === "RESOURCE_EXHAUSTED") return "Your key hit Gemini's rate limit or free quota. Wait a minute, or turn on billing in AI Studio.";
  if (s === 504) return "Gemini took too long to answer. Try again or use a shorter request.";
  return null;
}
