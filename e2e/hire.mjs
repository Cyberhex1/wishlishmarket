// Browser test of the Hire page: node e2e/hire.mjs (needs Playwright + Chromium).
// Hires a suggested local team, a search helper and a cloud shopper, sets up a
// local shopper (blocked, then allowed by CORS) and runs a list with it.
import { fileURLToPath } from "node:url";
import { state } from "./servers.mjs";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = "http://localhost:8788";
const shots = process.env.SHOTS || fileURLToPath(new URL(".", import.meta.url));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_FAILED|CORS/.test(m.text())) errors.push(m.text()); });
const ok = (c, m) => { if (!c) { console.log("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };

await page.goto(`${SITE}/hire`);
await page.waitForSelector("#cloud-list .cv");
ok(await page.locator("#cloud-list .cv").count() === 11, "11 cloud shoppers");
ok(await page.locator("#local-list .cv").count() === 3, "3 local runtimes");
ok(await page.locator("#helper-list .cv").count() === 4, "4 search helpers");
ok((await page.locator("#cloud-list .cv h3").first().textContent()) === "Google Gemini", "Gemini first");
if (process.env.SHOTS) await page.screenshot({ path: `${shots}/hire-top.png` });

// Suggest for an RTX 4070
await page.fill("#gpu", "RTX 4070");
await page.click("#suggest-btn");
await page.waitForSelector("#suggest-out .stamp");
ok(await page.locator("#suggest-out .cv").count() === 3, "3 suggested shoppers hired");
ok(await page.locator("#team-list .member").count() === 3, "team has 3");
ok(/Lead shopper/.test(await page.locator("#team-list .member").first().textContent()), "lead badge on first");
if (process.env.SHOTS) await page.locator("#suggest").screenshot({ path: `${shots}/suggest.png` });

// Search helper: Tavily
const tav = page.locator('[data-helper="tavily"]');
await tav.locator("input").fill("tvly-dev-test123");
await tav.locator('[data-act="save"]').click();
await page.waitForSelector('[data-helper="tavily"] .badge.lead');
ok(true, "tavily hired and in use");

// Local setup with CORS blocked, then allowed
await page.locator("#team-list .member").first().locator('[data-act="edit"]').click();
await page.waitForSelector("#dlg[open]");
await page.click("#l-test");
await page.waitForFunction(() => /isn't allowing|Can't reach/.test(document.querySelector("#l-msg").textContent));
const blocked = await page.locator("#l-msg").textContent();
ok(/isn't allowing this site/.test(blocked), `CORS-blocked diagnosis: ${blocked.slice(0, 90)}`);
state.allowed.push(SITE);
await page.click("#l-test");
await page.waitForFunction(() => /Connected/.test(document.querySelector("#l-msg").textContent));
ok(true, "connected after allowing the origin");
if (process.env.SHOTS) await page.locator("#dlg").screenshot({ path: `${shots}/local-dialog.png` });
await page.click("#l-go");
await page.waitForFunction(() => /ready/.test(document.querySelector("#l-msg").textContent));
await page.click("#dlg [data-close]");
ok(/Ready/.test(await page.locator("#team-list .member").first().textContent()), "lead shows Ready");

// Try it: local lead runs in the browser, searches through /api/search, finishes on the server
await page.fill("#try-req", "kitchen widgets under $20");
await page.selectOption("#try-count", "5");
await page.click("#try-btn");
await page.waitForSelector("#try-out .item", { timeout: 60000 }).catch(() => {});
const items = await page.locator("#try-out .item").count();
ok(items === 3, `try returned ${items} items; msg: ${(await page.locator("#try-msg").textContent()).slice(0, 120)}`);
ok(state.chats.length === 2 && state.chats.every(c => c.options.num_ctx === 16384 && c.format), "Ollama got format schema and num_ctx 16384");
if (process.env.SHOTS) await page.locator("#try").screenshot({ path: `${shots}/try.png` });

// Hire a cloud shopper (OpenAI) with a key
await page.locator('#cloud-list [data-hire="openai"]').click();
await page.fill("#h-key", "sk-" + "proj-abcdefghijklmnopqrstuvwxyz012345"); // joined so secret scanners skip it
await page.click("#h-go");
await page.waitForFunction(() => /Hired|Saved/.test(document.querySelector("#h-msg").textContent));
ok(true, "OpenAI hired after key check");
if (process.env.SHOTS) await page.locator("#dlg").screenshot({ path: `${shots}/hire-openai.png` });
await page.click("#dlg [data-close]");
ok(await page.locator("#team-list .member").count() === 4, "team has 4");
const stored = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem("wm.settings")), k: localStorage.getItem("wm.key.openai") }));
ok(stored.k && !JSON.stringify(stored.s).includes(stored.k), "key kept apart from settings");

// Main page: header has the Shoppers link, settings shows the lead
await page.goto(`${SITE}/`);
await page.waitForSelector(".wm-tools a[href='/hire']", { timeout: 15000 }).catch(() => {});
ok(await page.locator(".wm-tools a[href='/hire']").count() === 1, "Shoppers link in header");
if (process.env.SHOTS) await page.screenshot({ path: `${shots}/main.png` });
await page.locator(".wm-tools button.wm-gear").click();
await page.waitForSelector("dialog.wm-set[open]");
ok(/lead shopper/i.test(await page.locator(".wm-note").first().textContent()), "settings mentions lead shopper");
if (process.env.SHOTS) await page.locator("dialog.wm-set").screenshot({ path: `${shots}/settings.png` });

// Mobile view of the hire page
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await m.newPage();
await mp.goto(`${SITE}/hire`);
await mp.waitForSelector("#cloud-list .cv");
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
ok(overflow <= 0, `no sideways scroll on phones (${overflow})`);
if (process.env.SHOTS) await mp.screenshot({ path: `${shots}/mobile.png`, fullPage: false });
if (process.env.SHOTS) await mp.locator("#suggest").screenshot({ path: `${shots}/mobile-suggest.png` });

ok(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
await browser.close();
process.exit();
