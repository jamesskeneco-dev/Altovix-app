import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  browserArgs, browserCandidates, findBrowser, freePort, loginProfileDir, watchDevTools,
} from "../src/core/market/browser-login.ts";

const CALLBACK = "https://127.0.0.1:8182";
const AUTHORIZE = "https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2F127.0.0.1%3A8182";
const WIN = { "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\j\\AppData\\Local" };

test("browserCandidates / findBrowser: Edge before Chrome on Windows, override first, none on Linux", () => {
  const c = browserCandidates("win32", WIN);
  assert.equal(c[0], "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.ok(c.indexOf("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") > c.findLastIndex((p) => p.endsWith("msedge.exe")));
  assert.equal(browserCandidates("win32", { ...WIN, SCHWAB_BROWSER: "D:\\x\\browser.exe" })[0], "D:\\x\\browser.exe");
  assert.deepEqual(browserCandidates("linux", {}), []);
  const chromeOnly = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(findBrowser("win32", WIN, (p) => p === chromeOnly), chromeOnly);
  assert.equal(findBrowser("win32", WIN, () => false), null);
});

test("loginProfileDir: outside the repo (LOCALAPPDATA on Windows), overridable", () => {
  assert.match(loginProfileDir("win32", WIN), /AppData.Local.Altovix.schwab-browser$/);
  assert.equal(loginProfileDir("win32", { ...WIN, SCHWAB_BROWSER_PROFILE: "D:\\p" }), "D:\\p");
});

test("browserArgs: own profile + debug port, and the authorize URL intact as the last argument", () => {
  const a = browserArgs({ port: 9333, profileDir: "C:\\p", url: AUTHORIZE, extraArgs: ["--headless=new"] });
  assert.ok(a.includes("--remote-debugging-port=9333"));
  assert.ok(a.includes("--user-data-dir=C:\\p"));
  assert.equal(a.at(-1), AUTHORIZE);
});

/** A stand-in for the browser's DevTools HTTP endpoint. */
function fakeDevTools(): Promise<{ server: Server; port: number; tabs: Array<{ id: string; type: string; url: string }>; opened: string[]; closed: string[] }> {
  const state = { tabs: [] as Array<{ id: string; type: string; url: string }>, opened: [] as string[], closed: [] as string[] };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/json/list") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(state.tabs)); }
    if (url.startsWith("/json/new?")) {
      if (req.method !== "PUT") { res.writeHead(405); return res.end("use PUT"); }
      const target = decodeURIComponent(url.slice("/json/new?".length));
      state.opened.push(target);
      state.tabs.push({ id: `t${state.tabs.length + 1}`, type: "page", url: target });
      res.writeHead(200, { "content-type": "application/json" }); return res.end("{}");
    }
    if (url.startsWith("/json/close/")) {
      const id = url.slice("/json/close/".length);
      state.closed.push(id);
      state.tabs = state.tabs.filter((t) => t.id !== id);
      res.writeHead(200); return res.end("Target is closing");
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, port: (server.address() as AddressInfo).port, get tabs() { return state.tabs; }, set tabs(v) { state.tabs = v; }, opened: state.opened, closed: state.closed });
  }));
}

test("watchDevTools: reports the callback tab once, ignores other tabs, reopens and closes tabs", async () => {
  const dt = await fakeDevTools();
  let killed = 0;
  const b = watchDevTools({ port: dt.port, callbackUrl: CALLBACK, intervalMs: 5, process: { onError: () => {}, kill: () => { killed++; } } });
  try {
    dt.tabs = [
      { id: "a", type: "page", url: AUTHORIZE },
      { id: "sw", type: "service_worker", url: `${CALLBACK}/?code=C0.not-a-page%40` },
    ];
    const first = b.next();
    await new Promise((r) => setTimeout(r, 40));
    dt.tabs = [{ id: "a", type: "page", url: `${CALLBACK}/?code=C0.one%40&session=s1` }];
    const e1 = await first;
    assert.deepEqual(e1, { kind: "callback", url: `${CALLBACK}/?code=C0.one%40&session=s1` });

    // Same tab still there: not reported again. A retry tab gets the FULL authorize URL.
    assert.equal(await b.open(AUTHORIZE), true);
    assert.deepEqual(dt.opened, [AUTHORIZE]);
    const second = b.next();
    await new Promise((r) => setTimeout(r, 40));
    dt.tabs = [...dt.tabs, { id: "c", type: "page", url: `${CALLBACK}/?code=C0.two%40&session=s2` }];
    const e2 = await second;
    assert.equal(e2.kind === "callback" && e2.url, `${CALLBACK}/?code=C0.two%40&session=s2`);
  } finally {
    await b.close();
    dt.server.close();
  }
  assert.ok(dt.closed.length >= 2, "close() closes the tabs");
  assert.equal(killed, 1);
});

test("watchDevTools: a window that goes away is reported as closed", async () => {
  const dt = await fakeDevTools();
  const b = watchDevTools({ port: dt.port, callbackUrl: CALLBACK, intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  const ev = b.next();
  await new Promise<void>((r) => { dt.server.close(() => r()); dt.server.closeAllConnections(); });
  const e = await ev;
  assert.equal(e.kind, "closed");
});

test("watchDevTools: a window that never starts gives up after startupMs", async () => {
  const port = await freePort();
  const b = watchDevTools({ port, callbackUrl: CALLBACK, intervalMs: 5, startupMs: 60 });
  const e = await b.next();
  assert.deepEqual(e.kind, "closed");
});
