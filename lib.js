// Small helpers shared by the router, providers and agent jobs.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Settings come from the host's environment. None of them is an AI key:
// every caller brings their own key with each request (see app.js).
export function cfg(env) {
  return {
    token: env.BACKEND_TOKEN || "",
    origins: (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean),
    timeoutMs: Number(env.AI_TIMEOUT_MS || 90000),
    retries: Number(env.AI_RETRIES ?? 2),
    linkTimeoutMs: Number(env.LINK_TIMEOUT_MS || 8000),
    allowPrivateLinks: env.LINK_ALLOW_PRIVATE === "true", // tests only
    geminiBase: (env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, ""),
    // Tests point providers and search helpers at a fake server: { openai: "http://127.0.0.1:1234/v1", ... }
    bases: parseBases(env.AI_API_BASES),
  };
}

function parseBases(v) {
  if (!v) return {};
  try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return {}; }
}

// The base URL for a provider: the test override if there is one, else its real one.
export const baseFor = (c, id, real) => (c.bases?.[id] || real).replace(/\/$/, "");

// Most providers answer errors as { error: { message, type, code } } (OpenAI style).
export function readOpenAIError(data) {
  const d = Array.isArray(data) ? data[0] : data;
  const e = d?.error ?? d?.detail ?? d;
  if (!e) return null;
  if (typeof e === "string") return { message: e };
  if (Array.isArray(e)) return { message: e.map(x => x.msg || x.message).filter(Boolean).join("; ") || undefined };
  return { message: e.message || (typeof e.error === "string" ? e.error : e.error?.message) || e.detail || d?.message, status: e.type || e.status, reason: e.code != null ? String(e.code) : undefined };
}

export function json(body, status, headers) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// fetch JSON with a timeout, and retry on rate limits / server hiccups.
// readError turns a provider's error body into { message, status, reason }.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
export async function fetchJson(c, url, init, readError, label) {
  let last;
  for (let attempt = 0; attempt <= c.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      const e = readError(data) || {};
      last = new HttpError(r.status, e.message || `${label} error ${r.status}`, { googleStatus: e.status, providerStatus: e.status, reason: e.reason, retryAfter: r.headers.get("Retry-After") });
      if (!RETRY_STATUSES.has(r.status) || attempt === c.retries) throw last;
      const retryAfter = Number(r.headers.get("Retry-After"));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 20) * 1000 : 1000 * 2 ** attempt);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const timeout = e.name === "AbortError";
      last = new HttpError(timeout ? 504 : 502,
        timeout ? `${label} did not answer within ${c.timeoutMs / 1000}s` : `Could not reach ${label}: ${e.message}`);
      if (attempt === c.retries) throw last;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
