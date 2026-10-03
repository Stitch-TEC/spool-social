import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { createAutomationStore } from './store.mjs';
import { openSyntheticDatabase } from './local-harness.mjs';
import { fixture, OWNER_A, LATER } from './fixtures.mjs';

// Fixed synthetic fixture; no arguments, environment, credentials or external I/O.
globalThis.fetch = () => { throw new Error('Network is forbidden in the synthetic pilot'); };
const local = openSyntheticDatabase();
try {
  const store = await createAutomationStore(local.db, OWNER_A);
  const timings = {};
  let start = performance.now();
  for (let n = 1; n <= 1000; n++) await store.create(fixture(n, { clientId: `synthetic-client-${n % 10}` }));
  timings.create1000Ms = performance.now() - start;
  start = performance.now();
  for (let n = 1; n <= 1000; n++) await store.get(fixture(n).id);
  timings.get1000Ms = performance.now() - start;
  start = performance.now();
  let rows = 0; let after = '';
  do {
    const page = await store.list({ limit: 200, after });
    rows += page.items.length; after = page.nextCursor;
  } while (after);
  timings.list1000Ms = performance.now() - start;
  start = performance.now();
  const due = await store.due(LATER, 200);
  timings.due200Ms = performance.now() - start;
  console.log(JSON.stringify({ scope: 'local RAM SQLite approximation; NOT Cloudflare edge or D1 performance',
    node: process.version, rows, dueRows: due.length,
    timings: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Number(value.toFixed(3))])) }, null, 2));
} finally { local.close(); }
