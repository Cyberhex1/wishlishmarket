// User accounts for WishlistMarket: sign up, sign in, each user's own Market
// data, their own AI provider key, and tokens for their own AI agents.
//
// Storage is Cloudflare D1 (binding `DB`, tables in schema.sql). Settings:
//   ACCOUNTS_SECRET  secret, 32+ random characters. Encrypts users' saved AI
//                    keys. Without it accounts still work but keys can't be saved.
//   SIGNUPS          "open" (default) | "invite" | "closed"
//   INVITE_CODE      secret, needed to sign up when SIGNUPS is "invite"
//
// Routes (all JSON):
//   POST   /api/auth/signup          { email, password, name?, invite? }
//   POST   /api/auth/login           { email, password }
//   POST   /api/auth/logout          ?all=1 signs out every device
//   GET    /api/me                   who am I, saved agents, tokens
//   PATCH  /api/me                   { name }
//   POST   /api/me/password          { current, password }
//   DELETE /api/me                   { password }  deletes the account and all its data
//   GET    /api/me/agents            saved AI providers (never the key itself)
//   PUT    /api/me/agents/:provider  { key?, model?, check? }  (search helper keys: :provider = search-<id>)
//   DELETE /api/me/agents/:provider
//   GET    /api/me/settings          the user's preferences (location, stores, ...)
//   PUT    /api/me/settings          { ... } replaces them; 16 KB max, no keys or passwords
//   GET    /api/me/tokens            agent tokens
//   POST   /api/me/tokens            { name, scope: "read"|"write" } -> token shown once
//   DELETE /api/me/tokens/:id
//   GET    /api/data                 everything, in the data.json shape
//   POST   /api/data/import          data.json shape, ?replace=1 clears first
//   GET    /api/data/:col            all docs in a collection
//   POST   /api/data/:col            create (id optional)
//   GET    /api/data/:col/:id
//   PUT    /api/data/:col/:id        replace
//   PATCH  /api/data/:col/:id        shallow merge
//   DELETE /api/data/:col/:id
//
// Browsers sign in with an HttpOnly cookie. AI agents send
// `Authorization: Bearer wm_...` with a token the user made.

import { HttpError, json, cfg } from "../lib.js";
import { PROVIDERS } from "../providers/index.js";
import { SEARCH_HELPERS, SEARCH_KEY_PREFIX } from "../search/index.js";

const COOKIE = "wm_session";
const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000; // the most Workers allows
const MAX_BODY = 4_000_000;
const MAX_DOC_BYTES = 1_000_000;
const MAX_DOCS = 5000;
const MAX_TOKENS = 20;
const MAX_SETTINGS_BYTES = 16_000;
const SECRET_NAME_RE = /api[_-]?key|token|secret|passw/i;
const IMPORT_CHUNK = 50;
export const COLLECTIONS = ["lists", "projects", "stores", "requests", "svc_searches", "svc_projects", "svc_providers", "svc_requests"];
const COL_RE = /^[a-z][a-z0-9_]{1,31}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- small helpers ----------

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

