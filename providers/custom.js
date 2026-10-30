// Any other OpenAI-compatible server on the internet (Together, Fireworks,
// a vLLM or llama.cpp server behind a tunnel, ...). The address comes with
// each request in X-AI-Base-URL; the key is optional. Servers on the user's
// own computer or network can't be reached from WishlistMarket's server: those
// run in the browser instead (see public/shoppers/local.js).

import { chatProvider } from "./chat.js";
import { HttpError } from "../lib.js";

const p = chatProvider({
  info: {
    id: "custom",
    name: "Other OpenAI-compatible server",
    key_url: null,
    default_model: "",
    cheap_model: "",
    features: ["json", "schema"],
    needs_base_url: true,
    key_optional: true,
  },
  looksLikeKey: key => /^[\x21-\x7e]{1,500}$/.test(key),
  json: "schema",
  maxTokens: 8000,
});

export const { info, looksLikeKey, listModels, checkKey, friendly } = p;

export function checkBaseUrl(raw, allowPrivate) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw new HttpError(400, "That server address isn't a valid URL", { hint: "Use the full address, e.g. https://my-server.example/v1" }); }
  if (u.protocol !== "https:" && !allowPrivate) throw new HttpError(400, "The server address must start with https://");
  const h = u.hostname;
  if (!allowPrivate && (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i.test(h) || !h.includes("."))) {
    throw new HttpError(400, "That address is on your own computer or network, which the WishlistMarket server can't reach",
      { hint: "Hire it as a local shopper instead: it runs from your browser on the same computer." });
  }
  u.hash = ""; u.search = "";
  return u.href.replace(/\/$/, "");
}

export async function ask(c, key, input, ctx) {
  if (!input.model) throw new HttpError(400, "Pick a model for this server (load its model list first)");
  return p.ask(c, key, input, ctx);
}
