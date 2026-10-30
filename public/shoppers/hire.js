// The "Hire AI shoppers" page (/hire). Your team of shoppers lives in the
// site settings (localStorage "wm.settings": team, ai.lead, search), and is
// synced to the account when signed in. Keys never go in the settings: each
// is kept in this browser under "wm.key.<provider>" (search helpers under
// "wm.key.search-<id>"), or encrypted in the account (PUT /api/me/agents/:id).

import { HOSTED, SEARCH_INFO, LOCAL_RUNTIMES, LOCAL_NOTES, GPUS, RESEARCHED, suggest } from "./catalog.js";
import * as local from "./local.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const read = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch (_) { return false; } };
const uid = () => `m-${Math.random().toString(36).slice(2, 9)}`;
const today = () => new Date().toISOString().slice(0, 10);
const initials = s => String(s || "?").replace(/\(.*?\)/g, "").split(/[\s-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();

// ---------- settings, keys, account ----------

const SKEY = "wm.settings";
let S = (() => { try { return JSON.parse(read(SKEY) || "{}"); } catch (_) { return {}; } })();
S.ai = S.ai || {}; S.team = Array.isArray(S.team) ? S.team : []; S.search = S.search || { provider: "tavily" };
S.display = S.display || {};
let me = null;

function saveS() {
  write(SKEY, JSON.stringify(S));
  if (me) fetch("/api/me/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(S) }).catch(() => {});
  window.dispatchEvent(new Event("wm:reload"));
}
const keyOf = id => read(`wm.key.${id}`) || (id === "gemini" ? read("wm.aiKey") : "") || "";
function setKey(id, v) {
  const ok = write(`wm.key.${id}`, v || null);
  if (id === "gemini") write("wm.aiKey", v || null); // the old single-key slot
  return ok;
}
const inAccount = id => !!me?.agents?.some(a => a.provider === id);

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let j = {};
  try { j = await r.json(); } catch (_) {}
  if (!r.ok) { const e = new Error(j.error || `Error ${r.status}`); e.hint = j.hint; e.status = r.status; throw e; }
  return j;
}
const showMsg = (el, text, kind, hint) => { el.className = `msg ${kind || ""}`; el.innerHTML = `${esc(text)}${hint ? `<span class="hint">${esc(hint)}</span>` : ""}`; };

// ---------- catalog from the server (falls back to the built-in copy) ----------

let hosted = [], helpers = [];
async function loadCatalog() {
  try {
    const j = await api("/api/shoppers");
    hosted = j.hosted; helpers = j.search_helpers;
  } catch (_) {
    hosted = Object.entries(HOSTED).map(([id, h]) => ({ id, name: h.title, searches: ["gemini", "openai", "anthropic", "xai", "perplexity", "openrouter"].includes(id), ...h }));
    helpers = Object.entries(SEARCH_INFO).map(([id, h]) => ({ id, name: id, ...h }));
  }
}
const hostedInfo = id => hosted.find(h => h.id === id);
const searches = id => !!hostedInfo(id)?.searches;

// ---------- team ----------

const lead = () => S.team.find(m => m.id === S.ai.lead);
function memberName(m) {
  if (m.kind === "local") return LOCAL_RUNTIMES[m.provider]?.title || "Local shopper";
  return hostedInfo(m.provider)?.title || hostedInfo(m.provider)?.name || m.provider;
}
function hire(member, { makeLead } = {}) {
  S.team = S.team.filter(m => m.id !== member.id);
  S.team.push(member);
  if (makeLead || !lead()) makeLeadOf(member);
  if (S.team.length > 12) S.team = S.team.slice(-12);
  saveS(); drawTeam(); drawTry();
}
function makeLeadOf(m) {
  S.ai.lead = m.id;
  if (m.kind === "hosted") { S.ai.provider = m.provider; S.ai.model = m.model || ""; }
}

// Someone who set up a key in Settings before shoppers existed already has a lead.
function adoptOldSetup() {
  if (S.team.length) return;
  const p = S.ai.provider || "gemini";
  if (keyOf(p) || inAccount(p)) {
    const m = { id: uid(), kind: "hosted", provider: p, model: S.ai.model || "", hiredAt: today(), tested: today() };
    S.team.push(m); S.ai.lead = m.id; saveS();
  }
}

function keyStatus(m) {
  if (m.kind === "local") return m.tested ? ["good", "Ready"] : ["warn", "Needs setup"];
  const k = keyOf(m.provider);
  if (k) return ["good", `Key in this browser (…${k.slice(-4)})`];
  if (inAccount(m.provider)) return ["good", "Key in your account"];
  if (hostedInfo(m.provider)?.key_optional) return ["good", "No key needed"];
  return ["warn", "No key yet"];
}

function drawTeam() {
  const el = $("#team-list");
  if (!S.team.length) {
    el.innerHTML = `<p class="team-empty">No shoppers yet. Hire a cloud shopper below, or let us suggest local ones for your graphics card.</p>`;
    return;
  }
  const L = lead();
  const sorted = [...S.team].sort((a, b) => (b === L) - (a === L));
  el.innerHTML = sorted.map(m => {
    const [kind, status] = keyStatus(m);
    const needsHelper = m.kind === "local" || !searches(m.provider);
    const helperOk = !needsHelper || keyOf(`search-${S.search.provider}`) || inAccount(`search-${S.search.provider}`) || (m.provider === "ollama-cloud" && S.search.provider === "ollama");
    const role = m === L ? "Lead shopper" : m.role || "Shopper";
    return `<div class="member" data-id="${esc(m.id)}">
      <div class="ava" aria-hidden="true">${esc(initials(m.model || memberName(m)))}</div>
      <div class="body">
        <div class="badges">${m === L ? `<span class="badge lead">Lead shopper</span>` : `<span class="badge">${esc(role)}</span>`}
          <span class="badge ${kind}">${esc(status)}</span>
          ${needsHelper ? `<span class="badge ${helperOk ? "" : "warn"}">${helperOk ? "Uses your search helper" : "Needs a search helper"}</span>` : `<span class="badge">Searches the web itself</span>`}</div>
        <b>${esc(m.label || m.model || "Default model")}</b>
        <span class="small">${esc(memberName(m))}${m.model && m.label ? ` · ${esc(m.model)}` : ""}${m.kind === "local" && m.base ? ` · ${esc(m.base)}` : ""}</span>
        <div class="acts">
          ${m === L ? "" : `<button type="button" class="plain" data-act="lead">Make lead</button>`}
          <button type="button" class="plain" data-act="edit">${m.kind === "local" && !m.tested ? "Set up" : "Settings"}</button>
          <button type="button" class="bad" data-act="fire">Fire</button>
        </div>
      </div></div>`;
  }).join("");
}

$("#team-list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const m = S.team.find(x => x.id === b.closest("[data-id]").dataset.id);
  if (!m) return;
  if (b.dataset.act === "lead") { makeLeadOf(m); saveS(); drawTeam(); drawTry(); }
  if (b.dataset.act === "fire") {
    if (!confirm(`Fire ${m.label || m.model || memberName(m)}? Their key stays saved for other shoppers from the same company.`)) return;
    S.team = S.team.filter(x => x !== m);
    if (S.ai.lead === m.id) { S.ai.lead = ""; if (S.team[0]) makeLeadOf(S.team[0]); }
    saveS(); drawTeam(); drawTry();
  }
  if (b.dataset.act === "edit") m.kind === "local" ? openLocal(m.provider, m) : openHosted(m.provider, m);
});

// ---------- dialog ----------

const dlg = $("#dlg");
dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
function openDialog(title, html) {
  $("#dlg-h").textContent = title;
  $("#dlg-bd").innerHTML = html;
  if (!dlg.open) dlg.showModal();
  return $("#dlg-bd");
}

// ---------- cloud shoppers ----------

function drawCloud() {
  $("#cloud-list").innerHTML = hosted.map(h => {
    const hired = S.team.some(m => m.kind === "hosted" && m.provider === h.id);
    return `<article class="cv">
      ${hired ? `<span class="stamp">HIRED</span>` : ""}
      <h3>${esc(h.title || h.name)}</h3>
      <p class="tag">${esc(h.tagline || "")}</p>
      <div class="badges">${h.searches ? `<span class="badge good">Searches the web itself</span>` : `<span class="badge warn">Needs a search helper</span>`}</div>
      ${h.strengths?.length ? `<ul>${h.strengths.map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${h.cost ? `<p class="cost">${esc(h.cost)}</p>` : ""}
      <div class="acts"><button type="button" data-hire="${esc(h.id)}">${hired ? "Hire another" : "Hire"}</button></div>
    </article>`;
  }).join("");
}
$("#cloud-list").addEventListener("click", e => { const b = e.target.closest("[data-hire]"); if (b) openHosted(b.dataset.hire); });

function openHosted(id, member) {
  const h = hostedInfo(id);
  if (!h) return;
  const k = keyOf(id);
  const models = h.models || [];
  const cur = member?.model || "";
  const modelField = h.needs_base_url
    ? `<label class="f"><span>Model</span><input id="h-model" value="${esc(cur)}" placeholder="Load the list, or type the model's id"></label>`
    : `<label class="f"><span>Model</span><select id="h-model">${[["", `Recommended (${h.default_model})`], ...models.filter(([v]) => v !== h.default_model)].map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("")}${cur && !models.some(([v]) => v === cur) && cur !== h.default_model ? `<option selected value="${esc(cur)}">${esc(cur)}</option>` : ""}</select></label>`;
  const bd = openDialog(`Hire ${h.title || h.name}`, `
    <p class="small" style="margin:0">${esc(h.tagline || "")}</p>
    <div><b style="font-size:14px">How to get a key</b><ol class="steps">${(h.steps || []).map(s => `<li>${esc(s)}</li>`).join("")}</ol>
      ${h.key_url ? `<a class="btn plain" href="${esc(h.key_url)}" target="_blank" rel="noopener">Open ${esc(new URL(h.key_url).hostname)}</a>` : ""}</div>
    ${h.needs_base_url ? `<label class="f"><span>Server address</span><input id="h-base" value="${esc(member?.base || "")}" placeholder="https://my-server.example/v1" inputmode="url"><small>Must be on the internet (https). For a server on your own computer, hire it as a local shopper instead.</small></label>` : ""}
    <label class="f"><span>API key${h.key_optional ? " (if it needs one)" : ""}</span><input id="h-key" type="password" autocomplete="off" spellcheck="false"
      placeholder="${k ? `Saved in this browser (…${esc(k.slice(-4))})` : inAccount(id) ? "Saved in your account" : "Paste your key"}"><small>Never share your key in chat or email.</small></label>
    ${me && !h.needs_base_url ? `<div class="seg" role="radiogroup" aria-label="Where to keep the key"><label><input type="radio" name="kw" value="browser" ${S.ai.keyWhere !== "account" ? "checked" : ""}> Keep it in this browser</label><label><input type="radio" name="kw" value="account" ${S.ai.keyWhere === "account" ? "checked" : ""}> Keep it in my account (encrypted)</label></div>` : ""}
    ${modelField}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" id="h-go">${member ? "Test and save" : "Test the key and hire"}</button><button type="button" class="plain" id="h-models">Load all models my key can use</button></div>
    <p class="msg" id="h-msg" role="status"></p>
    ${h.searches ? "" : `<p class="small" style="margin:0">This shopper finds product pages through your search helper. ${keyOf(`search-${S.search.provider}`) || inAccount(`search-${S.search.provider}`) || id === "ollama-cloud" ? "You have one." : `<a href="#helpers" data-close>Hire a search helper</a> too (Tavily is free).`}</p>`}`);

  const headers = typed => {
    const hd = { "X-AI-Provider": id };
    const kk = typed || keyOf(id);
    if (kk) hd["X-AI-Key"] = kk;
    const base = bd.querySelector("#h-base")?.value.trim();
    if (base) hd["X-AI-Base-URL"] = base;
    return hd;
  };
  const msg = bd.querySelector("#h-msg");
  bd.querySelector("#h-models").addEventListener("click", async ev => {
    const btn = ev.currentTarget; btn.disabled = true; showMsg(msg, "Loading models…");
    try {
      const r = await api("/api/models", { headers: headers(bd.querySelector("#h-key").value.trim()) });
      const list = (r.models || []).filter(m => !/embed|tts|whisper|image|audio|realtime|transcribe|moderation|guard/i.test(m.id));
      const sel = bd.querySelector("#h-model");
      if (sel.tagName === "SELECT") {
        const have = new Set([...sel.options].map(o => o.value));
        for (const m of list) if (!have.has(m.id)) sel.insertAdjacentHTML("beforeend", `<option value="${esc(m.id)}">${esc(m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id)}</option>`);
      } else {
        sel.setAttribute("list", "h-model-list");
        sel.insertAdjacentHTML("afterend", `<datalist id="h-model-list">${list.map(m => `<option value="${esc(m.id)}">`).join("")}</datalist>`);
        if (!sel.value && list[0]) sel.value = list[0].id;
      }
      showMsg(msg, `${list.length} models available.`, "good");
    } catch (err) { showMsg(msg, err.message, "bad", err.hint); }
    finally { btn.disabled = false; }
  });
  bd.querySelector("#h-go").addEventListener("click", async ev => {
    const btn = ev.currentTarget;
    const typed = bd.querySelector("#h-key").value.trim();
    const model = bd.querySelector("#h-model").value.trim();
    const base = bd.querySelector("#h-base")?.value.trim();
    const where = bd.querySelector('input[name="kw"]:checked')?.value || "browser";
    if (h.needs_base_url && !base) return showMsg(msg, "Enter the server's address first.", "bad");
    if (h.needs_base_url && !model) return showMsg(msg, "Pick a model (load the list first).", "bad");
    if (!typed && !keyOf(id) && !inAccount(id) && !h.key_optional) return showMsg(msg, "Paste your key first.", "bad");
    btn.disabled = true; showMsg(msg, "Checking with " + (h.title || h.name) + "…");
    try {
      if (typed && where === "account" && me) {
        await api(`/api/me/agents/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: typed, model: model || null, check: true }) });
        setKey(id, null);
        await refreshMe();
      } else {
        const r = await api("/api/key-check", { headers: headers(typed) });
        if (!r.key_works) { btn.disabled = false; return showMsg(msg, r.error || "That key didn't work.", "bad"); }
        if (typed && !setKey(id, typed)) showMsg(msg, "The key works, but this browser won't save it (private mode?).", "bad");
      }
      S.ai.keyWhere = where;
      const m = { ...(member || { id: uid(), hiredAt: today() }), kind: "hosted", provider: id, model, base: base || undefined, label: model || "", tested: today() };
      hire(m);
      drawCloud();
      showMsg(msg, member ? "Saved. Your shopper is ready." : `Hired! ${lead() === S.team.find(x => x.id === m.id) ? "This is your lead shopper." : "Make them lead on your team to have them do your lists."}`, "good",
        h.searches || id === "ollama-cloud" || keyOf(`search-${S.search.provider}`) || inAccount(`search-${S.search.provider}`) ? "" : "Next: hire a search helper below so they can look things up.");
    } catch (err) { showMsg(msg, err.message, "bad", err.hint); }
    finally { btn.disabled = false; }
  });
}

