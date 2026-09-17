import { test } from "node:test";
import assert from "node:assert/strict";
import { clipboardCommand, findCallbackUrl, watchClipboard } from "../src/core/market/clipboard.ts";

const CALLBACK = "https://127.0.0.1:8182";
const urlFor = (code: string): string => `${CALLBACK}/?code=${code}%40&session=abc-123`;

test("findCallbackUrl: accepts the redirected address, ignores everything else", () => {
  assert.equal(findCallbackUrl(urlFor("C0.aaa"), CALLBACK), urlFor("C0.aaa"));
  assert.equal(findCallbackUrl(`  ${urlFor("C0.aaa")}\r\n`, CALLBACK), urlFor("C0.aaa"));
  // Edge's "friendly" link format
  assert.equal(findCallbackUrl(`[127.0.0.1](${urlFor("C0.bbb")})`, CALLBACK), urlFor("C0.bbb"));
  assert.equal(findCallbackUrl("", CALLBACK), null);
  assert.equal(findCallbackUrl("my password is hunter2", CALLBACK), null);
  assert.equal(findCallbackUrl("https://127.0.0.1:8182/", CALLBACK), null, "no ?code=");
  assert.equal(findCallbackUrl("https://evil.example/?code=C0.zzz", CALLBACK), null, "wrong origin");
  assert.equal(findCallbackUrl("https://127.0.0.1:9999/?code=C0.zzz", CALLBACK), null, "wrong port");
  assert.equal(
    findCallbackUrl("https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=x", CALLBACK),
    null,
    "the authorize URL is not the callback",
  );
});

test("clipboardCommand: Windows and macOS have a reader, other platforms fall back to pasting", () => {
  assert.equal(clipboardCommand("win32")?.cmd, "powershell.exe");
  assert.ok(clipboardCommand("win32")?.args.includes("Get-Clipboard -Raw"));
  assert.equal(clipboardCommand("darwin")?.cmd, "pbpaste");
  assert.equal(clipboardCommand("linux"), null);
});

test("watchClipboard: ignores what was already on the clipboard, reports each new address once", async () => {
  let clip = urlFor("C0.stale"); // last attempt's expired address is still on the clipboard
  const watch = watchClipboard({ callbackUrl: CALLBACK, read: async () => clip, intervalMs: 5 });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    let got: string | null = null;
    void watch.next().then((u) => { got = u; });
    await sleep(40);
    assert.equal(got, null, "the stale address must not fire");

    clip = "something unrelated";
    await sleep(25);
    assert.equal(got, null);

    clip = urlFor("C0.fresh");
    await sleep(40);
    assert.equal(got, urlFor("C0.fresh"));

    // Same address still on the clipboard -> not reported twice.
    let again: string | null = null;
    void watch.next().then((u) => { again = u; });
    await sleep(40);
    assert.equal(again, null);

    clip = urlFor("C0.second");
    await sleep(40);
    assert.equal(again, urlFor("C0.second"));
  } finally {
    watch.stop();
  }
});

test("watchClipboard: a reader that throws is treated as an empty clipboard", async () => {
  let calls = 0;
  const watch = watchClipboard({
    callbackUrl: CALLBACK,
    read: async () => { calls++; if (calls < 3) throw new Error("clipboard busy"); return urlFor("C0.after-errors"); },
    intervalMs: 5,
  });
  try {
    const u = await watch.next();
    assert.equal(u, urlFor("C0.after-errors"));
  } finally {
    watch.stop();
  }
});