function b64u(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const newId = () => randomToken(12);

async function sha256(s) {
  return b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function db(env) {
  if (!env.DB) throw new HttpError(503, "Accounts are not set up yet (no DB binding)");
  return env.DB;
}

async function readBody(req) {
  if (!(req.headers.get("Content-Type") || "").includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request is too large");
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "Body is not valid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  return body;
}

// Fixed-window counter. Returns false once `limit` is passed.
// Also used by the router to rate-limit the open search and finish routes.
export async function allow(env, key, limit, windowSec) {
  const t = now();
  const row = await db(env).prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING count`).bind(key, t + windowSec, t).first();
  return row.count <= limit;
}
const clientIp = req => req.headers.get("CF-Connecting-IP") || "local";

// ---------- passwords ----------

async function hashPassword(password, saltB64, iter) {
  const salt = saltB64 ? unb64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return { hash: b64u(bits), salt: b64u(salt), iter };
}

async function checkPassword(user, password) {
  const { hash } = await hashPassword(password, user.pw_salt, user.pw_iter);
  return sameBytes(unb64u(hash), unb64u(user.pw_hash));
}

function validPassword(p) {
  if (typeof p !== "string" || p.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (p.length > 200) throw new HttpError(400, "Password is too long (200 characters max)");
  return p;
}

function validEmail(e) {
  const email = typeof e === "string" ? e.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "Enter a valid email address");
  return email;
}

const cleanName = n => (typeof n === "string" ? n.trim().slice(0, 80) : "");

// ---------- sessions and who is calling ----------

function cookieValue(req) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

function sessionCookie(req, token, maxAge) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function startSession(env, req, userId) {
  const token = randomToken();
  const t = now();
  await db(env).prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen, user_agent) VALUES (?1, ?2, ?3, ?4, ?3, ?5)")
    .bind(await sha256(token), userId, t, t + SESSION_DAYS * 86400, (req.headers.get("User-Agent") || "").slice(0, 200)).run();
  return sessionCookie(req, token, SESSION_DAYS * 86400);
}

// Who is calling: { user, via: "session"|"token", scope, sessionId?, tokenId? } or null.
export async function authenticate(req, env) {
  if (!env.DB) return null;
  const auth = req.headers.get("Authorization") || "";
  const t = now();
  if (auth.startsWith("Bearer wm_")) {
    const row = await env.DB.prepare(
      `SELECT t.id AS token_id, t.scope, u.id, u.email, u.name, u.created_at
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?1`)
      .bind(await sha256(auth.slice(7))).first();
    if (!row) return null;
    await env.DB.prepare("UPDATE api_tokens SET last_used = ?1 WHERE id = ?2").bind(t, row.token_id).run();
    return { user: pickUser(row), via: "token", scope: row.scope, tokenId: row.token_id };
  }
  const cookie = cookieValue(req);
  if (!cookie) return null;
  const sid = await sha256(cookie);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, s.last_seen, u.id, u.email, u.name, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1`).bind(sid).first();
  if (!row) return null;
  if (row.expires_at <= t) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sid).run();
    return null;
  }
  // Sliding expiry, written at most once an hour.
  if (t - row.last_seen > 3600) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ?1, expires_at = ?2 WHERE id = ?3")
      .bind(t, t + SESSION_DAYS * 86400, sid).run();
  }
  return { user: pickUser(row), via: "session", scope: "write", sessionId: sid };
}

const pickUser = r => ({ id: r.id, email: r.email, name: r.name, created_at: r.created_at });

// For other backend modules: the signed-in user's { id, email, name } or null.
export async function getSessionUser(req, env) {
  return (await authenticate(req, env))?.user || null;
}

// A browser form on another site must not act with the user's cookie.
function checkOrigin(req, who) {
  if (who?.via !== "session" || ["GET", "HEAD"].includes(req.method)) return;
  const origin = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  if ((origin && origin !== new URL(req.url).origin) || site === "cross-site") {
    throw new HttpError(403, "Cross-site request refused");
  }
}

function requireUser(who, write) {
  if (!who) throw new HttpError(401, "Sign in first");
  if (write && who.scope !== "write") throw new HttpError(403, "This agent token is read-only");
  return who.user;
}

// ---------- AI keys (encrypted at rest) ----------

async function aesKey(env) {
  const secret = env.ACCOUNTS_SECRET || "";
  if (secret.length < 32) {
    throw new HttpError(503, "Saving AI keys is turned off until the site owner sets ACCOUNTS_SECRET",
      { hint: "You can still send your key with each request instead." });
  }
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("wishlistmarket"), info: enc.encode("agent-keys-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function sealKey(env, userId, provider, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(`${userId}:${provider}`) }, await aesKey(env), enc.encode(plain));
  return { key_enc: b64u(ct), key_iv: b64u(iv) };
}

async function openKey(env, userId, provider, row) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64u(row.key_iv), additionalData: enc.encode(`${userId}:${provider}`) },
    await aesKey(env), unb64u(row.key_enc));
  return new TextDecoder().decode(pt);
}

