// Groq (very fast hosting, OpenAI-compatible at https://api.groq.com/openai/v1).
// Checked against console.groq.com/docs on 2026-10-29: production models
// openai/gpt-oss-120b and openai/gpt-oss-20b (Llama 3.x and the Compound
// search systems were retired). Shops with a search helper.

import { chatProvider } from "./chat.js";
import { keyShape } from "./common.js";

export const DEFAULT_MODEL = "openai/gpt-oss-120b";
export const CHEAP_MODEL = "openai/gpt-oss-20b";

const p = chatProvider({
  base: "https://api.groq.com/openai/v1",
  info: {
    id: "groq",
    name: "Groq",
    key_url: "https://console.groq.com/keys",
    default_model: DEFAULT_MODEL,
    cheap_model: CHEAP_MODEL,
    features: ["json", "schema", "thinking"],
  },
  looksLikeKey: keyShape(/^gsk_[A-Za-z0-9]{20,200}$/),
  reasoning: t => ({ reasoning_effort: t === "minimal" ? "low" : t }),
  json: "schema",
  maxTokens: 8000,
  maxTokensField: "max_completion_tokens",
  modelFilter: id => !/(whisper|orpheus|guard|safeguard|tts)/.test(id),
});

export const { info, looksLikeKey, ask, listModels, checkKey, friendly } = p;