// ---------- local shoppers ----------

function drawLocal() {
  $("#local-list").innerHTML = Object.entries(LOCAL_RUNTIMES).map(([id, r]) => {
    const hired = S.team.filter(m => m.kind === "local" && m.provider === id).length;
    return `<article class="cv">
      ${hired ? `<span class="stamp">HIRED</span>` : ""}
      <h3>${esc(r.title)}</h3>
      <p class="tag">${esc(r.tagline)}</p>
      <div class="badges"><span class="badge good">Free</span><span class="badge">Private</span><span class="badge warn">Needs a search helper</span></div>
      <p class="cost">Talks to ${esc(r.base)}</p>
      <div class="acts"><button type="button" data-local="${esc(id)}">Set up and hire</button>${r.get ? `<a class="btn plain" href="${esc(r.get)}" target="_blank" rel="noopener">Download</a>` : ""}</div>
    </article>`;
  }).join("");
  $("#local-notes").innerHTML = `<ul>${LOCAL_NOTES.map(n => `<li>${esc(n)}</li>`).join("")}</ul>`;
}
$("#local-list").addEventListener("click", e => { const b = e.target.closest("[data-local]"); if (b) openLocal(b.dataset.local); });

const myOs = () => /Mac/i.test(navigator.platform || navigator.userAgent) ? "mac" : /Linux/i.test(navigator.platform || "") && !/Android/i.test(navigator.userAgent) ? "linux" : "windows";

