import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GitHubError, publishStatus, repoFromGitConfig, tokenFile, whoAmI } from "../src/core/check/publish.ts";

test("repoFromGitConfig: https and ssh remotes", () => {
  assert.deepEqual(repoFromGitConfig('[remote "origin"]\n\turl = https://github.com/jamesskeneco-dev/Altovix-app.git\n\tfetch = +refs'), { owner: "jamesskeneco-dev", repo: "Altovix-app" });
  assert.deepEqual(repoFromGitConfig("url = git@github.com:someone/thing.git\n"), { owner: "someone", repo: "thing" });
  assert.deepEqual(repoFromGitConfig("url = https://github.com/a/b\n"), { owner: "a", repo: "b" });
  assert.equal(repoFromGitConfig("[core]\n\tbare = false\n"), null);
});

test("tokenFile: outside the repo (LOCALAPPDATA on Windows), overridable", () => {
  assert.match(tokenFile("win32", { LOCALAPPDATA: "C:\\Users\\j\\AppData\\Local" }), /AppData.Local.Altovix.github-token\.txt$/);
  assert.equal(tokenFile("win32", { ALTOVIX_GITHUB_TOKEN_FILE: "D:\\k.txt" }), "D:\\k.txt");
});

/** A stand-in for the few GitHub endpoints the publisher uses. */
function fakeGitHub(opts: { hasBranch: boolean; hasFile: boolean; token?: string }): Promise<{ server: Server; base: string; calls: string[]; puts: Array<Record<string, unknown>> }> {
  const calls: string[] = [], puts: Array<Record<string, unknown>> = [];
  let hasBranch = opts.hasBranch;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
      calls.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
      const send = (code: number, json: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== `Bearer ${opts.token ?? "good"}`) return send(401, { message: "Bad credentials" });
      const url = req.url ?? "";
      if (url === "/user") return send(200, { login: "james" });
      if (url === "/repos/o/r") return send(200, { default_branch: "main" });
      if (url === "/repos/o/r/git/ref/heads/status") return hasBranch ? send(200, { object: { sha: "s1" } }) : send(404, { message: "Not Found" });
      if (url === "/repos/o/r/git/ref/heads/main") return send(200, { object: { sha: "m1" } });
      if (url === "/repos/o/r/git/refs" && req.method === "POST") { hasBranch = true; assert.deepEqual(JSON.parse(body), { ref: "refs/heads/status", sha: "m1" }); return send(201, {}); }
      if (url.startsWith("/repos/o/r/contents/status.json") && req.method === "GET") return opts.hasFile ? send(200, { sha: "f1" }) : send(404, { message: "Not Found" });
      if (url === "/repos/o/r/contents/status.json" && req.method === "PUT") { puts.push(JSON.parse(body) as Record<string, unknown>); return send(opts.hasFile ? 200 : 201, { commit: { sha: "c9" } }); }
      send(404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, puts })));
}

test("publishStatus: first time creates the status branch from main and the file", async () => {
  const g = await fakeGitHub({ hasBranch: false, hasFile: false });
  try {
    const r = await publishStatus({ owner: "o", repo: "r", token: "good", content: '{"asOf":"2026-09-17"}', apiBase: g.base, message: "status: 2026-09-17 close" });
    assert.deepEqual(r, { created: true, commit: "c9" });
    assert.ok(g.calls.includes("POST /repos/o/r/git/refs"));
    assert.equal(g.puts[0]?.["branch"], "status");
    assert.equal(g.puts[0]?.["sha"], undefined);
    assert.equal(Buffer.from(String(g.puts[0]?.["content"]), "base64").toString("utf8"), '{"asOf":"2026-09-17"}');
    assert.ok(!g.calls.some((c) => /heads\/main/.test(c) && c.startsWith("P")), "main is only read, never written");
  } finally { g.server.close(); }
});

test("publishStatus: later runs update the file in place (passes its sha), branch untouched", async () => {
  const g = await fakeGitHub({ hasBranch: true, hasFile: true });
  try {
    const r = await publishStatus({ owner: "o", repo: "r", token: "good", content: "{}", apiBase: g.base });
    assert.equal(r.created, false);
    assert.equal(g.puts[0]?.["sha"], "f1");
    assert.ok(!g.calls.includes("POST /repos/o/r/git/refs"));
  } finally { g.server.close(); }
});

test("a bad key fails loudly with what to do about it; whoAmI proves a good one", async () => {
  const g = await fakeGitHub({ hasBranch: true, hasFile: true });
  try {
    await assert.rejects(publishStatus({ owner: "o", repo: "r", token: "stale", content: "{}", apiBase: g.base }), (e: unknown) => e instanceof GitHubError && e.status === 401 && /altovix-publish-setup/.test(e.message));
    await assert.rejects(whoAmI("stale", g.base), /HTTP 401/);
    assert.equal(await whoAmI("good", g.base), "james");
  } finally { g.server.close(); }
});