// For the agent jobs: a user's saved key for one provider, or null.
export async function getUserAgentKey(env, userId, providerId) {
  const row = await db(env).prepare("SELECT * FROM agents WHERE user_id = ?1 AND provider = ?2")
    .bind(userId, providerId).first();
  if (!row) return null;
  return { key: await openKey(env, userId, providerId, row), model: row.model || undefined };
}

const agentView = r => ({ provider: r.provider, model: r.model || null, key_hint: `…${r.key_last4}`, updated_at: r.updated_at });

// A saved key's owner: an AI provider, or a search helper ("search-tavily").
function keyOwner(provider) {
  if (provider.startsWith(SEARCH_KEY_PREFIX)) return SEARCH_HELPERS[provider.slice(SEARCH_KEY_PREFIX.length)];
  return PROVIDERS[provider];
}

async function putAgent(env, user, provider, body) {
  const p = keyOwner(provider);
  if (!p) throw new HttpError(404, `Unknown AI provider "${provider}". Known: ${Object.keys(PROVIDERS).join(", ")}, or ${SEARCH_KEY_PREFIX}<${Object.keys(SEARCH_HELPERS).join("|")}> for search helpers`);
  const model = body.model == null ? null : String(body.model).trim().slice(0, 100);
  const existing = await db(env).prepare("SELECT * FROM agents WHERE user_id = ?1 AND provider = ?2").bind(user.id, provider).first();
  const t = now();
  if (body.key == null || body.key === "") {
    if (!existing) throw new HttpError(400, "key is required the first time");
    if (model == null) return agentView(existing);
    await db(env).prepare("UPDATE agents SET model = ?1, updated_at = ?2 WHERE user_id = ?3 AND provider = ?4")
      .bind(model, t, user.id, provider).run();
    return agentView({ ...existing, model, updated_at: t });
  }
  const key = String(body.key).trim();
  if (key.length > 500 || (p.looksLikeKey && !p.looksLikeKey(key))) {
    throw new HttpError(400, `That doesn't look like a ${p.info?.name || provider} key`);
  }
  if (body.check && p.checkKey) {
    try { await p.checkKey({ ...cfg(env), retries: 0 }, key); }
    catch (e) { throw new HttpError(400, `${p.info?.name || provider} rejected this key: ${(p.friendly && p.friendly(e)) || e.message}`); }
  }
  const sealed = await sealKey(env, user.id, provider, key);
  const row = { provider, model: model ?? existing?.model ?? "", key_last4: key.slice(-4), updated_at: t };
  await db(env).prepare(
    `INSERT INTO agents (user_id, provider, model, key_enc, key_iv, key_last4, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(user_id, provider) DO UPDATE SET model = ?3, key_enc = ?4, key_iv = ?5, key_last4 = ?6, updated_at = ?7`)
    .bind(user.id, provider, row.model, sealed.key_enc, sealed.key_iv, row.key_last4, t).run();
  return agentView(row);
}

// ---------- the user's Market data ----------

function checkCol(col) {
  if (!COL_RE.test(col || "")) throw new HttpError(400, `Bad collection name "${col}"`);
  return col;
}
function checkId(id) {
  if (!ID_RE.test(id || "")) throw new HttpError(400, "Bad id: use letters, numbers, - _ . : (128 max)");
  return id;
}
function encodeDoc(doc) {
  const text = JSON.stringify(doc);
  if (text.length > MAX_DOC_BYTES) throw new HttpError(413, "Document is over 1 MB");
  return text;
}

async function getDoc(env, userId, col, id) {
  const row = await db(env).prepare("SELECT data FROM docs WHERE user_id = ?1 AND collection = ?2 AND id = ?3")
    .bind(userId, col, id).first();
  return row ? JSON.parse(row.data) : null;
}

async function roomFor(env, userId, extra) {
  const { n } = await db(env).prepare("SELECT COUNT(*) AS n FROM docs WHERE user_id = ?1").bind(userId).first();
  if (n + extra > MAX_DOCS) throw new HttpError(413, `Accounts can hold up to ${MAX_DOCS} items`);
}