function openLocal(rid, member) {
  const r = LOCAL_RUNTIMES[rid];
  if (!r) return;
  const runtime = { id: rid, ...r };
  const oses = r.steps.all ? null : Object.keys(r.steps);
  let os = oses ? (oses.includes(myOs()) ? myOs() : oses[0]) : "all";
  const stepsHtml = () => `<ol class="steps">${r.steps[os].map(s => `<li>${Array.isArray(s) ? `${esc(s[0])}<pre>${esc(s[1])}</pre>` : esc(s)}</li>`).join("")}</ol>`;
  const wanted = member?.model || "";
  const bd = openDialog(member ? `Set up ${member.label || member.model || r.title}` : `Hire ${r.title}`, `
    <p class="small" style="margin:0">${esc(r.why)}</p>
    ${oses ? `<div class="tabs" role="tablist">${oses.map(o => `<button type="button" role="tab" data-os="${o}" aria-selected="${o === os}">${{ windows: "Windows", mac: "Mac", linux: "Linux" }[o]}</button>`).join("")}</div>` : ""}
    <div id="l-steps">${stepsHtml()}</div>
    ${member?.install ? `<div><b style="font-size:14px">Get this model</b><pre>${esc(member.install)}</pre></div>` : ""}
    <label class="f"><span>Address</span><input id="l-base" value="${esc(member?.base || r.base)}" inputmode="url"><small>Leave as is unless you changed the port.</small></label>
    <label class="f"><span>Model</span><input id="l-model" list="l-models" value="${esc(wanted)}" placeholder="Test the connection to list your models"><datalist id="l-models"></datalist></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="plain" id="l-test">Test the connection</button><button type="button" id="l-go">${member ? "Save" : "Hire"}</button></div>
    <p class="msg" id="l-msg" role="status"></p>`);
  const msg = bd.querySelector("#l-msg");
  bd.querySelector(".tabs")?.addEventListener("click", e => {
    const b = e.target.closest("[data-os]"); if (!b) return;
    os = b.dataset.os;
    bd.querySelectorAll("[data-os]").forEach(x => x.setAttribute("aria-selected", x === b));
    bd.querySelector("#l-steps").innerHTML = stepsHtml();
  });
  let passed = !!member?.tested;
  async function test() {
    const base = bd.querySelector("#l-base").value.trim();
    const model = bd.querySelector("#l-model").value.trim();
    showMsg(msg, "Connecting…");
    try {
      const t = await local.testConnection(runtime, base, model);
      bd.querySelector("#l-models").innerHTML = t.models.map(m => `<option value="${esc(m.id)}">`).join("");
      if (!model && t.models[0]) bd.querySelector("#l-model").value = t.models[0].id;
      if (!t.models.length) { passed = false; return showMsg(msg, "Connected, but no models are downloaded yet.", "bad", rid === "ollama-local" ? `Run: ollama pull ${wanted || "qwen3.5:9b"}` : "Download a model first."); }
      passed = t.ok;
      if (!t.ok) return showMsg(msg, t.error, "bad", t.hint);
      showMsg(msg, `Connected. ${t.models.length} model${t.models.length === 1 ? "" : "s"} found.`, "good");
    } catch (err) { passed = false; showMsg(msg, err.message, "bad", err.hint); }
  }
  bd.querySelector("#l-test").addEventListener("click", async ev => { const btn = ev.currentTarget; btn.disabled = true; await test(); btn.disabled = false; });
  bd.querySelector("#l-go").addEventListener("click", async ev => {
    const btn = ev.currentTarget;
    const base = bd.querySelector("#l-base").value.trim();
    const model = bd.querySelector("#l-model").value.trim();
    if (!model) return showMsg(msg, "Pick a model first (test the connection to list them).", "bad");
    btn.disabled = true;
    await test();
    btn.disabled = false;
    const m = { ...(member || { id: uid(), hiredAt: today() }), kind: "local", provider: rid, model, base: base === r.base ? undefined : base, label: member?.label && member.model === model ? member.label : model, tested: passed ? today() : undefined };
    hire(m);
    drawLocal();
    if (passed) showMsg(msg, member ? "Saved. Your local shopper is ready." : "Hired and ready.", "good", keyOf(`search-${S.search.provider}`) || inAccount(`search-${S.search.provider}`) ? "" : "Next: hire a search helper below so they can look things up.");
    else msg.insertAdjacentHTML("beforeend", `<span class="hint">Saved anyway. Finish the steps above, then press Set up on your team to test again.</span>`);
  });
}

