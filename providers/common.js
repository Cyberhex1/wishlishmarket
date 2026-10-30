// Pieces shared by the provider modules.

import { HttpError } from "../lib.js";

export const MAX_PROMPT_CHARS = 60000;
export const THINKING = ["minimal", "low", "medium", "high"];

export function checkInput(input) {
  const prompt = input?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "prompt (non-empty string) is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(413, `prompt is over ${MAX_PROMPT_CHARS} characters`);
  if (input.system != null && typeof input.system !== "string") throw new HttpError(400, "system must be a string");
  if (input.thinking && !THINKING.includes(input.thinking)) throw new HttpError(400, `thinking must be one of ${THINKING.join(", ")}`);
  if (input.schema && typeof input.schema !== "object") throw new HttpError(400, "schema must be a JSON Schema object");
  if (input.urls) throw new HttpError(400, "urls is only supported by Gemini; put the links in the prompt instead");
  return prompt;
}

export const maxTokens = (input, dflt) => input.max_tokens ? Math.max(1, Math.min(65536, Number(input.max_tokens) | 0)) : dflt;

// Cheap shape check so an obviously wrong key fails before any call.
export const keyShape = re => key => re.test(key);
export const anyKey = keyShape(/^[\x21-\x7e]{8,300}$/);

export function addCitation(list, url, title) {
  if (!url || list.some(x => x.url === url)) return;
  list.push({ title: title || url, url });
}

// Plain-words hints for the errors every provider can return.
export function commonFriendly(e, info) {
  const s = e.status || 500;
  const where = info.key_url ? ` Get a new one at ${info.key_url}` : "";
  if (s === 401 || (s === 400 || s === 422) && /api.?key|subscription.?token|unauthori[sz]ed/i.test(e.message || "")) return `${info.name} says this key isn't valid.${where}`;
  if (s === 402) return `Your ${info.name} account is out of credit. Add credit or turn on billing in your ${info.name} account.`;
  if (s === 403) return `Your ${info.name} key isn't allowed to use that model or feature. Check the key's permissions or pick another model.`;
  if (s === 404) return `${info.name} doesn't have that model (any more). Load the list of models your key can use and pick another.`;
  if (s === 429) return `Your ${info.name} key hit its rate limit or quota. Wait a minute, or check your plan and billing.`;
  if (s === 504) return `${info.name} took too long to answer. Try again, or pick a faster model.`;
  if (s >= 500) return `${info.name} had a problem on its side. Try again in a minute.`;
  return null;
}

// Errors that mean "this option isn't supported here", so a simpler request may work.
export const unsupportedOption = (e, word) => e?.status === 400 && new RegExp(word, "i").test(e.message || "");
