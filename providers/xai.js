// xAI Grok through xAI's Responses API (https://api.x.ai/v1/responses) with
// the server-side web_search tool. Checked against docs.x.ai on 2026-10-29:
// grok-4.7 is the current model for everything except voice and images.

import { responsesProvider } from "./responses.js";
import { keyShape } from "./common.js";

export const DEFAULT_MODEL = "grok-4.7";

const p = responsesProvider({
  base: "https://api.x.ai/v1",
  info: {
    id: "xai",
    name: "xAI Grok",
    key_url: "https://console.x.ai",
    default_model: DEFAULT_MODEL,
    cheap_model: DEFAULT_MODEL,
    features: ["search", "json", "schema"],
  },
  looksLikeKey: keyShape(/^xai-[A-Za-z0-9_\-]{20,300}$/),
  // Grok's reasoning is configured by the model; no effort field is sent.
  reasoning: null,
  modelFilter: id => /^grok/.test(id) && !/(image|imagine|vision-only|voice|tts|stt)/.test(id),
});

export const { info, looksLikeKey, ask, listModels, checkKey, friendly } = p;
