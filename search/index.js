// Search helpers: web search APIs that let a shopper without its own search
// tool (DeepSeek, Mistral, Groq, Ollama, LM Studio, other local models) find
// product pages. Like AI keys, the user brings their own search key; the
// server never stores one. Each returns [{ title, url, snippet }].
//
// Checked against each service's API docs on 2026-10-29:
//   tavily      POST https://api.tavily.com/search, Bearer tvly-...; 1,000 free credits a month (1 per basic search)
//   brave       GET https://api.search.brave.com/res/v1/web/search?q=, X-Subscription-Token; $5 free credit a month, card needed
//   perplexity  POST https://api.perplexity.ai/search, Bearer pplx-...; search_type "fast" is $1 per 1,000
//   ollama      POST https://ollama.com/api/web_search, Bearer <Ollama key>; max_results up to 10

import { HttpError, fetchJson, baseFor, readOpenAIError } from "../lib.js";
import { commonFriendly } from "../providers/common.js";

const MAX_RESULTS = 8;
const clean = s => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function make(info, run, check) {
  return { info, search: run, checkKey: check, friendly: e => commonFriendly(e, info) };
}

const tavily = make({
  id: "tavily", name: "Tavily", key_url: "https://app.tavily.com/home", free: "1,000 searches a month free, no card",
  cost: "Free for about 100 shopping lists a month", recommended: true,
}, async (c, key, q, o = {}) => {
  const r = await fetchJson(c, `${baseFor(c, "tavily", "https://api.tavily.com")}/search`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: o.max || MAX_RESULTS, search_depth: "basic", topic: "general", country: "united states" }),
  }, readOpenAIError, "Tavily");
  return (r.results || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean(x.content) }));
}, (c, key) => fetchJson({ ...c, retries: 0 }, `${baseFor(c, "tavily", "https://api.tavily.com")}/usage`,
  { method: "GET", headers: { Authorization: `Bearer ${key}` } }, readOpenAIError, "Tavily"));

const brave = make({
  id: "brave", name: "Brave Search", key_url: "https://api-dashboard.search.brave.com/app/keys",
  free: "$5 free credit every month (about 1,000 searches); needs a card", cost: "$5 per 1,000 searches after the free credit",
}, async (c, key, q, o = {}) => {
  const u = `${baseFor(c, "brave", "https://api.search.brave.com/res/v1")}/web/search?q=${encodeURIComponent(q)}&count=${o.max || MAX_RESULTS}&country=us&search_lang=en`;
  const r = await fetchJson(c, u, { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } }, readOpenAIError, "Brave Search");
  return (r.web?.results || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean([x.description, ...(x.extra_snippets || [])].join(" ")) }));
}, (c, key) => fetchJson({ ...c, retries: 0 }, `${baseFor(c, "brave", "https://api.search.brave.com/res/v1")}/web/search?q=test&count=1`,
  { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": key } }, readOpenAIError, "Brave Search"));

const perplexity = make({
  id: "perplexity", name: "Perplexity Search", key_url: "https://console.perplexity.ai",
  free: "Pay as you go", cost: "$1 per 1,000 fast searches (about 0.6 cents a list)",
}, async (c, key, q, o = {}) => {
  const r = await fetchJson(c, `${baseFor(c, "perplexity", "https://api.perplexity.ai")}/search`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: o.max || MAX_RESULTS, search_type: "fast", country: "US", max_tokens_per_page: 400 }),
  }, readOpenAIError, "Perplexity Search");
  return (r.results || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean(x.snippet) }));
}, (c, key) => fetchJson({ ...c, retries: 0 }, `${baseFor(c, "perplexity", "https://api.perplexity.ai")}/v1/models`,
  { method: "GET", headers: { Authorization: `Bearer ${key}` } }, readOpenAIError, "Perplexity"));

const ollama = make({
  id: "ollama", name: "Ollama web search", key_url: "https://ollama.com/settings/keys",
  free: "Needs a free Ollama account", cost: "Included with an Ollama account (Ollama's limits apply)",
}, async (c, key, q, o = {}) => {
  const r = await fetchJson(c, `${baseFor(c, "ollama-site", "https://ollama.com")}/api/web_search`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: Math.min(10, o.max || MAX_RESULTS) }),
  }, readOpenAIError, "Ollama web search");
  return (r.results || []).map(x => ({ title: clean(x.title), url: x.url, snippet: clean(x.content).slice(0, 600) }));
}, (c, key) => fetchJson({ ...c, retries: 0 }, `${baseFor(c, "ollama-site", "https://ollama.com")}/api/me`,
  { method: "POST", headers: { Authorization: `Bearer ${key}` } }, readOpenAIError, "Ollama"));

export const SEARCH_HELPERS = { tavily, brave, perplexity, ollama };
export const DEFAULT_SEARCH = "tavily";

// Saved search keys live next to AI keys in the account, under "search-<id>".
export const SEARCH_KEY_PREFIX = "search-";

export function pickSearch(id) {
  const s = SEARCH_HELPERS[String(id || DEFAULT_SEARCH).toLowerCase()];
  if (!s) throw new HttpError(400, `unknown search helper "${id}"`, { hint: `Supported: ${Object.keys(SEARCH_HELPERS).join(", ")}` });
  return s;
}

export async function runSearch(c, helper, key, query, o) {
  const q = String(query || "").trim();
  if (!q) throw new HttpError(400, "query is required");
  if (q.length > 300) throw new HttpError(413, "query is over 300 characters");
  const results = await helper.search({ ...c, timeoutMs: Math.min(c.timeoutMs, 30000) }, key, q, o);
  return results.filter(x => x.url && /^https?:\/\//.test(x.url));
}
