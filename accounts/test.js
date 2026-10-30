// Offline tests for accounts.js against an in-memory SQLite stand-in for D1:
//   node --test accounts/test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handle, getSessionUser, getUserAgentKey, saveList, isAccountsPath } from "./accounts.js";

// Fake Gemini-shaped key, joined at run time so secret scanners don't flag it.
const FAKE_KEY = "AIza" + "SyD-test-key-1234567890abcdefghijk";

// Minimal D1 API over node:sqlite: prepare().bind().first/all/run, batch.
function fakeD1() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  sql.exec(fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async col => { const r = sql.prepare(q).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ success: true, results: sql.prepare(q).all(...args).map(r => ({ ...r })), meta: {} }),
    run: async () => { const r = sql.prepare(q).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    sql,
    prepare: q => stmt(q),
    batch: async list => {
      sql.exec("BEGIN");
      try { const out = []; for (const s of list) out.push(await s.run()); sql.exec("COMMIT"); return out; }
      catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
}

let env;
beforeEach(() => { env = { DB: fakeD1(), ACCOUNTS_SECRET: "x".repeat(40) }; });

const ORIGIN = "https://wishlistmarket.pages.dev";
function call(method, path, { body, cookie, token, headers = {}, ip = "1.1.1.1" } = {}) {
  const h = { "CF-Connecting-IP": ip, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  if (token) h.Authorization = `Bearer ${token}`;
  return handle(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const cookieOf = r => (r.headers.get("Set-Cookie") || "").split(";")[0];
async function signup(email = "ann@example.com", password = "correct horse") {
  const r = await call("POST", "/api/auth/signup", { body: { email, password, name: "Ann" } });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return cookieOf(r);
}

test("routes the right paths", () => {
  assert.ok(isAccountsPath("/api/auth/login"));
  assert.ok(isAccountsPath("/api/me"));
  assert.ok(isAccountsPath("/api/data/lists/x"));
  assert.ok(!isAccountsPath("/api/ask"));
  assert.ok(!isAccountsPath("/api/agent/find-products"));
});

test("sign up sets a secure session cookie and /api/me works", async () => {
  const r = await call("POST", "/api/auth/signup", { body: { email: " Ann@Example.com ", password: "correct horse", name: "Ann" } });
  assert.equal(r.status, 201);
  const set = r.headers.get("Set-Cookie");
  assert.match(set, /^wm_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.equal((await r.json()).user.email, "ann@example.com");
  const me = await (await call("GET", "/api/me", { cookie: cookieOf(r) })).json();
  assert.equal(me.user.name, "Ann");
  assert.deepEqual(me.agents, []);
  assert.equal(me.can_save_keys, true);
  assert.ok(me.providers.some(p => p.id === "gemini"));
  // Nothing secret is stored in plain text.
  const u = env.DB.sql.prepare("SELECT * FROM users").get();
  assert.ok(!JSON.stringify(u).includes("correct horse"));
  const s = env.DB.sql.prepare("SELECT id FROM sessions").get();
  assert.ok(!set.includes(s.id));
});

test("sign up rejects bad input and duplicate emails", async () => {
  assert.equal((await call("POST", "/api/auth/signup", { body: { email: "nope", password: "correct horse" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/signup", { body: { email: "a@b.co", password: "short" } })).status, 400);
  await signup();
  const r = await call("POST", "/api/auth/signup", { body: { email: "ANN@example.com", password: "another one" }, ip: "2.2.2.2" });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /already exists/);
});

test("sign-up modes: closed and invite", async () => {
  env.SIGNUPS = "closed";
  assert.equal((await call("POST", "/api/auth/signup", { body: { email: "a@b.co", password: "correct horse" } })).status, 403);
  env.SIGNUPS = "invite"; env.INVITE_CODE = "let-me-in";
  assert.equal((await call("POST", "/api/auth/signup", { body: { email: "a@b.co", password: "correct horse", invite: "wrong" } })).status, 403);
  assert.equal((await call("POST", "/api/auth/signup", { body: { email: "a@b.co", password: "correct horse", invite: "let-me-in" } })).status, 201);
});

test("log in, wrong password, log out", async () => {
  await signup();
  const bad = await call("POST", "/api/auth/login", { body: { email: "ann@example.com", password: "wrong pass" } });
  assert.equal(bad.status, 401);
  const nobody = await call("POST", "/api/auth/login", { body: { email: "who@example.com", password: "wrong pass" } });
  assert.equal(nobody.status, 401);
  assert.equal((await bad.json()).error, (await nobody.json()).error); // doesn't reveal who has an account
  const ok = await call("POST", "/api/auth/login", { body: { email: "ANN@example.com", password: "correct horse" } });
  assert.equal(ok.status, 200);
  const c = cookieOf(ok);
  assert.equal((await call("GET", "/api/me", { cookie: c })).status, 200);
  const out = await call("POST", "/api/auth/logout", { cookie: c });
  assert.match(out.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await call("GET", "/api/me", { cookie: c })).status, 401);
});

test("too many wrong passwords are slowed down", async () => {
  await signup();
  let last;
  for (let i = 0; i < 11; i++) last = await call("POST", "/api/auth/login", { body: { email: "ann@example.com", password: "wrong pass" } });
  assert.equal(last.status, 429);
});

test("expired sessions are refused", async () => {
  const c = await signup();
  env.DB.sql.exec("UPDATE sessions SET expires_at = 1");
  assert.equal((await call("GET", "/api/me", { cookie: c })).status, 401);
});

test("cookie requests from another site are refused", async () => {
  const c = await signup();
  const r = await call("PUT", "/api/data/lists/x", { cookie: c, body: { title: "x" }, headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  const r2 = await call("PUT", "/api/data/lists/x", { cookie: c, body: { title: "x" }, headers: { Origin: ORIGIN } });
  assert.equal(r2.status, 200);
});

test("each user sees only their own data", async () => {
  const a = await signup("a@example.com");
  const b = await signup("b@example.com");
  await call("PUT", "/api/data/lists/headsets", { cookie: a, body: { title: "Headsets", items: [] } });
  assert.equal((await call("GET", "/api/data/lists/headsets", { cookie: a })).status, 200);
  assert.equal((await call("GET", "/api/data/lists/headsets", { cookie: b })).status, 404);
  assert.deepEqual((await (await call("GET", "/api/data/lists", { cookie: b })).json()).docs, []);
  assert.equal((await call("GET", "/api/data/lists", {})).status, 401);
});

test("data create, read, patch, replace, delete", async () => {
  const c = await signup();
  const made = await call("POST", "/api/data/projects", { cookie: c, body: { title: "Kitchen" } });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  assert.ok(id);
  assert.equal((await call("POST", "/api/data/projects", { cookie: c, body: { id, title: "dup" } })).status, 409);
  const p = await (await call("PATCH", `/api/data/projects/${id}`, { cookie: c, body: { note: "hi" } })).json();
  assert.deepEqual(p, { id, title: "Kitchen", note: "hi" });
  const r = await (await call("PUT", `/api/data/projects/${id}`, { cookie: c, body: { title: "New" } })).json();
  assert.deepEqual(r, { id, title: "New" });
  assert.equal((await call("DELETE", `/api/data/projects/${id}`, { cookie: c })).status, 200);
  assert.equal((await call("DELETE", `/api/data/projects/${id}`, { cookie: c })).status, 404);
  assert.equal((await call("GET", "/api/data/Bad-Name", { cookie: c })).status, 400);
  assert.equal((await call("GET", "/api/data/lists/bad%20id", { cookie: c })).status, 400);
});

test("import the real site data, then export it back unchanged", async () => {
  const c = await signup();
  // The site's data snapshot: public/ in the site repo, pages/site/ in project files.
  const file = ["../public/data.json", "../../pages/site/data.json"].map(f => new URL(f, import.meta.url)).find(f => fs.existsSync(f));
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = await call("POST", "/api/data/import", { cookie: c, body: data });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const j = await r.json();
  assert.equal(j.imported, Object.values(data).reduce((n, v) => n + v.length, 0));
  const back = await (await call("GET", "/api/data", { cookie: c })).json();
  for (const col of Object.keys(data)) {
    const byId = d => [...d].sort((x, y) => (x.id < y.id ? -1 : 1));
    assert.deepEqual(byId(back[col]), byId(data[col]), col);
  }
  // Import again with replace=1: same counts, no duplicates.
  await call("POST", "/api/data/import?replace=1", { cookie: c, body: { lists: data.lists.slice(0, 2) } });
  const me = await (await call("GET", "/api/me", { cookie: c })).json();
  assert.deepEqual(me.data, { lists: 2 });
});

test("AI keys are stored encrypted and never sent back", async () => {
  const c = await signup();
  const key = FAKE_KEY;
  const r = await call("PUT", "/api/me/agents/gemini", { cookie: c, body: { key, model: "gemini-3.5-flash-lite" } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const view = await r.json();
  assert.equal(view.key_hint, "…hijk");
  assert.ok(!JSON.stringify(view).includes(key));
  const row = env.DB.sql.prepare("SELECT * FROM agents").get();
  assert.ok(!JSON.stringify(row).includes(key));
  const me = await (await call("GET", "/api/me", { cookie: c })).json();
  assert.ok(!JSON.stringify(me).includes(key));
  // The agent jobs can read it back on the server.
  const u = await getSessionUser(new Request(ORIGIN + "/api/ask", { headers: { Cookie: c } }), env);
  assert.deepEqual(await getUserAgentKey(env, u.id, "gemini"), { key, model: "gemini-3.5-flash-lite" });
  assert.equal(await getUserAgentKey(env, u.id, "openai"), null);
  // Change the model only, keep the key.
  await call("PUT", "/api/me/agents/gemini", { cookie: c, body: { model: "gemini-3.8-flash" } });
  assert.deepEqual(await getUserAgentKey(env, u.id, "gemini"), { key, model: "gemini-3.8-flash" });
  // A different secret can't read it.
  await assert.rejects(getUserAgentKey({ ...env, ACCOUNTS_SECRET: "y".repeat(40) }, u.id, "gemini"));
  assert.equal((await call("PUT", "/api/me/agents/nope", { cookie: c, body: { key } })).status, 404);
  assert.equal((await call("DELETE", "/api/me/agents/gemini", { cookie: c })).status, 200);
  assert.equal(await getUserAgentKey(env, u.id, "gemini"), null);
});

test("without ACCOUNTS_SECRET keys can't be saved, but accounts work", async () => {
  delete env.ACCOUNTS_SECRET;
  const c = await signup();
  const r = await call("PUT", "/api/me/agents/gemini", { cookie: c, body: { key: FAKE_KEY } });
  assert.equal(r.status, 503);
  assert.match((await r.json()).hint, /each request/);
  assert.equal((await (await call("GET", "/api/me", { cookie: c })).json()).can_save_keys, false);
});

test("agent tokens: write token edits data, read token can't, neither manages the account", async () => {
  const c = await signup();
  const made = await (await call("POST", "/api/me/tokens", { cookie: c, body: { name: "My Claude", scope: "write" } })).json();
  assert.match(made.token, /^wm_[\w-]{40,}$/);
  const ro = await (await call("POST", "/api/me/tokens", { cookie: c, body: { name: "Reader", scope: "read" } })).json();
  // The token itself is only stored hashed and isn't listed.
  const list = await (await call("GET", "/api/me/tokens", { cookie: c })).json();
  assert.equal(list.tokens.length, 2);
  assert.ok(!JSON.stringify(list).includes(made.token));

  assert.equal((await call("PUT", "/api/data/lists/a", { token: made.token, body: { title: "A" } })).status, 200);
  assert.equal((await call("GET", "/api/data/lists/a", { token: ro.token })).status, 200);
  assert.equal((await call("PUT", "/api/data/lists/a", { token: ro.token, body: { title: "B" } })).status, 403);
  assert.equal((await call("GET", "/api/me", { token: ro.token })).status, 200);
  assert.equal((await call("POST", "/api/me/tokens", { token: made.token, body: {} })).status, 403);
  assert.equal((await call("PUT", "/api/me/agents/gemini", { token: made.token, body: { key: FAKE_KEY } })).status, 403);
  assert.equal((await call("GET", "/api/me/agents", { token: made.token })).status, 403);
  assert.equal((await call("GET", "/api/data/lists", { token: "wm_madeup" })).status, 401);

  assert.equal((await call("DELETE", `/api/me/tokens/${made.id}`, { cookie: c })).status, 200);
  assert.equal((await call("GET", "/api/data/lists", { token: made.token })).status, 401);
});

test("saveList makes a fresh id from the title, or keeps the given one", async () => {
  const c = await signup();
  const u = await getSessionUser(new Request(ORIGIN, { headers: { Cookie: c } }), env);
  const a = await saveList(env, u.id, { title: "Headsets with Mic", items: [] });
  const b = await saveList(env, u.id, { title: "Headsets with Mic", items: [] });
  assert.equal(a.id, "headsets-with-mic");
  assert.equal(b.id, "headsets-with-mic-2");
  const again = await saveList(env, u.id, { ...a, items: [{ name: "x" }] });
  assert.equal(again.id, a.id);
  const got = await (await call("GET", `/api/data/lists/${a.id}`, { cookie: c })).json();
  assert.equal(got.items.length, 1);
});

test("change password signs out other devices; delete account removes everything", async () => {
  const c1 = await signup();
  const c2 = cookieOf(await call("POST", "/api/auth/login", { body: { email: "ann@example.com", password: "correct horse" } }));
  assert.equal((await call("POST", "/api/me/password", { cookie: c1, body: { current: "nope", password: "new password!" } })).status, 401);
  assert.equal((await call("POST", "/api/me/password", { cookie: c1, body: { current: "correct horse", password: "new password!" } })).status, 200);
  assert.equal((await call("GET", "/api/me", { cookie: c1 })).status, 200);
  assert.equal((await call("GET", "/api/me", { cookie: c2 })).status, 401);
  await call("PUT", "/api/data/lists/a", { cookie: c1, body: { title: "A" } });
  await call("PUT", "/api/me/agents/gemini", { cookie: c1, body: { key: FAKE_KEY } });
  await call("PUT", "/api/me/settings", { cookie: c1, body: { theme: "dark" } });
  assert.equal((await call("DELETE", "/api/me", { cookie: c1, body: { password: "wrong" } })).status, 401);
  assert.equal((await call("DELETE", "/api/me", { cookie: c1, body: { password: "new password!" } })).status, 200);
  for (const t of ["users", "sessions", "docs", "agents", "api_tokens", "user_settings"]) {
    assert.equal(env.DB.sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test("settings: save, read (also by agent token), no secrets, size cap", async () => {
  const c = await signup();
  assert.deepEqual((await (await call("GET", "/api/me/settings", { cookie: c })).json()).settings, {});
  const prefs = { location: "Springfield", stores: ["amazon", "walmart"], listSize: 10, theme: "dark" };
  assert.equal((await call("PUT", "/api/me/settings", { cookie: c, body: prefs })).status, 200);
  assert.deepEqual((await (await call("GET", "/api/me/settings", { cookie: c })).json()).settings, prefs);
  const tok = (await (await call("POST", "/api/me/tokens", { cookie: c, body: { scope: "write" } })).json()).token;
  assert.deepEqual((await (await call("GET", "/api/me/settings", { token: tok })).json()).settings, prefs);
  assert.equal((await call("PUT", "/api/me/settings", { token: tok, body: {} })).status, 403);
  const bad = await call("PUT", "/api/me/settings", { cookie: c, body: { ai: { apiKey: "x" } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /apiKey/);
  assert.equal((await call("PUT", "/api/me/settings", { cookie: c, body: { big: "x".repeat(17000) } })).status, 413);
});

test("no DB binding gives a clear error", async () => {
  env = {};
  const r = await call("POST", "/api/auth/signup", { body: { email: "a@b.co", password: "correct horse" } });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not set up/);
});
