// OpenRouter: one key for hundreds of models. Web search comes from its `web`
// plugin (native search for Anthropic, Google, OpenAI, Perplexity and xAI
// models; Exa for the rest), with url_citation annotations on the answer.
// Checked against openrouter.ai/docs (Web Search, Structured Outputs) and the
// live model list on 2026-10-29.

import { chatProvider } from "./chat.js";
import { keyShape } from "./common.js";

export const DEFAULT_MODEL = "google/gemini-3.8-flash";
export const CHEAP_MODEL = "openai/gpt-6-luna";

const p = chatProvider({
  base: "https://openrouter.ai/api/v1",
  info: {
    id: "openrouter",
    name: "OpenRouter (many models, one key)",
    key_url: "https://openrouter.ai/settings/keys",
    default_model: DEFAULT_MODEL,
    cheap_model: CHEAP_MODEL,
    features: ["search", "json", "schema", "thinking"],
  },
  looksLikeKey: keyShape(/^sk-or-[A-Za-z0-9_\-]{20,300}$/),
  headers: { "HTTP-Referer": "https://wishlistmarket.pages.dev", "X-Title": "WishlistMarket" },
  search: () => ({ plugins: [{ id: "web", max_results: 8 }] }),
  reasoning: t => ({ reasoning: { effort: t === "minimal" ? "low" : t } }),
  json: "schema",
  checkPath: "/key",
});

export const { info, looksLikeKey, ask, listModels, checkKey, friendly } = p;
