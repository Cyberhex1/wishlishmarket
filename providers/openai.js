// OpenAI (GPT) through the Responses API with the hosted web_search tool.
// Models from platform.openai.com/docs/models on 2026-10-29: gpt-6-astra
// (flagship), gpt-6.1-sol (balanced), gpt-6.1-terra, gpt-6-luna (cheapest).

import { responsesProvider } from "./responses.js";
import { keyShape } from "./common.js";

export const DEFAULT_MODEL = "gpt-6.1-sol";
export const CHEAP_MODEL = "gpt-6-luna";

const p = responsesProvider({
  base: "https://api.openai.com/v1",
  info: {
    id: "openai",
    name: "OpenAI (ChatGPT models)",
    key_url: "https://platform.openai.com/api-keys",
    default_model: DEFAULT_MODEL,
    cheap_model: CHEAP_MODEL,
    features: ["search", "json", "schema", "thinking"],
  },
  looksLikeKey: keyShape(/^sk-[A-Za-z0-9_\-]{20,300}$/),
  // gpt-6 models take none|low|medium|high|xhigh|max.
  reasoning: t => (t === "minimal" ? "low" : t),
  modelFilter: id => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|search-api|moderation|instruct)/.test(id),
});

export const { info, looksLikeKey, ask, listModels, checkKey, friendly } = p;
