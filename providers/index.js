// AI providers a user can plug in with their own key ("hire" as a shopper).
//
// Each provider module exports:
//   info                          { id, name, key_url, default_model, cheap_model, features, ... }
//   looksLikeKey(key)             cheap shape check, no network
//   ask(c, key, input, ctx?)      -> { id, model, status, truncated, text, data?, citations, search_queries, usage }
//   listModels(c, key, ctx?)      -> [{ id, name, ... }]
//   checkKey(c, key, ctx?)        throws HttpError if the key is rejected
//   friendly(err)                 -> plain-words hint or null
//
// Shoppers with "search" in features research the web with their own search
// tool. The others need a search helper (search/index.js) with its own key.
// Local runtimes (Ollama, LM Studio, ...) are not here: the server can't
// reach the user's computer, so those run in the browser
// (public/shoppers/local.js, listed in public/shoppers/catalog.js).

import * as gemini from "./gemini.js";
import * as openai from "./openai.js";
import * as anthropic from "./anthropic.js";
import * as xai from "./xai.js";
import * as perplexity from "./perplexity.js";
import * as openrouter from "./openrouter.js";
import * as deepseek from "./deepseek.js";
import * as mistral from "./mistral.js";
import * as groq from "./groq.js";
import * as ollamaCloud from "./ollama-cloud.js";
import * as custom from "./custom.js";

export const PROVIDERS = {
  gemini, openai, anthropic, xai, perplexity, openrouter, deepseek, mistral, groq, "ollama-cloud": ollamaCloud, custom,
};
export const DEFAULT_PROVIDER = "gemini";

export const searchesItself = p => p.info.features.includes("search");
