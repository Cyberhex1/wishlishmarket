/* WishlistMarket account menu: the "Hello, sign in / Account & Lists" button in
 * the header, with a drop-down menu of the user's lists and account pages.
 *
 * Load on any page:  <script src="/account-menu.js" defer></script>
 * and put  <div data-wm-acct></div>  where the button goes. A page that
 * re-renders its header just renders the placeholder again; it is filled in.
 * Exposes window.WMAccount:
 *   WMAccount.ready         promise of the signed-in user (/api/me) or null
 *   WMAccount.me            the same, once loaded
 *   WMAccount.refresh()     fetch /api/me again and repaint
 *   WMAccount.signOut(all?) sign out (all = every device) and reload
 *   WMAccount.signInUrl(newAccount?)  /signin link that comes back here
 * and fires a "wm:account" event on window with the user (or null) as detail.
 * A page can set window.WMNav = view => {...} to open "projects", "items", ...
 * in place instead of loading /?view=<view>.
 */
(() => {
  "use strict";
  if (window.WMAccount) return;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const here = () => location.pathname + location.search + location.hash;
  const signInUrl = fresh => `/signin?${fresh ? "new=1&" : ""}next=${encodeURIComponent(here())}`;
  const firstName = u => (u.name || "").trim().split(/\s+/)[0] || u.email.split("@")[0];

  const css = `
  .wm-acct-box{position:relative;display:flex;min-width:0}
  .wm-acct{border:1px solid transparent;background:none;color:var(--headInk,#fff);display:flex;align-items:center;gap:6px;
    font:inherit;text-align:left;padding:4px 6px;border-radius:3px;cursor:pointer;white-space:nowrap;min-width:0}
  .wm-acct:hover,.wm-acct[aria-expanded="true"]{border-color:var(--headInk,#fff)}
  .wm-acct:focus-visible{outline:3px solid var(--accent,#febd69);outline-offset:2px}
  .wm-acct .wm-at{display:flex;flex-direction:column;line-height:1.15;min-width:0}
  .wm-acct small{font-size:12px;overflow:hidden;text-overflow:ellipsis;max-width:180px}
  .wm-acct b{font-size:14px;display:flex;align-items:center;gap:3px}
  .wm-acct .wm-ic{display:none;flex:none}
  .wm-acct .wm-short{display:none;font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;max-width:84px}
  .wm-dim{position:fixed;inset:0;background:rgba(15,17,17,.45);z-index:19}
  .wm-menu{position:fixed;z-index:60;width:min(460px,calc(100vw - 16px));max-height:calc(100dvh - 90px);overflow:auto;
    background:var(--card,#fff);color:var(--ink,#0f1111);border:1px solid var(--line,#d5d9d9);border-radius:8px;
    box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:14px;line-height:1.4;text-align:left}
  .wm-menu[hidden]{display:none}
  .wm-mtop{padding:16px 18px 14px;border-bottom:1px solid var(--line,#d5d9d9);display:flex;flex-direction:column;align-items:center;gap:6px}
  .wm-mtop .wm-in{display:block;width:220px;max-width:100%;text-align:center;text-decoration:none;font-weight:700;color:var(--btnInk,#0f1111);
    background:var(--btn,#ffd814);border:1px solid var(--btnLine,var(--btn-line,#fcd200));border-radius:8px;padding:8px 12px}
  .wm-mtop .wm-in:hover{filter:brightness(.95);text-decoration:none}
  .wm-mtop p{margin:0;font-size:12.5px}
  .wm-who{display:flex;align-items:center;gap:12px;width:100%}
  .wm-av{width:42px;height:42px;border-radius:50%;background:var(--head,#131921);color:#fff;display:grid;place-items:center;font-weight:700;font-size:18px;flex:none}
  .wm-who div{min-width:0}
  .wm-who b{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis}
  .wm-who div span{display:block;color:var(--muted,#565959);font-size:12.5px;overflow:hidden;text-overflow:ellipsis}
  .wm-cols{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;padding:14px 18px 16px}
  .wm-cols+.wm-cols{border-top:1px solid var(--line,#d5d9d9)}
  .wm-cols h4{margin:0 0 6px;font-size:15px}
  .wm-cols ul{list-style:none;margin:0;padding:0}
  .wm-cols li a,.wm-cols li button{display:block;width:100%;text-align:left;border:0;background:none;padding:4px 0;font:inherit;font-size:13.5px;
    color:var(--ink,#0f1111);text-decoration:none;cursor:pointer}
  .wm-cols li a:hover,.wm-cols li button:hover{color:var(--bad,#b12704);text-decoration:underline}
  .wm-cols li small{color:var(--muted,#565959);font-size:12px}
  .wm-mfoot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 18px;border-top:1px solid var(--line,#d5d9d9);
    background:var(--chip,#f0f2f2);border-radius:0 0 8px 8px;font-size:13px}
  .wm-mfoot button{border:0;background:none;font:inherit;color:var(--link,#007185);cursor:pointer;padding:4px 0}
  .wm-mfoot button:hover{text-decoration:underline}
  @media (max-width:900px){
    .wm-acct .wm-at{display:none}
    .wm-acct .wm-ic,.wm-acct .wm-short{display:block}
    .wm-acct{padding:4px}
  }
  @media (max-width:430px){.wm-acct .wm-short{display:none}}
  @media (max-width:520px){.wm-cols{grid-template-columns:1fr;gap:14px}}`;

  const caret = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const person = '<svg class="wm-ic" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>';

  let me, loaded = false, box = null, closeT = 0, openT = 0;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  // ---------- the menu ----------
  const link = (href, text, extra = "") => `<li><a href="${esc(href)}" ${extra}>${text}</a></li>`;
  const nav = (view, text) => link(`/?view=${view}`, text, `data-wm-nav="${view}"`);
  function menuHtml() {
    const lists = `<div><h4>Your Lists</h4><ul>${me
      ? nav("lists", "Your lists") + nav("projects", "Your projects") + nav("items", "All items")
      : nav("lists", "Browse lists") + nav("projects", "Projects") + nav("items", "All items")}</ul></div>`;
    const acct = `<div><h4>Your Account</h4><ul>${me
      ? link("/account", "Your account") + link("/account#security", "Login &amp; security") + link("/hire", "Your AI shoppers")
        + link("/account#ai", "Saved AI keys") + link("/account#tokens", "Agent tokens") + link("/account#data", "Your data")
        + `<li><button type="button" data-wm-settings>Settings</button></li>`
      : link(signInUrl(), "Sign in") + link(signInUrl(true), "Create an account") + link("/hire", "AI shoppers")
        + `<li><button type="button" data-wm-settings>Settings <small>(this browser)</small></button></li>`}</ul></div>`;
    const top = me
      ? `<div class="wm-mtop"><div class="wm-who"><span class="wm-av" aria-hidden="true">${esc(firstName(me.user)[0].toUpperCase())}</span>
          <div><b>${esc(me.user.name || firstName(me.user))}</b><span>${esc(me.user.email)}</span></div></div></div>`
      : `<div class="wm-mtop"><a class="wm-in" href="${esc(signInUrl())}">Sign in</a>
          <p>New customer? <a href="${esc(signInUrl(true))}">Start here.</a></p></div>`;
    const foot = me ? `<div class="wm-mfoot"><span>Not ${esc(firstName(me.user))}?</span><button type="button" data-wm-out>Sign out</button></div>` : "";
    return `${top}<div class="wm-cols">${lists}${acct}</div>${foot}`;
  }
  function buttonHtml() {
    const hello = !loaded ? "Hello" : me ? `Hello, ${firstName(me.user)}` : "Hello, sign in";
    const short = !loaded ? "" : me ? firstName(me.user) : "Sign in";
    return `${person}<span class="wm-short">${esc(short)}</span><span class="wm-at"><small>${esc(hello)}</small><b>Account &amp; Lists ${caret}</b></span>`;
  }

  function paint() {
    for (const slot of document.querySelectorAll("[data-wm-acct]")) {
      if (!slot.querySelector(".wm-acct")) {
        slot.classList.add("wm-acct-box");
        slot.innerHTML = `<button type="button" class="wm-acct" aria-haspopup="true" aria-expanded="false"></button>`;
      }
      const b = slot.querySelector(".wm-acct"), html = buttonHtml();
      if (b.dataset.h !== html) { b.innerHTML = html; b.dataset.h = html; }
      b.setAttribute("aria-label", !loaded ? "Account and lists" : me ? `Account and lists for ${firstName(me.user)}` : "Sign in, account and lists");
    }
  }

  // One menu for the page, placed under whichever button opened it.
  let menu, dim;
  function ensureMenu() {
    if (menu) return;
    menu = document.createElement("div");
    menu.className = "wm-menu"; menu.id = "wm-acct-menu"; menu.hidden = true;
    menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", "Account and lists");
    dim = document.createElement("div"); dim.className = "wm-dim"; dim.hidden = true;
    document.body.append(dim, menu);
    menu.addEventListener("mouseenter", () => clearTimeout(closeT));
    menu.addEventListener("mouseleave", () => { if (hovering) closeSoon(); });
    dim.addEventListener("click", () => close());
  }
  let hovering = false;
  function place() {
    if (!box || !menu || menu.hidden) return;
    const b = box.querySelector(".wm-acct") || box;
    const r = b.getBoundingClientRect(), w = menu.offsetWidth, vw = document.documentElement.clientWidth;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, vw - w - 8)))}px`;
  }
  function open(slot, viaHover) {
    ensureMenu();
    clearTimeout(closeT);
    hovering = !!viaHover;
    if (box && box !== slot) box.querySelector(".wm-acct")?.setAttribute("aria-expanded", "false");
    box = slot;
    menu.innerHTML = menuHtml();
    menu.hidden = false; dim.hidden = false;
    slot.querySelector(".wm-acct")?.setAttribute("aria-expanded", "true");
    place();
    if (!viaHover) menu.querySelector("a,button")?.focus();
  }
  function close(refocus) {
    clearTimeout(openT); clearTimeout(closeT);
    if (!menu || menu.hidden) return;
    menu.hidden = true; dim.hidden = true;
    const b = box?.querySelector(".wm-acct");
    b?.setAttribute("aria-expanded", "false");
    if (refocus) b?.focus();
  }
  const closeSoon = () => { clearTimeout(closeT); closeT = setTimeout(() => close(), 250); };
  const fine = matchMedia("(hover:hover) and (pointer:fine)");

  document.addEventListener("click", e => {
    const b = e.target.closest(".wm-acct");
    if (b) {
      const slot = b.closest("[data-wm-acct]");
      if (menu && !menu.hidden && box === slot && !hovering) close(); else open(slot, false);
      return;
    }
    if (!menu || menu.hidden) return;
    const n = e.target.closest("[data-wm-nav]");
    if (n && typeof window.WMNav === "function" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault(); close(); window.WMNav(n.dataset.wmNav); return;
    }
    if (e.target.closest("[data-wm-settings]")) {
      close();
      if (window.WM?.open) window.WM.open(); else location.href = "/?settings=1";
      return;
    }
    if (e.target.closest("[data-wm-out]")) { signOut(false); return; }
    if (e.target.closest(".wm-menu a")) close();
    else if (!e.target.closest(".wm-menu")) close();
  });
  document.addEventListener("mouseover", e => {
    if (!fine.matches) return;
    const b = e.target.closest(".wm-acct");
    if (!b) return;
    const slot = b.closest("[data-wm-acct]");
    clearTimeout(closeT);
    if (menu && !menu.hidden && box === slot) return;
    clearTimeout(openT);
    openT = setTimeout(() => open(slot, true), 140);
  });
  document.addEventListener("mouseout", e => {
    if (!fine.matches || !e.target.closest(".wm-acct")) return;
    if (e.relatedTarget && (e.relatedTarget.closest?.(".wm-acct") || e.relatedTarget.closest?.(".wm-menu"))) return;
    clearTimeout(openT);
    if (hovering) closeSoon();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && menu && !menu.hidden) close(true); });
  addEventListener("resize", place);

  // ---------- who is signed in ----------
  async function refresh() {
    try {
      const r = await fetch("/api/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
      me = r.ok ? await r.json() : null;
    } catch (_) { me = null; }
    loaded = true;
    paint();
    if (menu && !menu.hidden) menu.innerHTML = menuHtml();
    window.dispatchEvent(new CustomEvent("wm:account", { detail: me }));
    return me;
  }
  async function signOut(all) {
    try { await fetch("/api/auth/logout" + (all ? "?all=1" : ""), { method: "POST", credentials: "same-origin" }); } catch (_) {}
    me = null;
    location.reload();
  }

  window.WMAccount = {
    ready, signOut, signInUrl,
    get me() { return me; },
    refresh: () => refresh(),
  };

  function init() {
    if (!document.getElementById("wm-acct-css")) {
      const st = document.createElement("style"); st.id = "wm-acct-css"; st.textContent = css; document.head.appendChild(st);
    }
    paint();
    // Pages that redraw their header put a fresh placeholder in; fill it.
    new MutationObserver(() => { if (document.querySelector("[data-wm-acct]:not(.wm-acct-box)")) paint(); })
      .observe(document.body, { childList: true, subtree: true });
    refresh().then(resolveReady);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
