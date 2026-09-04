import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, "../../db/schema.sql");

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  handle = new DatabaseSync(config.dbPath);
  handle.exec("PRAGMA foreign_keys = ON;");
  return handle;
}

/** Idempotent: safe to call on every boot. */
export function migrate(target?: DatabaseSync): void {
  const conn = target ?? db();
  conn.exec(readFileSync(SCHEMA_PATH, "utf8"));
}

/** Used by tests to get a throwaway in-memory database. */
export function memoryDb(): DatabaseSync {
  const conn = new DatabaseSync(":memory:");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec(readFileSync(SCHEMA_PATH, "utf8").replace(/PRAGMA journal_mode = WAL;/, ""));
  return conn;
}

export function all<T>(conn: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return conn.prepare(sql).all(...(params as never[])) as T[];
}

export function one<T>(conn: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return conn.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(conn: DatabaseSync, sql: string, ...params: unknown[]): { lastInsertRowid: number; changes: number } {
  const r = conn.prepare(sql).run(...(params as never[]));
  return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

/** All-or-nothing wrapper. SQLite is synchronous here, so this stays simple. */
export function tx<T>(conn: DatabaseSync, fn: () => T): T {
  conn.exec("BEGIN");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}
