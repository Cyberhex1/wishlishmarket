// DeepSeek (OpenAI-compatible Chat Completions at https://api.deepseek.com).
// Checked against api-docs.deepseek.com on 2026-10-29: models deepseek-flash
// (served by DeepSeek-V4.1-Flash) and deepseek-v4-pro; JSON mode is
// response_format json_object. DeepSeek can't search the web, so it shops
// with a search helper.

import { chatProvider } from "./chat.js";
import { keyShape } from "./common.js";

export const DEFAULT_MODEL = "deepseek-flash";

const p = chatProvider({
  base: "https://api.deepseek.com",
  info: {
    id: "deepseek",
    name: "DeepSeek",
    key_url: "https://platform.deepseek.com/api_keys",
    default_model: DEFAULT_MODEL,
    cheap_model: DEFAULT_MODEL,
    features: ["json", "thinking"],
  },
  looksLikeKey: keyShape(/^sk-[A-Za-z0-9]{20,200}$/),
  reasoning: t => ({ thinking: { type: "enabled" }, reasoning_effort: t === "minimal" ? "low" : t }),
  json: "object",
  maxTokens: 8000,
});

export const { info, looksLikeKey, ask, listModels, checkKey, friendly } = p;
