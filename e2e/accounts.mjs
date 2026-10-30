// Browser test of the account pages: node e2e/accounts.mjs (needs Playwright + Chromium).
// Header account menu, sign up, copying the site's lists in, Your Account and its
// sections, signing out and in again, phone layout, and closing the account.
import { fileURLToPath } from "node:url";
import "./servers.mjs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = "http://localhost:8788";
const shots = process.env.SHOTS || fileURLToPath(new URL(".", import.meta.url));
const shot = async (p, name, opts = {}) => { if (process.env.SHOTS) await p.screenshot({ path: `${shots}/${name}.png`, ...opts }); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|fonts\.g/.test(m.text())) errors.push(m.text()); });
page.on("dialog", d => d.accept());
const ok = (c, m) => { if (!c) { console.log("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };
const acctText = () => page.locator(".wm-acct .wm-at").textContent();

// Signed out: the header offers sign in.
await page.goto(SITE + "/");
await page.waitForFunction(() => /sign in/.test(document.querySelector(".wm-acct")?.textContent || ""));
ok(/Hello, sign in.*Account & Lists/.test(await acctText()), "header says Hello, sign in");
await page.click(".wm-acct");
await page.waitForSelector(".wm-menu:not([hidden]) .wm-in");
ok(await page.locator(".wm-menu .wm-in").textContent() === "Sign in", "menu has a Sign in button");
await shot(page, "menu-signed-out");
await page.click(".wm-menu >> text=Start here.");
await page.waitForURL(/\/signin\?new=1/);
await page.waitForSelector("#up:not([hidden])");
ok(new URL(page.url()).searchParams.get("next") === "/", "sign-up link comes back to the page it was opened on");

// Create an account, with a typo first.
await page.fill("#up-name", "Ann Lee");
await page.fill("#up-email", "ann@example.com");
await page.fill("#up-pass", "correct horse");
await page.fill("#up-pass2", "correct hose");
await page.click("#up-btn");
ok(await page.locator("#up-pass2-err").isVisible(), "mismatched passwords are caught");
await shot(page, "signup-error");
await page.fill("#up-pass2", "correct horse");
await page.click("#up-btn");
await page.waitForURL(SITE + "/");
await page.waitForFunction(() => /Ann/.test(document.querySelector(".wm-acct")?.textContent || ""));
ok(/Hello, Ann/.test(await acctText()), "header says Hello, Ann after sign-up");

// The menu opens views in place.
await page.click(".wm-acct");
await page.waitForSelector(".wm-menu:not([hidden]) .wm-who");
ok(/ann@example\.com/.test(await page.locator(".wm-menu .wm-who").textContent()), "menu shows who is signed in");
await shot(page, "menu-signed-in");
await page.click(".wm-menu >> text=Your projects");
await page.waitForSelector('.sub [data-view="projects"][aria-current="true"]');
ok(new URL(page.url()).pathname === "/" && await page.locator(".wm-menu").isHidden(), "Your projects opens in place and closes the menu");

// Your Account hub.
await page.goto(SITE + "/account");
await page.waitForSelector(".hub .tile");
ok(await page.locator(".hub .tile").count() === 7, "Your Account has 7 sections");
ok(/lists?/.test(await page.locator(".hub .tile").first().textContent()), "lists tile counts the lists");
await shot(page, "account-hub");

// Login & security: name, password, devices.
await page.click("text=Login & security");
await page.waitForSelector("text=Signed-in devices");
await page.waitForSelector(".tag >> text=This device");
ok(/Chrome on Windows/.test(await page.locator(".panel").nth(1).textContent()), "device named from its browser");
await page.click('[data-toggle="name-edit"]');
await page.fill("#n-name", "Annie Lee");
await page.click("#name-edit [type=submit]");
await page.waitForFunction(() => /Annie Lee/.test(document.querySelector(".panel").textContent));
await page.waitForFunction(() => /Hello, Annie/.test(document.querySelector(".wm-acct").textContent));
ok(true, "name saved and the header picked it up");
await page.click('[data-toggle="pw-edit"]');
await page.fill("#p-cur", "correct horse");
await page.fill("#p-new", "battery staple");
await page.fill("#p-new2", "battery stapel");
await page.click("#pw-edit [type=submit]");
ok(/don't match/.test(await page.locator("#pw-msg").textContent()), "new password typo caught");
await page.fill("#p-new2", "battery staple");
await page.click("#pw-edit [type=submit]");
await page.waitForSelector(".toast >> text=Password changed");
ok(true, "password changed");
await shot(page, "account-security", { fullPage: true });

// A second device shows up and can be signed out from here.
const other = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1" });
const phone = await other.newPage();
await phone.goto(SITE + "/signin");
await phone.fill("#in-email", "ann@example.com");
await phone.fill("#in-pass", "battery staple");
await phone.click("#in-btn");
await phone.waitForURL(SITE + "/");
await page.reload();
await page.waitForSelector("text=Safari on iPhone");
await page.locator(".prow", { hasText: "Safari on iPhone" }).locator("[data-out-dev]").click();
await page.waitForSelector("text=Safari on iPhone", { state: "detached" });
const r = await phone.evaluate(() => fetch("/api/me").then(r => r.status));
ok(r === 401, "signed the phone out from the computer");
await other.close();

// Saved AI keys, agent tokens, your data.
await page.goto(SITE + "/account#ai");
await page.waitForSelector("#a-provider option", { state: "attached" });
ok(await page.locator("#a-provider option").count() > 5, "AI provider list filled");
ok(/aistudio|console|platform/.test(await page.locator("#key-link").textContent()), "link to get a key");
await page.goto(SITE + "/account#tokens");
await page.fill("#t-name", "My agent");
await page.click("#token-form [type=submit]");
await page.waitForSelector("#new-token:not([hidden])");
ok(/^wm_/.test(await page.locator("#new-token-text").textContent()), "token shown once");
ok(await page.locator("[data-del-token]").count() === 1, "token listed");
await shot(page, "account-tokens", { fullPage: true });
await page.goto(SITE + "/account#data");
await page.click("#import-btn");
await page.waitForSelector("#data-msg >> text=Copied");
ok(/lists/.test(await page.locator(".counts").textContent()), "data counts shown");

// Sign out from the menu, then sign in again with a wrong password first.
await page.goto(SITE + "/");
await page.waitForFunction(() => /Annie/.test(document.querySelector(".wm-acct")?.textContent || ""));
await page.click(".wm-acct");
await page.click(".wm-menu [data-wm-out]");
await page.waitForFunction(() => /sign in/.test(document.querySelector(".wm-acct")?.textContent || ""));
ok(true, "signed out from the menu");
await page.goto(SITE + "/account#tokens");
await page.waitForURL(/\/signin\?next=/);
ok(new URL(page.url()).searchParams.get("next") === "/account#tokens", "Your Account sends signed-out people to sign in");
await page.fill("#in-email", "ann@example.com");
await page.fill("#in-pass", "correct horse");
await page.click("#in-btn");
await page.waitForSelector("#alert:not([hidden])");
ok(/wrong/.test(await page.locator("#alert").textContent()), "wrong password shows a problem box");
await shot(page, "signin-error");
await page.fill("#in-pass", "battery staple");
await page.click("#in-btn");
await page.waitForURL(SITE + "/account#tokens");
ok(true, "signed in and came back to Agent tokens");
await page.goto(SITE + "/signin");
await page.waitForSelector("#already:not([hidden])");
ok(true, "sign-in page knows you're already signed in");

// Phones: nothing scrolls sideways, and the menu fits.
const m = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
const mp = await m.newPage();
mp.on("pageerror", e => errors.push(e.message));
for (const path of ["/", "/account", "/account#security", "/signin", "/signin?new=1", "/hire"]) {
  await mp.goto(SITE + path);
  await mp.waitForTimeout(500);
  const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `no sideways scroll on a phone: ${path} (${over})`);
  if (path === "/") { await mp.waitForSelector(".wm-acct .wm-ic"); await shot(mp, "phone-home"); }
  if (path === "/account") await shot(mp, "phone-account", { fullPage: true });
}
const fresh = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true });
const fp = await fresh.newPage();
await fp.goto(SITE + "/signin?new=1");
await fp.waitForSelector("#up:not([hidden])");
ok(await fp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, "no sideways scroll on a phone: create account");
await shot(fp, "phone-signup");
await fresh.close();
await mp.goto(SITE + "/");
await mp.waitForSelector(".wm-acct .wm-ic");
await mp.tap(".wm-acct");
await mp.waitForSelector(".wm-menu:not([hidden])");
const box = await mp.locator(".wm-menu").boundingBox();
ok(box.x >= 0 && box.x + box.width <= 375, "menu fits on a phone");
ok(await mp.locator(".wm-menu [data-wm-settings]").count() === 1, "Settings reachable from the menu on phones");
await shot(mp, "phone-menu");
await m.close();

// Close the account.
await page.goto(SITE + "/account#data");
await page.click('[data-toggle="del-form"]');
await page.fill("#d-pass", "battery staple");
await page.click("#del-form [type=submit]");
await page.waitForURL(SITE + "/");
await page.waitForSelector(".toast >> text=account was closed");
await page.waitForFunction(() => /sign in/.test(document.querySelector(".wm-acct")?.textContent || ""));
ok(true, "account closed, back to the signed-out site");

ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
await browser.close();
process.exit();
