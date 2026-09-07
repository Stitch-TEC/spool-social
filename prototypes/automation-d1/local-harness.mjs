import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** A tiny D1 API approximation, NOT workerd or a Cloudflare compatibility attestation.
 * No filename/URL/env input: database lifetime is one process and storage is RAM only.
 */
export function openSyntheticDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const executions = new WeakMap();
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = {
            async first() { return sqlite.prepare(sql).get(...params) ?? null; },
            async all() { return { success: true, results: sqlite.prepare(sql).all(...params) }; },
          };
          executions.set(statement, () => ({ success: true, results: sqlite.prepare(sql).all(...params) }));
          return statement;
        },
      };
    },
    async batch(statements) {
      // Execute synchronously inside one local transaction to approximate D1.batch.
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => executions.get(statement)());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite, close: () => sqlite.close() };
}
