// Mistral AI (Chat Completions at https://api.mistral.ai/v1). The `-latest`
// aliases follow Mistral's current Medium and Small models (Medium 3.5 and
// Small 4 on 2026-10-29). JSON via response_format json_schema. Mistral's
// chat API has no web search, so it shops with a search helper.

import { chatProvider } from "./chat.js";
import { keyShape } from "./common.js";

export const DEFAULT_MODEL = "mistral-medium-latest";
export const CHEAP_MODEL = "mistral-small-latest";

const p = chatProvider({
  base: "https://api.mistral.ai/v1",
  info: {
    id: "mistral",
    name: "Mistral AI",
    key_url: "https://console.mistral.ai/api-keys",
    default_model: DEFAULT_MODEL,
    cheap_model: CHEAP_MODEL,
    features: ["json", "schema"],
  },
  looksLikeKey: keyShape(/^[A-Za-z0-9]{24,64}$/),
  json: "schema",
  maxTokens: 8000,
  modelFilter: id => !/(embed|moderation|ocr|voxtral|transcribe|tts|timestral)/.test(id),
});

export const { info, looksLikeKey, ask, listModels, checkKey, friendly } = p;
