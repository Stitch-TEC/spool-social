import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyRulesEvidence } from './rulesTestEvidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 2) throw new Error('Rules runner accepts no provider project or forwarded arguments');
if (process.platform === 'win32') throw new Error('Rules runner needs POSIX process groups (macOS/Linux) for owned-emulator cleanup');
if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing an inherited emulator; this runner owns a fresh local instance');
await mkdir(path.join(root, '.rules-test'), { recursive: true });
const evidenceDir = await mkdtemp(path.join(root, '.rules-test', 'run-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const config = path.join(evidenceDir, 'firebase.json'), reportFile = path.join(evidenceDir, 'vitest.json');
await writeFile(config, JSON.stringify({ firestore: { rules: path.join(root, 'firestore.rules') },
  emulators: { firestore: { host: '127.0.0.1', port }, ui: { enabled: false }, singleProjectMode: true } }));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const script = [process.execPath, path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
  '--root', root, '--reporter=default', '--reporter=json', '--outputFile', reportFile, 'firestore.rules.test.js'].map(quote).join(' ');
const inherited = Object.fromEntries(['PATH', 'HOME', 'JAVA_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'NPM_CONFIG_CACHE']
  .filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
const child = spawn('npx', ['--yes', 'firebase-tools@15.22.3', 'emulators:exec', '--only', 'firestore',
  '--project', 'demo-spool-rules', '--config', config, script], {
  cwd: evidenceDir, env: { ...inherited, SPOOL_RULES_PROJECT: 'demo-spool-rules', SPOOL_RULES_REQUIRED: '1', CI: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let output = '', timedOut = false, killTimer, interrupted;
function signalOwnedGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stopOwnedGroup() {
  if (killTimer) return;
  signalOwnedGroup('SIGTERM');
  killTimer = setTimeout(() => signalOwnedGroup('SIGKILL'), 1000);
}
const onInterrupt = () => { interrupted = 'SIGINT'; stopOwnedGroup(); };
const onTerminate = () => { interrupted = 'SIGTERM'; stopOwnedGroup(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  process.stdout.write(chunk); output += chunk.toString();
  if (output.length > 8 * 1024 * 1024) { output = output.slice(-8 * 1024 * 1024); timedOut = true; stopOwnedGroup(); }
});
const timeout = setTimeout(() => {
  timedOut = true;
  stopOwnedGroup();
}, 180_000);
let spawnError;
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); })
  .catch(error => { spawnError = String(error); return null; })
  .finally(async () => {
    clearTimeout(timeout); clearTimeout(killTimer);
    // Even spawn/CLI failures cannot leave the owned emulator descendants behind.
    signalOwnedGroup('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100));
    signalOwnedGroup('SIGKILL');
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  });
const log = await readFile(path.join(evidenceDir, 'firestore-debug.log'), 'utf8').catch(() => '');
const report = await readFile(reportFile, 'utf8').then(JSON.parse).catch(() => null);
const result = verifyRulesEvidence({ log, output, report, expectedFile: path.join(root, 'firestore.rules.test.js') });
if (exitCode !== 0 || timedOut || spawnError || interrupted) { result.ok = false; result.failures.push(`Emulator process exit ${exitCode}; timeout/output-overflow ${timedOut}; spawn error ${spawnError || 'none'}; interrupted ${interrupted || 'no'}`); }
await writeFile(path.join(evidenceDir, 'runner.log'), output);
await writeFile(path.join(evidenceDir, 'verification.json'), JSON.stringify({ ...result, exitCode, projectId: 'demo-spool-rules', port }, null, 2) + '\n');
console.log(`Rules evidence: ${evidenceDir}`);
if (!result.ok) console.error(`Rules verification failed:\n${result.failures.slice(0, 20).join('\n')}`);
process.exitCode = result.ok ? 0 : 1;
