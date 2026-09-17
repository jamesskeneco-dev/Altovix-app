import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Publishes the check's status.json so the phone app can read it.
 *
 * The app is a static page on GitHub Pages, so the PC pushes the file to a side branch ("status")
 * of the same repo through the GitHub API, and the app reads it from raw.githubusercontent.com.
 * `main` is never touched (no Pages rebuild, no diverging local clone). The repo is public, so
 * whatever is in status.json is public - it carries prices, rules and scores, never a secret.
 *
 * The GitHub key is a credential: it is typed into this PC's console by its owner and stored
 * OUTSIDE the repo folder (which sits in OneDrive) - never in chat, never in the repo.
 */

type Env = Record<string, string | undefined>;

export function tokenFile(platform: string = process.platform, env: Env = process.env): string {
  if (env["ALTOVIX_GITHUB_TOKEN_FILE"]) return env["ALTOVIX_GITHUB_TOKEN_FILE"];
  if (platform === "win32") return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Altovix", "github-token.txt");
  return join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "altovix", "github-token.txt");
}

export function readToken(env: Env = process.env): string | null {
  const fromEnv = env["ALTOVIX_GITHUB_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  const path = tokenFile(process.platform, env);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim() || null;
}

export function saveToken(token: string, env: Env = process.env): string {
  const path = tokenFile(process.platform, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
  return path;
}

/** owner/repo from the clone's own .git/config (https or ssh remote). */
export function repoFromGitConfig(text: string): { owner: string; repo: string } | null {
  const m = /url\s*=\s*(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:)([^/\s]+)\/([^\s]+?)(?:\.git)?\s*$/m.exec(text);
  return m && m[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

export function detectRepo(cwd: string = process.cwd(), env: Env = process.env): { owner: string; repo: string } | null {
  const forced = env["ALTOVIX_GITHUB_REPO"];
  if (forced && forced.includes("/")) { const [owner, repo] = forced.split("/") as [string, string]; return { owner, repo }; }
  const cfg = resolve(cwd, ".git", "config");
  return existsSync(cfg) ? repoFromGitConfig(readFileSync(cfg, "utf8")) : null;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "GitHubError"; this.status = status; }
}

export interface PublishOptions {
  owner: string; repo: string; token: string;
  content: string;
  branch?: string; path?: string; message?: string;
  apiBase?: string;
}

async function gh(o: PublishOptions, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${(o.apiBase ?? "https://api.github.com").replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${o.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "altovix-check", ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

const fail = (status: number, what: string, json: Record<string, unknown>): never => {
  const why = typeof json["message"] === "string" ? json["message"] : "no detail";
  const hint = status === 401 ? " - the GitHub key is wrong or has expired (run altovix-publish-setup.cmd again)"
    : status === 403 || status === 404 ? " - the GitHub key cannot write to this repository (it needs the public_repo permission)" : "";
  throw new GitHubError(status, `GitHub: ${what} failed (HTTP ${status}: ${why})${hint}`);
};

/** Who the key belongs to - used by setup to prove the key works before it is saved. */
export async function whoAmI(token: string, apiBase?: string): Promise<string> {
  const r = await gh({ owner: "", repo: "", token, content: "", apiBase }, "GET", "/user");
  if (r.status !== 200) fail(r.status, "checking the key", r.json);
  return String(r.json["login"] ?? "");
}

/** Creates the side branch the first time, then creates or updates the one file on it. */
export async function publishStatus(o: PublishOptions): Promise<{ created: boolean; commit: string }> {
  const branch = o.branch ?? "status", path = o.path ?? "status.json";
  const base = `/repos/${o.owner}/${o.repo}`;

  let ref = await gh(o, "GET", `${base}/git/ref/heads/${branch}`);
  if (ref.status === 404) {
    const repo = await gh(o, "GET", base);
    if (repo.status !== 200) fail(repo.status, "reading the repository", repo.json);
    const def = String(repo.json["default_branch"] ?? "main");
    const head = await gh(o, "GET", `${base}/git/ref/heads/${def}`);
    if (head.status !== 200) fail(head.status, `reading ${def}`, head.json);
    const sha = (head.json["object"] as { sha?: string } | undefined)?.sha;
    const made = await gh(o, "POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    if (made.status !== 201) fail(made.status, `creating the ${branch} branch`, made.json);
    ref = made;
  } else if (ref.status !== 200) fail(ref.status, `reading the ${branch} branch`, ref.json);

  const existing = await gh(o, "GET", `${base}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if (existing.status !== 200 && existing.status !== 404) fail(existing.status, `reading ${path}`, existing.json);
  const sha = existing.status === 200 ? String(existing.json["sha"] ?? "") : undefined;

  const put = await gh(o, "PUT", `${base}/contents/${path}`, {
    message: o.message ?? "status update", branch, sha,
    content: Buffer.from(o.content, "utf8").toString("base64"),
  });
  if (put.status !== 200 && put.status !== 201) fail(put.status, `writing ${path}`, put.json);
  return { created: put.status === 201, commit: String((put.json["commit"] as { sha?: string } | undefined)?.sha ?? "") };
}
