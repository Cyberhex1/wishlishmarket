/* WishlistMarket Settings panel.
 *
 * Load after the page script:  <script src="settings.js" defer></script>
 * Adds a "Settings" button to the header, makes the "Deliver to" location open
 * it, and exposes window.WM for the rest of the page:
 *   WM.settings()                 current settings (never includes the key)
 *   WM.ai(route, body, {onStep}?) runs a job with the lead shopper (see /hire):
 *                                 a cloud shopper through /api/<route> with its
 *                                 key, or a local one in this browser
 *                                 (shoppers/local.js), with the model, location,
 *                                 shopping defaults and search helper filled in
 *   WM.open(section?)             opens the panel ("ai", "location", ...)
 * Settings live in this browser (localStorage). Keys are kept apart from
 * them ("wm.key.<provider>", "wm.key.search-<id>"), and when the user is
 * signed in they can be saved encrypted in their account instead
 * (PUT /api/me/agents/:provider).
 */
(() => {
  "use strict";
  const SKEY = "wm.settings", OLD_KEY = "wm.aiKey";
  const STORES = [
    ["amazon", "Amazon"], ["walmart", "Walmart"], ["target", "Target"], ["bestbuy", "Best Buy"],
    ["lowes", "Lowe's"], ["homedepot", "Home Depot"], ["costco", "Costco"], ["ebay", "eBay"],
    ["offerup", "OfferUp"], ["wayfair", "Wayfair"], ["newegg", "Newegg"], ["chewy", "Chewy"],
  ];
  const DEFAULTS = {
    v: 1,
    ai: { provider: "gemini", model: "", thinking: "", keyWhere: "browser", keepChats: false, lead: "" },
    team: [],                       // hired shoppers, managed on /hire
    search: { provider: "tavily" }, // search helper for shoppers without their own search
    location: { name: "", zip: "", city: "", state: "", radius: 25, local: true },
    shop: { stores: ["amazon", "walmart"], count: 10, condition: "any", budget: "", avoid: "", ship: "any" },
    display: { theme: "system", text: "normal", openOn: "shop", photos: true },
  };

  // ---------- storage ----------
  const clone = o => JSON.parse(JSON.stringify(o));
  const merge = (base, over) => {
    const out = clone(base);
    for (const k of Object.keys(over || {})) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && out[k] && typeof out[k] === "object") out[k] = merge(out[k], over[k]);
      else if (k in out) out[k] = over[k];
    }
    return out;
  };
  const read = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch (_) { return false; } };
  let S = (() => { try { return merge(DEFAULTS, JSON.parse(read(SKEY) || "{}")); } catch (_) { return clone(DEFAULTS); } })();
  let me = null;            // signed-in user from /api/me, if accounts are on
  let providers = [{ id: "gemini", name: "Google Gemini (AI Studio)", key_url: "https://aistudio.google.com/apikey",
    default_model: "gemini-3.8-flash", cheap_model: "gemini-3.5-flash-lite" }];
  let models = [];

  function save() {
    write(SKEY, JSON.stringify(S));
    applyDisplay();
    paintHeader();
    if (me) fetch("/api/me/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(S) }).catch(() => {});
    window.dispatchEvent(new CustomEvent("wm:settings", { detail: clone(S) }));
  }
  // One key per provider. The Gemini key used to live under "wm.aiKey".
  const keyOf = id => read(`wm.key.${id}`) || (id === "gemini" ? read(OLD_KEY) : "") || "";
  const setKey = (id, v) => { const ok = write(`wm.key.${id}`, v || null); if (id === "gemini") write(OLD_KEY, v || null); return ok; };
  const key = () => keyOf(S.ai.provider);
  const prov = () => providers.find(p => p.id === S.ai.provider) || providers[0];
  const lead = () => S.team.find(m => m.id === S.ai.lead) || null;
  const uid = () => `m-${Math.random().toString(36).slice(2, 9)}`;
  // Picking a provider here makes (or reuses) a cloud shopper for it as lead.
  function leadProvider(id, model) {
    let m = S.team.find(x => x.kind === "hosted" && x.provider === id && !x.base);
    if (!m) { m = { id: uid(), kind: "hosted", provider: id, model: model || "", hiredAt: new Date().toISOString().slice(0, 10) }; S.team.push(m); }
    if (model !== undefined) m.model = model;
    S.ai.lead = m.id; S.ai.provider = id; S.ai.model = m.model || "";
  }

  // ---------- talking to the backend ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error(j.error || `Error ${r.status}`); e.hint = j.hint; e.status = r.status; throw e; }
    return j;
  }
  function searchCreds() {
    const id = S.search.provider || "tavily";
    return { provider: id, key: keyOf(`search-${id}`) || undefined };
  }
  function aiHeaders() {
    const m = lead();
    const id = m?.kind === "hosted" ? m.provider : S.ai.provider;
    const h = { "Content-Type": "application/json", "X-AI-Provider": id };
    const k = keyOf(id) || (id === S.ai.provider ? memKey : "");
    if (k) h["X-AI-Key"] = k;
    if (m?.kind === "hosted" && m.base) h["X-AI-Base-URL"] = m.base;
    const p = providers.find(x => x.id === id);
    if (p && p.searches === false) {
      const s = searchCreds();
      h["X-Search-Provider"] = s.provider;
      if (s.key) h["X-Search-Key"] = s.key;
    }
    return h;
  }
  function placeText() {
    const L = S.location;
    return [L.city, L.state, L.zip].filter(Boolean).join(L.city && L.state ? ", " : " ").replace(/, (\d{5})$/, " $1");
  }
  // Fills in what the agent needs from settings; the caller's body wins.
  function withDefaults(route, body) {
    const b = { ...body };
    const m = lead();
    const model = m ? m.model : S.ai.model;
    if (model && !b.model && m?.kind !== "local") b.model = model;
    if (S.ai.thinking && !b.thinking) b.thinking = S.ai.thinking;
    if (route === "ask") { if (b.store === undefined) b.store = S.ai.keepChats; return b; }
    if (route.startsWith("agent/")) {
      if (!b.location && placeText()) {
        b.location = `${placeText()}${S.location.local ? `, local stores within ${S.location.radius} miles are fine` : ", online stores only"}`;
      }
      if (!b.stores && S.shop.stores.length) b.stores = S.shop.stores;
      if (!b.count) b.count = S.shop.count;
      if (!b.condition && S.shop.condition !== "any") b.condition = S.shop.condition;
      if (!b.budget && S.shop.budget) b.budget = S.shop.budget;
      const extra = [S.shop.ship === "fast" ? "Prefer items that arrive within 2 days." : "", S.shop.avoid ? `Avoid: ${S.shop.avoid}` : ""].filter(Boolean).join(" ");
      if (extra) b.notes = [b.notes, extra].filter(Boolean).join(" ");
    }
    return b;
  }
  async function ai(route, body = {}, opts = {}) {
    const m = lead();
    if (m?.kind === "local") {
      if (!route.startsWith("agent/")) throw Object.assign(new Error("Local shoppers only do shopping lists here"), { hint: "Pick a cloud shopper as lead for other questions." });
      const [local, catalog] = await Promise.all([import("/shoppers/local.js"), import("/shoppers/catalog.js")]);
      const rt = catalog.LOCAL_RUNTIMES[m.provider];
      if (!rt) throw new Error("Unknown local shopper");
      return local.run({ runtime: { id: m.provider, ...rt }, base: m.base, model: m.model }, route, withDefaults(route, body), { search: searchCreds(), onStep: opts.onStep });
    }
    return api(`/api/${route}`, { method: "POST", headers: aiHeaders(), body: JSON.stringify(withDefaults(route, body)) });
  }

  // ---------- look and feel ----------
  const css = `
  :root[data-theme="dark"]{--bg:#0f1418;--card:#1a2128;--ink:#e8eaed;--muted:#a7b0b8;--line:#2e3740;--chip:#232c34;
    --link:#5cc8d9;--price:#e8eaed;--good:#4cc29e;--bad:#ff7a66;--warn:#ffab5c;--hero1:#1c2b33;--hero2:#0f1418;--btnInk:#0f1111}
  :root[data-text="large"]{font-size:112.5%}
  :root[data-text="large"] body{font-size:17px}
  :root[data-photos="off"] .pic img{visibility:hidden}
  .wm-tools{display:flex;align-items:center;gap:2px}
  .wm-gear{text-decoration:none;border:1px solid transparent;background:none;color:var(--headInk);display:flex;align-items:center;gap:6px;
    font:inherit;font-size:14px;font-weight:700;padding:6px 8px;border-radius:3px;cursor:pointer;white-space:nowrap}
  .wm-gear:hover,.wm-gear:focus-visible{border-color:var(--headInk);outline:none}
  .wm-gear svg{flex:none}
  .top .wrap.wm-has-gear{grid-template-columns:auto auto minmax(0,1fr) auto auto auto}
  @media (max-width:900px){.top .wrap.wm-has-gear{grid-template-columns:auto minmax(0,1fr) auto auto}}
  @media (max-width:430px){.top .wrap.wm-has-gear{column-gap:6px}.wm-has-gear .logo .word{font-size:18px}.wm-has-gear .modes button{padding:6px 8px}}
  .loc.wm-loc{cursor:pointer;border:1px solid transparent;border-radius:3px;padding:4px 6px}
  .loc.wm-loc:hover,.loc.wm-loc:focus-visible{border-color:var(--headInk);outline:none}
  dialog.wm-set{border:0;padding:0;border-radius:12px;width:min(720px,calc(100vw - 32px));max-height:calc(100dvh - 48px);
    background:var(--card);color:var(--ink);box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:var(--font,inherit)}
  dialog.wm-set::backdrop{background:rgba(15,17,17,.55)}
  .wm-set form{display:flex;flex-direction:column;max-height:calc(100dvh - 48px)}
  .wm-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line)}
  .wm-hd h2{margin:0;font-size:20px}
  .wm-x{background:none;border:0;color:var(--ink);font-size:26px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}
  .wm-body{display:grid;grid-template-columns:170px minmax(0,1fr);min-height:0;flex:1}
  .wm-tabs{display:flex;flex-direction:column;gap:2px;padding:10px;border-right:1px solid var(--line);overflow:auto}
  .wm-tabs button{text-align:left;background:none;border:0;color:var(--ink);font:inherit;font-size:14px;padding:9px 10px;border-radius:6px;cursor:pointer}
  .wm-tabs button[aria-selected="true"]{background:var(--chip);font-weight:700;box-shadow:inset 3px 0 0 var(--accent,#febd69)}
  .wm-pane{padding:16px 20px 20px;overflow:auto}
  .wm-pane h3{margin:0 0 4px;font-size:17px}
  .wm-pane .wm-lead{margin:0 0 14px;color:var(--muted);font-size:13px;line-height:1.45}
  .wm-f{display:flex;flex-direction:column;gap:5px;margin:0 0 14px}
  .wm-f>span{font-size:13px;font-weight:700}
  .wm-f small{color:var(--muted);font-size:12px;line-height:1.4}
  .wm-f input[type=text],.wm-f input[type=password],.wm-f input[type=number],.wm-f select{font:inherit;font-size:15px;padding:8px 10px;
    border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);width:100%;box-sizing:border-box;min-height:40px}
  .wm-f input:focus,.wm-f select:focus{outline:2px solid var(--link);outline-offset:1px}
  .wm-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0 12px}
  .wm-keyrow{display:flex;gap:6px}.wm-keyrow input{flex:1;min-width:0}
  .wm-chk{display:flex;gap:8px;align-items:flex-start;font-size:14px;margin:0 0 10px;cursor:pointer}
  .wm-chk input{margin-top:3px;width:16px;height:16px;flex:none}
  .wm-stores{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:4px 10px;margin:4px 0 14px}
  .wm-seg{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 0}
  .wm-seg label{border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px;cursor:pointer;display:flex;gap:6px;align-items:center}
  .wm-seg input{position:absolute;opacity:0;pointer-events:none}
  .wm-seg label:has(input:checked){border-color:var(--ink);background:var(--chip);font-weight:700}
  .wm-seg label:has(input:focus-visible){outline:2px solid var(--link)}
  .wm-btn{font:inherit;font-size:14px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;white-space:nowrap;min-height:38px}
  .wm-btn.pri{background:var(--btn,#ffd814);border-color:var(--btnLine,#fcd200);color:var(--btnInk,#0f1111);font-weight:700}
  .wm-btn.bad{color:var(--bad)}
  .wm-btn:disabled{opacity:.55;cursor:default}
  .wm-acts{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 14px}
  .wm-msg{font-size:13px;margin:-6px 0 14px;min-height:18px;line-height:1.4}
  .wm-msg.ok{color:var(--good)}.wm-msg.err{color:var(--bad)}
  .wm-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--line)}
  .wm-note{background:var(--chip);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.45;margin:0 0 14px}
  @media (max-width:640px){
    dialog.wm-set{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0;margin:0}
    .wm-set form{max-height:100dvh;height:100dvh}
    .wm-body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
    .wm-tabs{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 12px}
    .wm-tabs button{white-space:nowrap;padding:8px 10px}
    .wm-tabs button[aria-selected="true"]{box-shadow:inset 0 -3px 0 var(--accent,#febd69)}
    .wm-pane{padding:14px 16px 20px}
    .wm-gear .wm-gl{display:none}
    .wm-gear{padding:4px}
  }`;

  function applyDisplay() {
    const root = document.documentElement;
    const dark = S.display.theme === "dark" || (S.display.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.setAttribute("data-text", S.display.text);
    root.setAttribute("data-photos", S.display.photos ? "on" : "off");
  }

  // ---------- header hooks (the page re-renders its header often) ----------
  const gearSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  const shopperSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9"/></svg>';
  let painting = false;
  function paintHeader() {
    const head = document.getElementById("head");
    if (!head || painting) return;
    painting = true;
    try {
      if (!head.querySelector(".wm-gear")) {
        const box = document.createElement("div");
        box.className = "wm-tools";
        const a = document.createElement("a");
        a.className = "wm-gear"; a.href = "/hire"; a.setAttribute("aria-label", "AI shoppers");
        a.innerHTML = `${shopperSvg}<span class="wm-gl">Shoppers</span>`;
        const b = document.createElement("button");
        b.type = "button"; b.className = "wm-gear"; b.setAttribute("aria-label", "Settings");
        b.innerHTML = `${gearSvg}<span class="wm-gl">Settings</span>`;
        b.addEventListener("click", () => open());
        box.append(a, b);
        head.appendChild(box);
        head.classList.add("wm-has-gear");
      }
      const loc = head.querySelector(".loc");
      if (loc) {
        const services = !!document.querySelector('[data-mode="services"][aria-pressed="true"]');
        const sm = loc.querySelector("small"), b = loc.querySelector("b");
        const top = services ? "Services near" : `Deliver to ${S.location.name || "you"}`;
        const place = [S.location.city, S.location.zip].filter(Boolean).join(" ") || "Set location";
        if (sm && sm.textContent !== top) sm.textContent = top;
        if (b && b.textContent !== place) b.textContent = place;
        if (!loc.classList.contains("wm-loc")) {
          loc.classList.add("wm-loc"); loc.tabIndex = 0; loc.setAttribute("role", "button");
          loc.setAttribute("aria-label", `Location: ${place}. Change in Settings`);
        }
        if (!loc.dataset.wmBound) {
          loc.dataset.wmBound = "1";
          loc.addEventListener("click", () => open("location"));
          loc.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open("location"); } });
        }
      }
      const acct = head.querySelector(".acct small");
      if (acct && S.location.name && acct.textContent.startsWith("Hello")) {
        const t = `Hello, ${S.location.name}`;
        if (acct.textContent !== t) acct.textContent = t;
      }
    } finally { painting = false; }
  }

  // ---------- the panel ----------
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(t)}</option>`;
  const seg = (name, items, cur) => `<div class="wm-seg" role="radiogroup">${items.map(([v, t]) =>
    `<label><input type="radio" name="${name}" value="${esc(v)}" ${String(v) === String(cur) ? "checked" : ""}>${esc(t)}</label>`).join("")}</div>`;
  const TABS = [["ai", "AI agent"], ["location", "Location"], ["shop", "Shopping"], ["display", "Display"], ["privacy", "Privacy & data"]];
  let dlg, tab = "ai";

  function panes() {
    const p = prov(), k = key(), L = lead();
    const modelOpts = [opt("", `Recommended (${p.default_model})`, S.ai.model), opt(p.cheap_model, `Cheapest and fastest (${p.cheap_model})`, S.ai.model)]
      .concat(models.filter(m => m.id !== p.default_model && m.id !== p.cheap_model && (p.id !== "gemini" || /gemini/.test(m.id))).map(m => opt(m.id, m.name ? `${m.name} (${m.id})` : m.id, S.ai.model)));
    if (S.ai.model && !modelOpts.join("").includes(`value="${esc(S.ai.model)}"`)) modelOpts.push(opt(S.ai.model, S.ai.model, S.ai.model));
    const aiCloud = `<label class="wm-f"><span>API key</span>
          <div class="wm-keyrow"><input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="${k ? "Saved in this browser (…" + esc(k.slice(-4)) + ")" : me?.agents?.some?.(a => a.provider === S.ai.provider) ? "Saved in your account" : "Paste your key"}">
          <button type="button" class="wm-btn" data-act="showkey" aria-label="Show key">Show</button></div>
          <small>Get a key at <a href="${esc(p.key_url)}" target="_blank" rel="noopener">${esc(String(p.key_url).replace(/^https:\/\//, ""))}</a>. Never share it in chat or email.</small></label>
        <div class="wm-f"><span>Keep my key</span>${seg("keyWhere", [["browser", "In this browser only"], ["account", me ? "In my account (encrypted)" : "In my account (sign in first)"]], S.ai.keyWhere)}
          <small>${me ? `Signed in as ${esc(me.email || me.name || "you")}.` : `<a href="/account">Sign in</a> or <a href="/account#signup">create an account</a> to keep your key in your account. Until then it stays only in this browser.`}</small></div>
        <div class="wm-acts"><button type="button" class="wm-btn pri" data-act="test">Save and test key</button><button type="button" class="wm-btn bad" data-act="forget">Remove key</button></div>
        <p class="wm-msg" id="wm-aimsg" role="status"></p>
        <label class="wm-f"><span>Model</span><select name="model">${modelOpts.join("")}</select>
          <small><button type="button" class="wm-btn" data-act="models" style="margin-top:4px">Load all models my key can use</button></small></label>
        <div class="wm-f"><span>How hard should it think?</span>${seg("thinking", [["", "Auto"], ["low", "Quick"], ["medium", "Balanced"], ["high", "Thorough"]], S.ai.thinking)}
          <small>Thorough is slower and uses more of your quota, but checks more options.</small></div>`;
    return {
      ai: `<h3>AI agent</h3><p class="wm-lead">Pick the AI that finds products and builds or updates your lists. You use your own key, so you control it and its cost. There is no shared key.</p>
        <div class="wm-note">${L && L.kind === "local" ? `Your lead shopper is <b>${esc(L.label || L.model)}</b>, running on this computer.` : `Your lead shopper is <b>${esc(p.name)}</b>.`}
          <a href="/hire">Hire more shoppers</a>: ChatGPT, Claude, Grok, DeepSeek, free local models for your graphics card, and more.</div>
        <label class="wm-f"><span>AI backend</span><select name="provider">${L && L.kind === "local" ? `<option value="" selected>Local shopper (set on the Shoppers page)</option>` : ""}${providers.filter(x => !x.needs_base_url).map(x => opt(x.id, x.name, L && L.kind === "local" ? "" : S.ai.provider)).join("")}</select></label>
${L && L.kind === "local" ? `<p class="wm-lead">Local shoppers don't need a key. Change their model or set them up again on the <a href="/hire#team">Shoppers page</a>, or choose a cloud AI above.</p>` : aiCloud}`,
      location: `<h3>Location</h3><p class="wm-lead">Used for local stores, services near you, shipping and delivery times.</p>
        <label class="wm-f"><span>Your name on the site</span><input type="text" name="name" value="${esc(S.location.name)}" maxlength="40" autocomplete="given-name"></label>
        <div class="wm-row">
          <label class="wm-f"><span>ZIP code</span><input type="text" name="zip" value="${esc(S.location.zip)}" inputmode="numeric" maxlength="5" pattern="\\d{5}" autocomplete="postal-code"></label>
          <label class="wm-f"><span>City</span><input type="text" name="city" value="${esc(S.location.city)}" maxlength="60" autocomplete="address-level2"></label>
          <label class="wm-f"><span>State</span><input type="text" name="state" value="${esc(S.location.state)}" maxlength="2" autocomplete="address-level1" style="text-transform:uppercase"></label>
        </div>
        <div class="wm-acts"><button type="button" class="wm-btn" data-act="geo">Use my current location</button><button type="button" class="wm-btn" data-act="zip">Look up city from ZIP</button></div>
        <p class="wm-msg" id="wm-locmsg" role="status"></p>
        <label class="wm-f"><span>How far will you travel?</span><select name="radius">${[5, 10, 25, 50, 100].map(n => opt(n, `${n} miles`, S.location.radius)).join("")}</select></label>
        <label class="wm-chk"><input type="checkbox" name="local" ${S.location.local ? "checked" : ""}> Include local stores and pickup near me</label>`,
      shop: `<h3>Shopping</h3><p class="wm-lead">Defaults the AI uses for new lists and list updates. You can still change them on any single request.</p>
        <div class="wm-f"><span>Favorite stores</span><small>The AI shops these first.</small></div>
        <div class="wm-stores">${STORES.map(([id, n]) => `<label class="wm-chk"><input type="checkbox" name="stores" value="${id}" ${S.shop.stores.includes(id) ? "checked" : ""}> ${esc(n)}</label>`).join("")}</div>
        <div class="wm-row">
          <label class="wm-f"><span>Items per list</span><select name="count">${[5, 10, 15, 20].map(n => opt(n, `${n} items`, S.shop.count)).join("")}</select></label>
          <label class="wm-f"><span>Condition</span><select name="condition">${[["any", "Any condition"], ["new", "New only"], ["renewed", "Renewed or refurbished OK"], ["used", "Used OK"]].map(([v, t]) => opt(v, t, S.shop.condition)).join("")}</select></label>
          <label class="wm-f"><span>Shipping</span><select name="ship">${[["any", "Any speed"], ["fast", "Fast (2 days or less)"]].map(([v, t]) => opt(v, t, S.shop.ship)).join("")}</select></label>
        </div>
        <label class="wm-f"><span>Usual budget</span><input type="text" name="budget" value="${esc(S.shop.budget)}" maxlength="60" placeholder="e.g. under $50, or leave blank"></label>
        <label class="wm-f"><span>Always avoid</span><input type="text" name="avoid" value="${esc(S.shop.avoid)}" maxlength="200" placeholder="e.g. third-party sellers, brands you dislike">
          <small>Every product link is checked before a list is saved, and dead listings are left out.</small></label>`,
      display: `<h3>Display</h3>
        <div class="wm-f"><span>Theme</span>${seg("theme", [["system", "Match my device"], ["light", "Light"], ["dark", "Dark"]], S.display.theme)}</div>
        <div class="wm-f"><span>Text size</span>${seg("text", [["normal", "Normal"], ["large", "Large"]], S.display.text)}</div>
        <div class="wm-f"><span>Open the site on</span>${seg("openOn", [["shop", "Shopping"], ["services", "Services"]], S.display.openOn)}</div>
        <label class="wm-chk"><input type="checkbox" name="photos" ${S.display.photos ? "checked" : ""}> Show product photos</label>`,
      privacy: `<h3>Privacy & data</h3>
        <div class="wm-note">Your AI key is never stored on the WishlistMarket server. It stays in this browser, or encrypted in your account if you choose that. Requests go from the site to your AI provider using your key.</div>
        <label class="wm-chk"><input type="checkbox" name="keepChats" ${S.ai.keepChats ? "checked" : ""}> <span>Let my AI provider keep my chats so I can ask follow-up questions<br><small style="color:var(--muted)">Off by default because searches can hold personal details.</small></span></label>
        <div class="wm-acts"><button type="button" class="wm-btn" data-act="export">Download my settings</button>
          <button type="button" class="wm-btn bad" data-act="reset">Reset all settings</button></div>
        <p class="wm-msg" id="wm-pmsg" role="status"></p>`,
    };
  }

  function build() {
    if (!document.getElementById("wm-set-css")) {
      const st = document.createElement("style"); st.id = "wm-set-css"; st.textContent = css; document.head.appendChild(st);
    }
    dlg = document.createElement("dialog");
    dlg.className = "wm-set"; dlg.setAttribute("aria-labelledby", "wm-set-h");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", e => { if (e.target === dlg) close(); });
    dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });
  }

  function draw() {
    const P = panes();
    dlg.innerHTML = `<form method="dialog" novalidate>
      <div class="wm-hd"><h2 id="wm-set-h">Settings</h2><button type="button" class="wm-x" data-act="close" aria-label="Close">×</button></div>
      <div class="wm-body">
        <div class="wm-tabs" role="tablist" aria-label="Settings sections">${TABS.map(([id, t]) => `<button type="button" role="tab" id="wm-t-${id}" aria-controls="wm-p" aria-selected="${id === tab}" tabindex="${id === tab ? 0 : -1}" data-tab="${id}">${t}</button>`).join("")}</div>
        <div class="wm-pane" id="wm-p" role="tabpanel" aria-labelledby="wm-t-${tab}">${P[tab]}</div>
      </div>
      <div class="wm-ft"><span class="wm-msg" id="wm-saved" role="status" style="margin:0 auto 0 0;align-self:center"></span><button type="button" class="wm-btn pri" data-act="close">Done</button></div>
    </form>`;
    const f = dlg.querySelector("form");
    f.addEventListener("change", onChange);
    f.addEventListener("input", e => { if (e.target.type === "text") onChange(e); });
    f.addEventListener("click", onClick);
    f.querySelector(".wm-tabs").addEventListener("keydown", e => {
      const i = TABS.findIndex(t => t[0] === tab);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); show(TABS[(i + 1) % TABS.length][0], true); }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); show(TABS[(i + TABS.length - 1) % TABS.length][0], true); }
    });
  }

  function show(id, focusTab) {
    tab = id; draw();
    if (focusTab) dlg.querySelector(`#wm-t-${id}`)?.focus();
  }
  const msg = (id, text, kind) => { const el = dlg.querySelector(`#${id}`); if (el) { el.textContent = text; el.className = `wm-msg ${kind || ""}`; } };
  let savedTimer;
  const flashSaved = () => { msg("wm-saved", "Saved", "ok"); clearTimeout(savedTimer); savedTimer = setTimeout(() => msg("wm-saved", ""), 1500); };

  function onChange(e) {
    const t = e.target, n = t.name, v = t.type === "checkbox" ? t.checked : t.value;
    if (!n || n === "key") return;
    if (n === "provider") { if (!v) return; leadProvider(v); models = []; save(); return show("ai"); }
    if (n === "model") { const L = lead(); if (L?.kind === "hosted") L.model = v; }
    if (["model", "thinking", "keyWhere", "keepChats"].includes(n)) S.ai[n] = v;
    else if (n === "zip") { if (/^\d{0,5}$/.test(v)) S.location.zip = v; if (/^\d{5}$/.test(v) && e.type === "change") lookupZip(); }
    else if (n === "state") S.location.state = v.toUpperCase().slice(0, 2);
    else if (["name", "city"].includes(n)) S.location[n] = v.trim() ? v : "";
    else if (n === "radius") S.location.radius = +v;
    else if (n === "local") S.location.local = v;
    else if (n === "stores") S.shop.stores = [...dlg.querySelectorAll('input[name="stores"]:checked')].map(x => x.value);
    else if (n === "count") S.shop.count = +v;
    else if (["condition", "budget", "avoid", "ship"].includes(n)) S.shop[n] = v;
    else if (["theme", "text", "openOn"].includes(n)) {
      S.display[n] = v;
      if (n === "openOn") write("mk.mode", v === "services" ? "services" : "shop");
    } else if (n === "photos") S.display.photos = v;
    if (n === "keyWhere" && v === "account" && !me) { S.ai.keyWhere = "browser"; save(); msg("wm-aimsg", "Sign in first to keep your key in your account.", "err"); return; }
    save(); flashSaved();
  }

  async function onClick(e) {
    const b = e.target.closest("[data-tab],[data-act]");
    if (!b) return;
    if (b.dataset.tab) return show(b.dataset.tab);
    const act = b.dataset.act;
    if (act === "close") return close();
    if (act === "showkey") { const i = dlg.querySelector('input[name="key"]'); const s = i.type === "password"; i.type = s ? "text" : "password"; b.textContent = s ? "Hide" : "Show"; return; }
    if (act === "test") return testKey(b);
    if (act === "forget") return forgetKey();
    if (act === "models") return loadModels(b);
    if (act === "geo") return useGeo(b);
    if (act === "zip") return lookupZip(b);
    if (act === "export") {
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "wishlistmarket-settings.json" });
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return msg("wm-pmsg", "Downloaded. Your AI key is not in the file.", "ok");
    }
    if (act === "reset") {
      if (!confirm("Reset all settings to the defaults? Your AI key stays unless you remove it on the AI agent tab.")) return;
      S = clone(DEFAULTS); save(); show("privacy"); return msg("wm-pmsg", "Settings reset.", "ok");
    }
  }

  async function testKey(btn) {
    const input = dlg.querySelector('input[name="key"]');
    const typed = input.value.trim();
    btn.disabled = true; msg("wm-aimsg", "Checking your key…");
    try {
      if (typed && S.ai.keyWhere === "account" && me) {
        await api(`/api/me/agents/${encodeURIComponent(S.ai.provider)}`, { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: typed, model: S.ai.model || null, check: true }) });
        setKey(S.ai.provider, null); input.value = "";
        if (lead()?.provider !== S.ai.provider) leadProvider(S.ai.provider);
        save();
        await refreshMe();
        msg("wm-aimsg", "Your key works and is saved in your account (encrypted).", "ok");
      } else {
        const k = typed || key();
        if (!k) { msg("wm-aimsg", "Paste your key first.", "err"); return; }
        const r = await api("/api/key-check", { headers: { "X-AI-Key": k, "X-AI-Provider": S.ai.provider } });
        if (!r.key_works) { msg("wm-aimsg", r.error || "That key didn't work.", "err"); return; }
        if (typed && !setKey(S.ai.provider, typed)) { msg("wm-aimsg", "Your key works, but this browser won't let the site save it (private mode?). It will be forgotten when you close the tab.", "err"); memKey = typed; }
        else msg("wm-aimsg", "Your key works and is saved in this browser.", "ok");
        if (lead()?.provider !== S.ai.provider) { leadProvider(S.ai.provider); save(); }
        input.value = "";
        input.placeholder = `Saved in this browser (…${k.slice(-4)})`;
      }
    } catch (err) {
      msg("wm-aimsg", err.hint || err.message || "Couldn't check the key.", "err");
    } finally { btn.disabled = false; }
  }
  let memKey = "";

  async function forgetKey() {
    setKey(S.ai.provider, null); memKey = "";
    if (me) { try { await api(`/api/me/agents/${encodeURIComponent(S.ai.provider)}`, { method: "DELETE" }); await refreshMe(); } catch (_) {} }
    show("ai"); msg("wm-aimsg", "Key removed.", "ok");
  }

  async function loadModels(btn) {
    btn.disabled = true; msg("wm-aimsg", "Loading models…");
    try {
      const r = await api("/api/models", { headers: aiHeaders() });
      models = (r.models || []).filter(m => !/embedding|tts|image|live|transcribe|lyria|robotics|research|antigravity|aqa/i.test(m.id));
      show("ai"); msg("wm-aimsg", `${models.length} models available to your key.`, "ok");
    } catch (err) { btn.disabled = false; msg("wm-aimsg", err.hint || err.message, "err"); }
  }

  async function lookupZip(btn) {
    const zip = S.location.zip;
    if (!/^\d{5}$/.test(zip)) return msg("wm-locmsg", "Enter a 5-digit ZIP code first.", "err");
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`https://api.zippopotam.us/us/${zip}`);
      if (!r.ok) throw new Error("ZIP not found");
      const p = (await r.json()).places?.[0];
      if (!p) throw new Error("ZIP not found");
      S.location.city = p["place name"]; S.location.state = p["state abbreviation"];
      save(); show("location"); msg("wm-locmsg", `Set to ${S.location.city}, ${S.location.state} ${zip}.`, "ok");
    } catch (e) { msg("wm-locmsg", "Couldn't look up that ZIP. You can type the city and state yourself.", "err"); }
    finally { if (btn) btn.disabled = false; }
  }

  function useGeo(btn) {
    if (!navigator.geolocation) return msg("wm-locmsg", "This browser can't share your location. Type your ZIP instead.", "err");
    btn.disabled = true; msg("wm-locmsg", "Asking your device for your location…");
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const { latitude: lat, longitude: lon } = pos.coords;
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, { headers: { Accept: "application/json" } });
        const a = (await r.json()).address || {};
        if (a.postcode) S.location.zip = String(a.postcode).slice(0, 5);
        S.location.city = a.city || a.town || a.village || a.hamlet || S.location.city;
        const iso = a["ISO3166-2-lvl4"] || "";
        if (/^US-/.test(iso)) S.location.state = iso.slice(3);
        save(); show("location"); msg("wm-locmsg", `Set to ${placeText()}. Only the city and ZIP are kept, not your exact spot.`, "ok");
      } catch (_) { msg("wm-locmsg", "Couldn't turn your location into a city. Type your ZIP instead.", "err"); btn.disabled = false; }
    }, err => {
      btn.disabled = false;
      msg("wm-locmsg", err.code === 1 ? "Location permission was turned down. Type your ZIP instead." : "Couldn't get your location. Type your ZIP instead.", "err");
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }

  let lastFocus = null;
  function open(section) {
    if (!dlg) build();
    if (section && TABS.some(t => t[0] === section)) tab = section;
    lastFocus = document.activeElement;
    draw();
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    dlg.querySelector(`#wm-t-${tab}`)?.focus();
  }
  function close() {
    if (!dlg) return;
    if (dlg.open) { if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open"); }
    lastFocus?.focus?.();
  }

  async function refreshMe() {
    try {
      const r = await fetch("/api/me", { headers: { Accept: "application/json" } });
      if (!r.ok) { me = null; return; }
      const j = await r.json();
      me = { ...(j.user || j), agents: j.agents || [] };
    } catch (_) { me = null; }
  }

  // The Shoppers page changes the team in localStorage; pick that up.
  window.addEventListener("wm:reload", () => { try { S = merge(DEFAULTS, JSON.parse(read(SKEY) || "{}")); } catch (_) {} });
  window.addEventListener("storage", e => { if (e.key === SKEY) window.dispatchEvent(new Event("wm:reload")); });

  async function init() {
    if (!document.getElementById("wm-set-css")) {
      const st = document.createElement("style"); st.id = "wm-set-css"; st.textContent = css; document.head.appendChild(st);
    }
    applyDisplay();
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyDisplay);
    if (!read("mk.mode") && S.display.openOn === "services") write("mk.mode", "services");
    const head = document.getElementById("head");
    if (head) new MutationObserver(() => paintHeader()).observe(head, { childList: true });
    paintHeader();
    try { const r = await fetch("/api/providers"); if (r.ok) { const j = await r.json(); if (j.providers?.length) providers = j.providers; } } catch (_) {}
    await refreshMe();
    if (me) {
      try {
        const r = await fetch("/api/me/settings");
        if (r.ok) { const j = await r.json(); S = merge(DEFAULTS, j.settings || j); write(SKEY, JSON.stringify(S)); applyDisplay(); paintHeader(); }
      } catch (_) {}
    }
  }

  window.WM = Object.freeze({
    settings: () => clone(S),
    ai,
    aiHeaders: () => { const h = aiHeaders(); if (!h["X-AI-Key"] && memKey) h["X-AI-Key"] = memKey; return h; },
    open, close,
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
