import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { findCallbackUrl } from "./clipboard.ts";

/**
 * Hands-free Schwab sign-in.
 *
 * Schwab's authorization code dies about 30 seconds after the browser is redirected to the
 * callback address, and nothing listens on that address, so a person has to move the code from
 * the browser to the terminal inside that window. That proved too fiddly in practice. Instead,
 * `login` opens its OWN Edge/Chrome window (a dedicated profile, with the local DevTools port on
 * 127.0.0.1) and polls the tab list: the moment a tab lands on the callback address the code is
 * read from the tab's URL and exchanged - well under a second, no copying, no pasting.
 *
 * Only the tab URL is read. Nothing is typed, clicked or scraped in the Schwab pages; the user
 * signs in by hand. The debug port is bound to 127.0.0.1 and lives only while that window is open.
 */

type Env = Record<string, string | undefined>;

/** Edge first (it is on every Windows PC), then Chrome. SCHWAB_BROWSER overrides. */
export function browserCandidates(platform: string = process.platform, env: Env = process.env): string[] {
  const out: string[] = [];
  const override = env["SCHWAB_BROWSER"];
  if (override) out.push(override);
  if (platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env["ProgramFiles"], env["LOCALAPPDATA"]].filter((r): r is string => Boolean(r));
    for (const r of roots) out.push(`${r}\\Microsoft\\Edge\\Application\\msedge.exe`);
    for (const r of roots) out.push(`${r}\\Google\\Chrome\\Application\\chrome.exe`);
  } else if (platform === "darwin") {
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  }
  return out;
}

export function findBrowser(
  platform: string = process.platform,
  env: Env = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const p of browserCandidates(platform, env)) if (exists(p)) return p;
  return null;
}

/**
 * The sign-in window's own profile. Deliberately OUTSIDE the repo (which sits in OneDrive): a
 * browser profile is large, churns constantly and holds Schwab's "remember this device" cookie.
 */
export function loginProfileDir(platform: string = process.platform, env: Env = process.env): string {
  if (env["SCHWAB_BROWSER_PROFILE"]) return env["SCHWAB_BROWSER_PROFILE"];
  if (platform === "win32") return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Altovix", "schwab-browser");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Altovix", "schwab-browser");
  return join(env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "altovix", "schwab-browser");
}

export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

interface DevToolsTarget { id?: string; type?: string; url?: string }

export type BrowserEvent =
  | { kind: "callback"; url: string }
  /** The window was closed (or never came up) before a code arrived. */
  | { kind: "closed"; reason: string };

export interface LoginBrowser {
  readonly port: number;
  /** Resolves with the next event. Each callback address is reported once. Never rejects. */
  next(): Promise<BrowserEvent>;
  /** Opens another tab in the sign-in window (used to retry after a rejected code). */
  open(url: string): Promise<boolean>;
  /** Closes the sign-in window and stops polling. */
  close(): Promise<void>;
}

export interface LoginBrowserOptions {
  url: string;
  callbackUrl: string;
  browserPath: string;
  profileDir?: string;
  port?: number;
  /** Extra command-line switches (tests use --headless=new --no-sandbox). */
  extraArgs?: string[];
  intervalMs?: number;
  /** How long to wait for the debug port to answer before giving up on the window. */
  startupMs?: number;
}

async function listTargets(port: number): Promise<DevToolsTarget[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    return Array.isArray(json) ? (json as DevToolsTarget[]) : null;
  } catch {
    return null;
  }
}

/** Minimal handle on the launched browser process - just enough to make sure it ends. */
interface BrowserProcess {
  onError(cb: (err: Error) => void): void;
  kill(): void;
}

/**
 * Watches an already-listening DevTools port. Split from the launch so it can be tested against
 * a fake DevTools server without a real browser.
 */
export function watchDevTools(opts: {
  port: number;
  callbackUrl: string;
  intervalMs?: number;
  startupMs?: number;
  process?: BrowserProcess;
}): LoginBrowser {
  const { port } = opts;
  const interval = opts.intervalMs ?? 250;
  const startupMs = opts.startupMs ?? 20_000;

  const seen = new Set<string>();
  const queue: BrowserEvent[] = [];
  let waiter: ((e: BrowserEvent) => void) | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let everUp = false;
  let misses = 0;
  const started = Date.now();

  const emit = (e: BrowserEvent): void => {
    if (waiter) { const w = waiter; waiter = null; w(e); } else queue.push(e);
  };
  const finish = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    emit({ kind: "closed", reason });
  };
  opts.process?.onError((err) => finish(`could not start the browser: ${err.message}`));

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const targets = await listTargets(port);
    if (stopped) return;
    if (targets) {
      everUp = true;
      misses = 0;
      for (const t of targets) {
        if (t.type !== "page" || !t.url) continue;
        const url = findCallbackUrl(t.url, opts.callbackUrl);
        if (url && !seen.has(url)) { seen.add(url); emit({ kind: "callback", url }); }
      }
    } else if (everUp) {
      // The port answered before and no longer does: the window was closed.
      if (++misses >= 4) return finish("The sign-in window was closed");
    } else if (Date.now() - started > startupMs) {
      return finish("The sign-in window did not start");
    }
    timer = setTimeout(() => { void tick(); }, interval);
  };
  void tick();

  return {
    port,
    next: () => new Promise<BrowserEvent>((resolve) => {
      const q = queue.shift();
      if (q) resolve(q); else waiter = resolve;
    }),
    open: async (url: string) => {
      for (const method of ["PUT", "GET"] as const) {
        try {
          // Percent-encode the whole address: DevTools cuts a raw one off at its first '&'
          // (Schwab then sees no client_id and answers invalid_client).
          const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method, signal: AbortSignal.timeout(3_000) });
          if (res.ok) return true;
        } catch { /* try the other verb, then give up */ }
      }
      return false;
    },
    close: async () => {
      stopped = true;
      waiter = null;
      if (timer) clearTimeout(timer);
      // Close the tabs first so the browser shuts down cleanly and keeps Schwab's
      // "remember this device" cookie; only then make sure the process is gone.
      const targets = (await listTargets(port)) ?? [];
      for (const t of targets) {
        if (t.type !== "page" || !t.id) continue;
        try { await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, { signal: AbortSignal.timeout(2_000) }); } catch { /* already gone */ }
      }
      for (let i = 0; i < 12 && (await listTargets(port)); i++) await new Promise((r) => setTimeout(r, 250));
      opts.process?.kill();
    },
  };
}

export function browserArgs(opts: { port: number; profileDir: string; url: string; extraArgs?: string[] }): string[] {
  return [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    ...(opts.extraArgs ?? []),
    opts.url, // last, and passed as ONE argument (no shell), so its '&'s survive
  ];
}

export async function openLoginBrowser(opts: LoginBrowserOptions): Promise<LoginBrowser> {
  const port = opts.port ?? (await freePort());
  const profileDir = opts.profileDir ?? loginProfileDir();
  mkdirSync(profileDir, { recursive: true });
  const child: ChildProcess = spawn(
    opts.browserPath,
    browserArgs({ port, profileDir, url: opts.url, extraArgs: opts.extraArgs }),
    { stdio: "ignore", windowsHide: false },
  );
  return watchDevTools({
    port,
    callbackUrl: opts.callbackUrl,
    intervalMs: opts.intervalMs,
    startupMs: opts.startupMs,
    process: {
      onError: (cb) => { child.once("error", cb); },
      kill: () => { if (child.exitCode === null && !child.killed) { try { child.kill(); } catch { /* already gone */ } } },
    },
  });
}
