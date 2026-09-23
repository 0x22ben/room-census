// Shared by the browser tests: serves web/dist on a local port and drives one headless Chromium
// (Chrome, Edge or Chromium) over the DevTools protocol. Set BROWSER_BIN, or it is looked up. The
// tests skip when no browser or no build is found, unless REQUIRE_BROWSER=1 (CI), where they fail.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIST = join(WEB, "dist");

const CANDIDATES = [
  process.env.BROWSER_BIN,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));
const BUILT = existsSync(join(DIST, "index.html"));
if (process.env.REQUIRE_BROWSER === "1") {
  assert.ok(BROWSER, "REQUIRE_BROWSER=1 but no Chromium browser was found (set BROWSER_BIN)");
  assert.ok(BUILT, "REQUIRE_BROWSER=1 but web/dist is not built");
}
export const skip = !BROWSER ? "no Chromium browser found" : !BUILT ? "web/dist is not built" : false;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".txt": "text/plain", ".csv": "text/csv" };

let server;
let browser;
let profile;
let ws;
let id = 0;
const pending = new Map();
/** Protocol events go to every listener in this set. */
export const listeners = new Set();
export const site = { origin: "" };

export function send(method, params = {}) {
  return new Promise((ok, fail) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

/** Evaluates an expression in the page and returns its value (promises are awaited). */
export async function page(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

export async function until(expr, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page(expr)) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Loads a path of the site and waits for its load event. */
export async function navigate(path) {
  let loaded = false;
  const onLoad = (msg) => { if (msg.method === "Page.loadEventFired") loaded = true; };
  listeners.add(onLoad);
  await send("Page.navigate", { url: `${site.origin}${path}` });
  for (let i = 0; i < 200 && !loaded; i++) await sleep(25);
  listeners.delete(onLoad);
}

export async function start() {
  if (skip) return;
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(DIST, path));
    if (!file.startsWith(DIST + sep) && file !== DIST) { res.writeHead(403).end(); return; }
    if (path.endsWith("/")) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  site.origin = `http://127.0.0.1:${server.address().port}`;

  profile = mkdtempSync(join(tmpdir(), "rc-browser-"));
  const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "about:blank"];
  if (process.platform === "linux") args.unshift("--no-sandbox");
  // a cold browser on a CI runner can take well over ten seconds to open its debugging port
  let stderr = "";
  browser = spawn(BROWSER, args, { stdio: ["ignore", "ignore", "pipe"] });
  browser.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 1200 && !existsSync(portFile) && browser.exitCode === null; i++) await sleep(50);
  assert.ok(existsSync(portFile), `the browser did not open its debugging port within 60 s (exit ${browser.exitCode}): ${stderr}`);
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    port = readFileSync(portFile, "utf8").split("\n")[0].trim();
    if (!port) await sleep(50);
  }
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    if (!target) await sleep(50);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    for (const l of listeners) l(msg);
  });
  await send("Page.enable");
  await send("Network.enable");
}

export async function stop() {
  ws?.close();
  browser?.kill();
  await new Promise((r) => (server ? server.close(r) : r()));
  await sleep(300);
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