// ---------- suggest a local shopper ----------

function initSuggest() {
  $("#gpu-list").innerHTML = GPUS.map(g => `<option value="${esc(g.name)}">`).join("");
  const vram = $("#vram");
  vram.innerHTML += [4, 6, 8, 10, 11, 12, 16, 20, 24, 32, 48, 96].map(n => `<option value="${n}">${n} GB</option>`).join("");
  const ram = $("#ram");
  const fillRam = mac => {
    ram.innerHTML = (mac ? [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512] : [8, 16, 24, 32, 48, 64, 96, 128])
      .map(n => `<option value="${n}" ${n === (mac ? 16 : 32) ? "selected" : ""}>${n} GB</option>`).join("");
    $("#ram-l").textContent = mac ? "Memory (unified)" : "System memory";
  };
  fillRam(false);
  $("#os").value = myOs() === "linux" ? "linux" : "windows";
  if (myOs() === "mac") { document.querySelector('input[name="kind"][value="mac"]').checked = true; }
  const sync = () => {
    const mac = document.querySelector('input[name="kind"]:checked').value === "mac";
    $("#gpu-f").classList.toggle("hidden", mac); $("#vram-f").classList.toggle("hidden", mac); $("#os-f").classList.toggle("hidden", mac);
    fillRam(mac);
  };
  document.querySelectorAll('input[name="kind"]').forEach(x => x.addEventListener("change", sync));
  sync();
  $("#suggest-form").addEventListener("submit", e => {
    e.preventDefault();
    const mac = document.querySelector('input[name="kind"]:checked').value === "mac";
    const input = mac ? { mac: true, ram: +ram.value } : { gpu: $("#gpu").value.trim() || undefined, vram: +vram.value || undefined, ram: +ram.value, os: $("#os").value };
    if (!mac && !input.gpu && !input.vram) return showMsg($("#suggest-msg"), "Type your graphics card, or pick its memory.", "bad");
    const res = suggest(input);
    if (!mac && input.gpu && !input.vram && res.usable_gb === 0) {
      return showMsg($("#suggest-msg"), `We don't know "${input.gpu}". Pick its graphics memory instead (Windows: Task Manager, Performance, GPU, "Dedicated GPU memory").`, "bad");
    }
    showMsg($("#suggest-msg"), "");
    hireSuggested(res);
    drawSuggest(res);
  });
}

