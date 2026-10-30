// Ollama Cloud: open models (gpt-oss, Gemma 4, DeepSeek, Qwen...) hosted by
// Ollama, OpenAI-compatible at https://ollama.com/v1 with an Ollama API key.
// The same key runs Ollama's web search (https://ollama.com/api/web_search),
// so this shopper needs only one key. Checked against docs.ollama.com on
// 2026-10-29: cloud models don't support structured outputs, so the schema
// goes in the prompt; /v1/models is public, so keys are checked with /api/me.

import { chatProvider } from "./chat.js";
import { anyKey } from "./common.js";
import { fetchJson, baseFor, readOpenAIError } from "../lib.js";

export const DEFAULT_MODEL = "gpt-oss:120b";
export const CHEAP_MODEL = "gpt-oss:20b";

const p = chatProvider({
  base: "https://ollama.com/v1",
  info: {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    key_url: "https://ollama.com/settings/keys",
    default_model: DEFAULT_MODEL,
    cheap_model: CHEAP_MODEL,
    features: ["json", "thinking"],
    search_helper: "ollama",
  },
  looksLikeKey: anyKey,
  reasoning: t => ({ reasoning_effort: t === "minimal" ? "low" : t }),
  json: "prompt",
  maxTokens: 8000,
});

export const { info, looksLikeKey, ask, listModels, friendly } = p;

export async function checkKey(c, key) {
  const site = baseFor(c, "ollama-site", "https://ollama.com");
  await fetchJson({ ...c, retries: 0 }, `${site}/api/me`, { method: "POST", headers: { Authorization: `Bearer ${key}` } }, readOpenAIError, "Ollama");
}
