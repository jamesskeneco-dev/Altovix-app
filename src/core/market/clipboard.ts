import { execFile } from "node:child_process";

/**
 * Clipboard watcher for the Schwab login.
 *
 * Schwab's authorization code lives for about 30 seconds. Copy -> switch window -> paste ->
 * Enter is easy to fumble inside that window, so `login` also watches the clipboard: the moment
 * the redirected address (https://127.0.0.1:8182/?code=...) is copied in the browser, the login
 * continues on its own. Nothing is written to the clipboard and nothing else on it is kept:
 * text that does not look like the callback address is ignored.
 */

export type ClipboardReader = () => Promise<string>;

/** The OS command that prints the clipboard as text, or null where we have none. */
export function clipboardCommand(platform: string = process.platform): { cmd: string; args: string[] } | null {
  if (platform === "win32") {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"] };
  }
  if (platform === "darwin") return { cmd: "pbpaste", args: [] };
  return null;
}

/** Reads the clipboard once. Never throws - an unreadable clipboard is just "". */
export function systemClipboardReader(platform: string = process.platform): ClipboardReader | null {
  const command = clipboardCommand(platform);
  if (!command) return null;
  return () => new Promise<string>((resolve) => {
    execFile(command.cmd, command.args, { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve(err ? "" : String(out ?? ""));
    });
  });
}

/**
 * Pulls the callback address out of clipboard text. Tolerates surrounding whitespace, quotes,
 * and Edge's "[title](url)" link format. Returns null unless the text contains the callback
 * URL with a ?code= on it.
 */
export function findCallbackUrl(text: string, callbackUrl: string): string | null {
  if (!text) return null;
  let origin: string;
  try { origin = new URL(callbackUrl).origin.toLowerCase(); } catch { return null; }
  const candidates = text.match(/https?:\/\/[^\s"'<>()\[\]]+/gi) ?? [];
  for (const raw of candidates) {
    try {
      const u = new URL(raw);
      if (u.origin.toLowerCase() === origin && u.searchParams.get("code")) return raw;
    } catch { /* not a URL - keep looking */ }
  }
  return null;
}

export interface ClipboardWatch {
  /** Resolves with the next NEW callback address copied to the clipboard. Never rejects. */
  next(): Promise<string>;
  /** Stops polling. A pending next() never resolves after this. */
  stop(): void;
}

/**
 * Polls the clipboard. Whatever is on it when the watch starts is ignored (it is usually the
 * expired address from the previous attempt), and each address is reported once.
 */
export function watchClipboard(opts: { callbackUrl: string; read: ClipboardReader; intervalMs?: number }): ClipboardWatch {
  const interval = opts.intervalMs ?? 700;
  const seen = new Set<string>();
  let primed = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiter: ((url: string) => void) | null = null;
  const queue: string[] = [];

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let text = "";
    try { text = await opts.read(); } catch { text = ""; }
    if (stopped) return;
    const url = findCallbackUrl(text, opts.callbackUrl);
    if (!primed) {
      primed = true;
      if (url) seen.add(url);
    } else if (url && !seen.has(url)) {
      seen.add(url);
      if (waiter) { const w = waiter; waiter = null; w(url); } else queue.push(url);
    }
    timer = setTimeout(() => { void tick(); }, interval);
  };
  void tick();

  return {
    next: () => new Promise<string>((resolve) => {
      const q = queue.shift();
      if (q !== undefined) resolve(q); else waiter = resolve;
    }),
    stop: () => {
      stopped = true;
      waiter = null;
      if (timer) clearTimeout(timer);
    },
  };
}
