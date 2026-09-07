import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** A tiny D1 API approximation, NOT workerd or a Cloudflare compatibility attestation.
 * No filename/URL/env input: database lifetime is one process and storage is RAM only.
 */
export function openSyntheticDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() { return sqlite.prepare(sql).get(...params) ?? null; },
            async all() { return { success: true, results: sqlite.prepare(sql).all(...params) }; },
          };
        },
      };
    },
  };
  return { db, sqlite, close: () => sqlite.close() };
}