async function writeDoc(env, userId, col, doc) {
  const text = encodeDoc(doc);
  if (!(await getDoc(env, userId, col, doc.id))) await roomFor(env, userId, 1);
  await db(env).prepare(
    `INSERT INTO docs (user_id, collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id, collection, id) DO UPDATE SET data = ?4, updated_at = ?5`)
    .bind(userId, col, doc.id, text, now()).run();
  return doc;
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// For the agent jobs: save a list object into the user's lists. Keeps the
// list's id when it has one (an update), otherwise makes one from the title.
export async function saveList(env, userId, list) {
  if (!list || typeof list !== "object" || Array.isArray(list)) throw new HttpError(400, "list must be an object");
  let id = list.id && ID_RE.test(list.id) ? list.id : null;
  if (!id) {
    const base = slugify(list.title) || "list";
    id = base;
    for (let i = 2; await getDoc(env, userId, "lists", id); i++) id = `${base}-${i}`;
  }
  return writeDoc(env, userId, "lists", { ...list, id });
}

async function exportAll(env, userId) {
  const { results } = await db(env).prepare(
    "SELECT collection, data FROM docs WHERE user_id = ?1 ORDER BY collection, id").bind(userId).all();
  const out = Object.fromEntries(COLLECTIONS.map(c => [c, []]));
  for (const r of results) (out[r.collection] ||= []).push(JSON.parse(r.data));
  return out;
}

async function importAll(env, userId, body, replace) {
  const rows = [];
  for (const [col, docs] of Object.entries(body)) {
    checkCol(col);
    if (!Array.isArray(docs)) throw new HttpError(400, `${col} must be an array`);
    for (const d of docs) {
      if (!d || typeof d !== "object" || Array.isArray(d)) throw new HttpError(400, `${col} has an item that isn't an object`);
      checkId(d.id);
      rows.push([col, d.id, encodeDoc(d)]);
    }
  }
  const D = db(env);
  if (replace) {
    if (rows.length > MAX_DOCS) throw new HttpError(413, `Accounts can hold up to ${MAX_DOCS} items`);
    await D.prepare("DELETE FROM docs WHERE user_id = ?1").bind(userId).run();
  } else {
    await roomFor(env, userId, rows.length);
  }
  const t = now();
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    await D.batch(rows.slice(i, i + IMPORT_CHUNK).map(([col, id, text]) => D.prepare(
      `INSERT INTO docs (user_id, collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id, collection, id) DO UPDATE SET data = ?4, updated_at = ?5`).bind(userId, col, id, text, t)));
  }
  const counts = {};
  for (const [col] of rows) counts[col] = (counts[col] || 0) + 1;
  return { imported: rows.length, counts, replaced: !!replace };
}

async function dataRoute(req, env, who, parts) {
  const user = requireUser(who, req.method !== "GET");
  const [col, id] = parts;
  if (!col) {
    if (req.method !== "GET") throw new HttpError(405, "use GET");
    return json(await exportAll(env, user.id), 200);
  }
  if (col === "import" && !id) {
    if (req.method !== "POST") throw new HttpError(405, "use POST");
    const replace = new URL(req.url).searchParams.get("replace") === "1";
    return json(await importAll(env, user.id, await readBody(req), replace), 200);
  }
  checkCol(col);
  if (!id) {
    if (req.method === "GET") {
      const { results } = await db(env).prepare("SELECT data FROM docs WHERE user_id = ?1 AND collection = ?2 ORDER BY id")
        .bind(user.id, col).all();
      return json({ collection: col, docs: results.map(r => JSON.parse(r.data)) }, 200);
    }
    if (req.method === "POST") {
      const doc = await readBody(req);
      if (doc.id == null) doc.id = newId(); else checkId(doc.id);
      if (await getDoc(env, user.id, col, doc.id)) throw new HttpError(409, `${col}/${doc.id} already exists; use PUT to replace it`);
      return json(await writeDoc(env, user.id, col, doc), 201);
    }
    throw new HttpError(405, "use GET or POST");
  }
  checkId(id);
  if (req.method === "GET") {
    const doc = await getDoc(env, user.id, col, id);
    if (!doc) throw new HttpError(404, `${col}/${id} not found`);
    return json(doc, 200);
  }
  if (req.method === "PUT") return json(await writeDoc(env, user.id, col, { ...(await readBody(req)), id }), 200);
  if (req.method === "PATCH") {
    const old = await getDoc(env, user.id, col, id);
    if (!old) throw new HttpError(404, `${col}/${id} not found`);
    return json(await writeDoc(env, user.id, col, { ...old, ...(await readBody(req)), id }), 200);
  }
  if (req.method === "DELETE") {
    const r = await db(env).prepare("DELETE FROM docs WHERE user_id = ?1 AND collection = ?2 AND id = ?3")
      .bind(user.id, col, id).run();
    if (!r.meta?.changes) throw new HttpError(404, `${col}/${id} not found`);
    return json({ deleted: `${col}/${id}` }, 200);
  }
  throw new HttpError(405, "use GET, PUT, PATCH or DELETE");
}

