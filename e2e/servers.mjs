// Browser test servers: the site (public/ + /api via app.js, accounts in an
// in-memory database) on :8788, and a fake Ollama (CORS like OLLAMA_ORIGINS),
// Tavily, OpenAI and store pages on :11434.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../app.js";
import { fakeD1 } from "../accounts/fake-d1.js";

const ROOT = fileURLToPath(new URL("../public", import.meta.url));
const SITE_PORT = 8788, FAKE_PORT = 11434;
export const state = { allowed: [], chats: [] };
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const env = { AI_RETRIES: "0", LINK_ALLOW_PRIVATE: "true", DB: fakeD1(), ACCOUNTS_SECRET: "e2e-".repeat(10),
  AI_API_BASES: JSON.stringify({ tavily: `${FAKE}/tavily`, openai: `${FAKE}/openai/v1` }) };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".jpg": "image/jpeg", ".webp": "image/webp" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${SITE_PORT}`);
  if (url.pathname.startsWith("/api")) {
    let body = ""; for await (const c of req) body += c;
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!path.extname(p)) p += ".html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(SITE_PORT);

const STORE = { "/shop/a": "Widget A", "/shop/b": "Widget B", "/shop/c": "Widget C" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, FAKE);
  const origin = req.headers.origin;
  const cors = origin && state.allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } : {};
  const send = (status, json, extra = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra }); res.end(JSON.stringify(json)); };
  if (STORE[u.pathname]) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(`<html>${STORE[u.pathname]} in stock</html>`); }
  let b = ""; for await (const c of req) b += c;
  const body = b ? JSON.parse(b) : null;
  if (u.pathname === "/tavily/usage") return send(200, { key: { usage: 1 } });
  if (u.pathname === "/tavily/search") return send(200, { results: [
    { title: "Widget A", url: `${FAKE}/shop/a`, content: "Widget A $11" }, { title: "Widget B", url: `${FAKE}/shop/b`, content: "Widget B $12" },
    { title: "Widget C", url: `${FAKE}/shop/c`, content: "Widget C $13" }] });
  if (u.pathname === "/openai/v1/models") return send(200, { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] });
  // Ollama: preflight + API. Like Ollama, origins not allowed get 403 with no CORS headers.
  if (req.method === "OPTIONS") { if (!cors["Access-Control-Allow-Origin"]) { res.writeHead(403); return res.end(); } res.writeHead(204, cors); return res.end(); }
  if (origin && !cors["Access-Control-Allow-Origin"]) { res.writeHead(403); return res.end(); }
  if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/plain", ...cors }); return res.end("Ollama is running"); }
  if (u.pathname === "/api/tags") return send(200, { models: [{ name: "gemma4:12b", model: "gemma4:12b", size: 8e9 }, { name: "qwen3.5:9b", model: "qwen3.5:9b", size: 7e9 }] });
  if (u.pathname === "/api/chat") {
    state.chats.push(body);
    const prompt = body.messages.at(-1).content;
    if (!body.format || !body.options?.num_ctx) return send(400, { error: "expected format + num_ctx" });
    if (/search queries/.test(prompt)) return send(200, { model: body.model, message: { role: "assistant", content: '{"queries":["kitchen widgets","widgets amazon"]}' }, done: true });
    const products = [
      { rank: 1, source: 2, type: "Widgets", name: "Widget B", store: "Example", url: `${FAKE}/shop/b`, why: "Best value" },
      { rank: 2, source: 1, type: "Widgets", name: "Widget A", store: "Example", url: `${FAKE}/shop/a`, why: "Solid" },
      { rank: 3, source: 3, type: "Widgets", name: "Widget C", store: "Example", url: `${FAKE}/shop/c`, why: "Fine" }];
    return send(200, { model: body.model, message: { role: "assistant", content: JSON.stringify({ title: "Kitchen widgets", category: "Home & Kitchen", summary: "Widgets", products }) }, done: true, prompt_eval_count: 900, eval_count: 300 });
  }
  send(404, { error: "not found" });
}).listen(FAKE_PORT);
console.log("servers up");