function hireSuggested(res) {
  if (!res.hired.length) return;
  const rt = res.runtime.runtime;
  const wasLead = lead();
  S.team = S.team.filter(m => m.from !== "suggest");
  if (wasLead && !S.team.includes(wasLead)) S.ai.lead = "";
  res.hired.forEach((h, i) => {
    const m = { id: uid(), kind: "local", provider: rt, from: "suggest", role: h.role, label: h.name, model: rt === "ollama-local" ? h.tag : "",
      install: h.install, hiredAt: today() };
    S.team.push(m);
    if (i === 0 && !lead()) makeLeadOf(m);
  });
  saveS(); drawTeam(); drawLocal(); drawTry();
}

function drawSuggest(res) {
  const rt = LOCAL_RUNTIMES[res.runtime.runtime];
  const out = $("#suggest-out");
  out.innerHTML = `<p class="machine"><b>${esc(res.machine)}</b>: about ${res.usable_gb} GB the models can use${res.vendor !== "apple" ? `, ${res.system_ram_gb} GB system memory` : ""}. Runs on <b>${esc(rt.title.replace(" on this computer", ""))}</b>. <span class="small">${esc(res.runtime.why)}</span></p>
    ${res.message ? `<p class="msg ${res.hired.length ? "" : "bad"}">${esc(res.message)}</p>` : ""}
    <div class="grid">${res.hired.map(h => `<article class="cv">
      <span class="stamp">HIRED</span>
      <span class="badge ${h.role === "Lead shopper" ? "lead" : ""}" style="align-self:flex-start">${esc(h.role)}</span>
      <h3>${esc(h.name)}</h3>
      <p class="tag">${esc(h.job)}</p>
      <ul><li>${esc(h.note)}</li><li>${esc(h.fit)}</li><li>Download ${h.size_gb} GB · made by ${esc(h.maker)}</li></ul>
      <pre>${esc(h.install)}</pre>
      <p class="cost">Shopping score ${h.score}/100</p>
      <div class="acts"><button type="button" data-setup="${esc(h.tag)}">Set up</button></div>
    </article>`).join("")}</div>
    ${res.hired.length ? `<p class="small">They're on your team now. Set them up once (install, allow this site, download the model), then test the connection.</p>` : ""}`;
}
$("#suggest-out").addEventListener("click", e => {
  const b = e.target.closest("[data-setup]"); if (!b) return;
  const m = S.team.find(x => x.from === "suggest" && x.install && (x.model === b.dataset.setup || x.install.includes(b.dataset.setup)));
  if (m) openLocal(m.provider, m);
});