// ---------- auth and account routes ----------

async function signup(req, env) {
  const mode = env.SIGNUPS || "open";
  if (mode === "closed") throw new HttpError(403, "New sign-ups are closed right now");
  const body = await readBody(req);
  if (mode === "invite") {
    const code = String(body.invite || "");
    if (!env.INVITE_CODE || !sameBytes(enc.encode(code), enc.encode(env.INVITE_CODE))) {
      throw new HttpError(403, "A valid invite code is needed to sign up");
    }
  }
  if (!(await allow(env, `signup:${clientIp(req)}`, 5, 3600))) throw new HttpError(429, "Too many sign-ups from here. Try again in an hour.");
  const email = validEmail(body.email);
  const pw = await hashPassword(validPassword(body.password), null, PBKDF2_ITER);
  const id = newId();
  const t = now();
  try {
    await db(env).prepare(
      `INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(id, email, cleanName(body.name), pw.hash, pw.salt, pw.iter, t).run();
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    throw e;
  }
  const cookie = await startSession(env, req, id);
  return json({ user: { id, email, name: cleanName(body.name), created_at: t } }, 201, { "Set-Cookie": cookie });
}

// Hash work for unknown emails too, so response time doesn't reveal accounts.
const DUMMY = { pw_salt: "AAAAAAAAAAAAAAAAAAAAAA", pw_iter: PBKDF2_ITER, pw_hash: "A".repeat(43) };

async function login(req, env) {
  const body = await readBody(req);
  const email = validEmail(body.email);
  const ip = clientIp(req);
  if (!(await allow(env, `login-ip:${ip}`, 30, 900)) || !(await allow(env, `login:${email}`, 10, 900))) {
    throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  }
  const user = await db(env).prepare("SELECT * FROM users WHERE email = ?1").bind(email).first();
  const ok = await checkPassword(user || DUMMY, String(body.password || ""));
  if (!user || !ok) throw new HttpError(401, "Email or password is wrong");
  await db(env).prepare("DELETE FROM rate_limits WHERE key = ?1").bind(`login:${email}`).run();
  const cookie = await startSession(env, req, user.id);
  return json({ user: pickUser(user) }, 200, { "Set-Cookie": cookie });
}

async function me(env, user) {
  const D = db(env);
  const [agents, tokens, counts] = await Promise.all([
    D.prepare("SELECT provider, model, key_last4, updated_at FROM agents WHERE user_id = ?1 ORDER BY provider").bind(user.id).all(),
    D.prepare("SELECT id, name, prefix, scope, created_at, last_used FROM api_tokens WHERE user_id = ?1 ORDER BY created_at").bind(user.id).all(),
    D.prepare("SELECT collection, COUNT(*) AS n FROM docs WHERE user_id = ?1 GROUP BY collection").bind(user.id).all(),
  ]);
  return {
    user,
    agents: agents.results.map(agentView),
    tokens: tokens.results,
    data: Object.fromEntries(counts.results.map(r => [r.collection, r.n])),
    can_save_keys: (env.ACCOUNTS_SECRET || "").length >= 32,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.info?.name || id, key_url: p.info?.key_url || null })),
  };
}

// Name of the first field that looks like it holds a secret, or null.
function secretField(o) {
  if (!o || typeof o !== "object") return null;
  for (const [k, v] of Object.entries(o)) {
    if (SECRET_NAME_RE.test(k)) return k;
    const inner = secretField(v);
    if (inner) return inner;
  }
  return null;
}

async function deleteAccount(env, userId) {
  const D = db(env);
  await D.batch(["docs", "agents", "api_tokens", "sessions", "user_settings"].map(t => D.prepare(`DELETE FROM ${t} WHERE user_id = ?1`).bind(userId))
    .concat(D.prepare("DELETE FROM users WHERE id = ?1").bind(userId)));
}

async function meRoute(req, env, who, parts) {
  const [sub, arg] = parts;
  const D = db(env);
  // Agent tokens can read the account but not manage it.
  const user = requireUser(who, req.method !== "GET");
  if (who.via === "token" && (sub === "tokens" || sub === "agents" || sub === "password" || req.method !== "GET")) {
    throw new HttpError(403, "Agent tokens can't change account settings; sign in on the site instead");
  }

  if (!sub) {
    if (req.method === "GET") return json(await me(env, user), 200);
    if (req.method === "PATCH") {
      const name = cleanName((await readBody(req)).name);
      await D.prepare("UPDATE users SET name = ?1, updated_at = ?2 WHERE id = ?3").bind(name, now(), user.id).run();
      return json({ user: { ...user, name } }, 200);
    }
    if (req.method === "DELETE") {
      const body = await readBody(req);
      const row = await D.prepare("SELECT * FROM users WHERE id = ?1").bind(user.id).first();
      if (!(await checkPassword(row, String(body.password || "")))) throw new HttpError(401, "Password is wrong");
      await deleteAccount(env, user.id);
      return json({ deleted: true }, 200, { "Set-Cookie": sessionCookie(req, "", 0) });
    }
    throw new HttpError(405, "use GET, PATCH or DELETE");
  }

  if (sub === "password" && !arg) {
    if (req.method !== "POST") throw new HttpError(405, "use POST");
    const body = await readBody(req);
    const row = await D.prepare("SELECT * FROM users WHERE id = ?1").bind(user.id).first();
    if (!(await checkPassword(row, String(body.current || "")))) throw new HttpError(401, "Current password is wrong");
    const pw = await hashPassword(validPassword(body.password), null, PBKDF2_ITER);
    // Changing the password signs out every other device.
    await D.batch([
      D.prepare("UPDATE users SET pw_hash = ?1, pw_salt = ?2, pw_iter = ?3, updated_at = ?4 WHERE id = ?5")
        .bind(pw.hash, pw.salt, pw.iter, now(), user.id),
      D.prepare("DELETE FROM sessions WHERE user_id = ?1 AND id != ?2").bind(user.id, who.sessionId),
    ]);
    return json({ changed: true }, 200);
  }

  if (sub === "agents") {
    if (!arg) {
      if (req.method !== "GET") throw new HttpError(405, "use GET");
      const { results } = await D.prepare("SELECT provider, model, key_last4, updated_at FROM agents WHERE user_id = ?1 ORDER BY provider")
        .bind(user.id).all();
      return json({ agents: results.map(agentView), can_save_keys: (env.ACCOUNTS_SECRET || "").length >= 32 }, 200);
    }
    if (req.method === "PUT") return json(await putAgent(env, user, arg, await readBody(req)), 200);
    if (req.method === "DELETE") {
      const r = await D.prepare("DELETE FROM agents WHERE user_id = ?1 AND provider = ?2").bind(user.id, arg).run();
      if (!r.meta?.changes) throw new HttpError(404, `No saved key for ${arg}`);
      return json({ deleted: arg }, 200);
    }
    throw new HttpError(405, "use PUT or DELETE");
  }

  if (sub === "settings" && !arg) {
    if (req.method === "GET") {
      const row = await D.prepare("SELECT data, updated_at FROM user_settings WHERE user_id = ?1").bind(user.id).first();
      return json({ settings: row ? JSON.parse(row.data) : {}, updated_at: row?.updated_at || null }, 200);
    }
    if (req.method !== "PUT") throw new HttpError(405, "use GET or PUT");
    const settings = await readBody(req);
    const text = JSON.stringify(settings);
    if (text.length > MAX_SETTINGS_BYTES) throw new HttpError(413, "Settings are over 16 KB");
    const bad = secretField(settings);
    if (bad) throw new HttpError(400, `Settings can't hold keys or passwords ("${bad}"). Save AI keys under /api/me/agents.`);
    const t = now();
    await D.prepare(`INSERT INTO user_settings (user_id, data, updated_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(user_id) DO UPDATE SET data = ?2, updated_at = ?3`).bind(user.id, text, t).run();
    return json({ settings, updated_at: t }, 200);
  }

  if (sub === "tokens") {
    if (!arg) {
      if (req.method === "GET") {
        const { results } = await D.prepare("SELECT id, name, prefix, scope, created_at, last_used FROM api_tokens WHERE user_id = ?1 ORDER BY created_at")
          .bind(user.id).all();
        return json({ tokens: results }, 200);
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const name = cleanName(body.name) || "My agent";
        const scope = body.scope === "read" ? "read" : "write";
        const { n } = await D.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?1").bind(user.id).first();
        if (n >= MAX_TOKENS) throw new HttpError(400, `You can have up to ${MAX_TOKENS} agent tokens. Delete one first.`);
        const token = `wm_${randomToken()}`;
        const row = { id: newId(), name, prefix: token.slice(0, 7), scope, created_at: now(), last_used: null };
        await D.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(row.id, user.id, name, await sha256(token), row.prefix, scope, row.created_at).run();
        return json({ ...row, token, note: "Copy this token now. It won't be shown again." }, 201);
      }
      throw new HttpError(405, "use GET or POST");
    }
    if (req.method !== "DELETE") throw new HttpError(405, "use DELETE");
    const r = await D.prepare("DELETE FROM api_tokens WHERE user_id = ?1 AND id = ?2").bind(user.id, arg).run();
    if (!r.meta?.changes) throw new HttpError(404, "Token not found");
    return json({ deleted: arg }, 200);
  }

  throw new HttpError(404, "not found");
}

// ---------- router ----------

export function isAccountsPath(path) {
  return /^\/api\/(auth|me|data)(\/|$)/.test(path);
}

export async function handle(req, env) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(2).map(decodeURIComponent); // drop "", "api"
  const [area, ...rest] = parts;
  try {
    if (area === "auth") {
      const action = rest[0];
      if (action === "signup" || action === "login" || action === "logout") {
        if (req.method !== "POST") throw new HttpError(405, "use POST");
        checkOrigin(req, { via: "session" });
      }
      if (action === "signup") return await signup(req, env);
      if (action === "login") return await login(req, env);
      if (action === "logout") {
        const who = await authenticate(req, env);
        if (who?.via === "session") {
          const all = url.searchParams.get("all") === "1";
          await db(env).prepare(all ? "DELETE FROM sessions WHERE user_id = ?1" : "DELETE FROM sessions WHERE id = ?1")
            .bind(all ? who.user.id : who.sessionId).run();
        }
        return json({ signed_out: true }, 200, { "Set-Cookie": sessionCookie(req, "", 0) });
      }
      throw new HttpError(404, "not found");
    }
    const who = await authenticate(req, env);
    checkOrigin(req, who);
    if (area === "me") return await meRoute(req, env, who, rest);
    if (area === "data") return await dataRoute(req, env, who, rest);
    throw new HttpError(404, "not found");
  } catch (e) {
    const known = e instanceof HttpError;
    if (!known) console.error(e);
    const out = { error: known ? e.message : "Something went wrong on the server" };
    if (known && e.details?.hint) out.hint = e.details.hint;
    return json(out, known ? e.status : 500);
  }
}