// ---------- search helpers ----------

function drawHelpers() {
  $("#helper-list").innerHTML = helpers.map(h => {
    const id = `search-${h.id}`;
    const k = keyOf(id);
    const has = k || inAccount(id);
    const using = S.search.provider === h.id;
    return `<article class="cv" data-helper="${esc(h.id)}">
      ${has && using ? `<span class="stamp">HIRED</span>` : ""}
      <h3>${esc(h.name)}</h3>
      <div class="badges">${h.recommended ? `<span class="badge good">Recommended</span>` : ""}${using ? `<span class="badge lead">In use</span>` : ""}${has ? `<span class="badge good">${k ? `Key saved (…${esc(k.slice(-4))})` : "Key in your account"}</span>` : ""}</div>
      <p class="tag">${esc(h.free || "")}</p><p class="cost">${esc(h.cost || "")}</p>
      <ol class="steps">${(h.steps || []).map(s => `<li>${esc(s)}</li>`).join("")}</ol>
      <label class="f"><span>Key</span><input type="password" autocomplete="off" spellcheck="false" placeholder="${has ? "Saved" : "Paste the key"}"></label>
      <div class="acts"><button type="button" data-act="save">${has ? "Test" : "Test and hire"}</button>${has && !using ? `<button type="button" class="plain" data-act="use">Use this one</button>` : ""}
        ${h.key_url ? `<a class="btn plain" href="${esc(h.key_url)}" target="_blank" rel="noopener">Get a key</a>` : ""}</div>
      <p class="msg" role="status"></p>
    </article>`;
  }).join("");
}
$("#helper-list").addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest("[data-helper]"), hid = card.dataset.helper, id = `search-${hid}`;
  const msg = card.querySelector(".msg");
  if (b.dataset.act === "use") { S.search.provider = hid; saveS(); drawHelpers(); drawTeam(); return; }
  const typed = card.querySelector("input").value.trim();
  if (!typed && !keyOf(id) && !inAccount(id)) return showMsg(msg, "Paste the key first.", "bad");
  b.disabled = true; showMsg(msg, "Checking…");
  try {
    if (typed && me && S.ai.keyWhere === "account") {
      await api(`/api/me/agents/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: typed, check: true }) });
      await refreshMe();
    } else {
      const hd = { "X-Search-Provider": hid };
      if (typed || keyOf(id)) hd["X-Search-Key"] = typed || keyOf(id);
      const r = await api("/api/search/key-check", { headers: hd });
      if (!r.key_works) { b.disabled = false; return showMsg(msg, r.error || "That key didn't work.", "bad"); }
      if (typed) setKey(id, typed);
    }
    S.search.provider = hid; saveS();
    drawHelpers(); drawTeam();
    showMsg(card.querySelector(".msg"), "Works. Your shoppers will search with it.", "good");
  } catch (err) { showMsg(msg, err.message, "bad", err.hint); b.disabled = false; }
});

// ---------- try it ----------

function drawTry() {
  const L = lead();
  $("#try-who").textContent = L ? `Your lead shopper, ${L.label || L.model || memberName(L)} (${memberName(L)}), will research this and check every link.` : "Hire a shopper first.";
  $("#try-btn").disabled = !L;
  $("#try-save-f").classList.toggle("hidden", !me);
}

$("#try-form").addEventListener("submit", async e => {
  e.preventDefault();
  const request = $("#try-req").value.trim();
  const msg = $("#try-msg"), prog = $("#try-progress"), out = $("#try-out");
  if (!request) return showMsg(msg, "Tell your shopper what to look for.", "bad");
  if (!window.WM?.ai) return showMsg(msg, "The page didn't finish loading. Reload and try again.", "bad");
  const btn = $("#try-btn"); btn.disabled = true; out.innerHTML = ""; prog.innerHTML = ""; showMsg(msg, "");
  const steps = [];
  const onStep = s => { steps.push(s); prog.innerHTML = steps.map((x, i) => `<li class="${i === steps.length - 1 ? "now" : ""}">${esc(x)}</li>`).join(""); };
  onStep(lead().kind === "local" ? "Starting your local shopper" : "Your shopper is researching (this can take a minute or two)");
  try {
    const r = await window.WM.ai("agent/find-products", { request, count: +$("#try-count").value, save: !!(me && $("#try-save").checked) }, { onStep });
    prog.innerHTML = steps.map(x => `<li>${esc(x)}</li>`).join("");
    const L = r.list;
    showMsg(msg, `${L.title}. ${L.summary}${r.saved ? " Saved to your lists." : ""}`, "good", [r.warnings?.join(" "), r.removed?.length ? `${r.removed.length} pick${r.removed.length === 1 ? "" : "s"} left out because the link didn't work.` : ""].filter(Boolean).join(" "));
    out.innerHTML = L.items.map(it => { const p = it.picks[0]; return `<div class="item"><span class="rk">${it.rank}</span>
      <span><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${esc(p.brand && !p.name.startsWith(p.brand) ? `${p.brand} ${p.name}` : p.name)}</a> <span class="small">· ${esc(p.store)} · ${esc(it.type)}</span><br><span class="small">${esc(p.why)}</span></span>
      <span class="pr">${esc(p.priceText || "")}</span></div>`; }).join("");
  } catch (err) {
    prog.innerHTML = steps.map(x => `<li>${esc(x)}</li>`).join("");
    showMsg(msg, err.message || "Something went wrong.", "bad", err.hint);
  } finally { btn.disabled = false; }
});

// ---------- start ----------

async function refreshMe() {
  try {
    const r = await fetch("/api/me", { headers: { Accept: "application/json" } });
    if (!r.ok) { me = null; return; }
    const j = await r.json();
    me = { ...(j.user || j), agents: j.agents || [] };
  } catch (_) { me = null; }
}

function applyTheme() {
  const d = S.display || {};
  const dark = d.theme === "dark" || ((d.theme || "system") === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  if (d.text) document.documentElement.setAttribute("data-text", d.text);
}

async function start() {
  applyTheme();
  $("#foot").textContent = `Shopper facts, prices and model picks researched ${RESEARCHED} from each company's own docs. Prices are per million tokens (input / output) and can change.`;
  initSuggest();
  drawLocal();
  await Promise.all([loadCatalog(), refreshMe()]);
  $("#who").innerHTML = me ? `Signed in as ${esc(me.name || me.email)} · <a href="/account">Account</a>` : `<a href="/account">Sign in</a> to keep keys in your account`;
  adoptOldSetup();
  drawTeam(); drawCloud(); drawHelpers(); drawTry();
}
start();
