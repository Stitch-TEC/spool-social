import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rulesEvaluationFailures, rulesExpectedDenialDiagnostics } from '../scripts/rulesTestEvidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = path.resolve(root, path.basename(path.dirname(root)) === '.worktrees' ? '../..' : '..');
if (path.basename(suite) !== 'Stitch TEC') throw new Error('Native evidence must remain inside the Stitch TEC suite');
const evidence = path.join(suite, '_archive-2026-10/spool-review-writer-fences-20261002/rules');
if (process.argv.length !== 2 || process.env.FIRESTORE_EMULATOR_HOST || process.platform === 'win32') {
  throw new Error('Runner accepts no forwarded arguments/inherited emulator and requires owned POSIX process groups');
}
await mkdir(evidence, { recursive: true });
const runDir = await mkdtemp(path.join(evidence, 'native-run-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const config = path.join(runDir, 'firebase.json');
await writeFile(config, JSON.stringify({ firestore: { rules: path.join(root, 'rules/review-details-overlay.rules') },
  emulators: { firestore: { host: '127.0.0.1', port }, ui: { enabled: false }, singleProjectMode: true } }));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const script = [process.execPath, path.join(root, 'rules/review-details-native.mjs')].map(quote).join(' ');
const inherited = Object.fromEntries(['PATH', 'HOME', 'JAVA_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'NPM_CONFIG_CACHE']
  .filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
const child = spawn('npx', ['--yes', 'firebase-tools@15.22.3', 'emulators:exec', '--only', 'firestore',
  '--project', 'demo-spool-review-fence', '--config', config, script], {
  cwd: runDir, env: { ...inherited, SPOOL_REVIEW_FENCE_REQUIRED: '1', SPOOL_REVIEW_FENCE_PROJECT: 'demo-spool-review-fence',
    SPOOL_REVIEW_FENCE_RUN_DIR: runDir, CI: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let output = '', timedOut = false, interrupted = null, killTimer;
const groupSignal = signal => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const stop = () => { if (killTimer) return; groupSignal('SIGTERM'); killTimer = setTimeout(() => groupSignal('SIGKILL'), 1000); };
const interrupt = () => { interrupted = 'SIGINT'; stop(); };
const terminate = () => { interrupted = 'SIGTERM'; stop(); };
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  process.stdout.write(chunk); output += chunk.toString();
  if (output.length > 8 * 1024 * 1024) { timedOut = true; stop(); }
});
const timer = setTimeout(() => { timedOut = true; stop(); }, 240_000);
let spawnError;
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); })
  .catch(error => { spawnError = String(error); return null; })
  .finally(async () => {
    clearTimeout(timer); clearTimeout(killTimer); groupSignal('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 100)); groupSignal('SIGKILL');
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  });
const log = await readFile(path.join(runDir, 'firestore-debug.log'), 'utf8').catch(() => '');
const report = await readFile(path.join(runDir, 'native-comparison.json'), 'utf8').then(JSON.parse).catch(() => null);
const diagnostics = rulesEvaluationFailures(`${log}\n${output}`);
const nativeFailure = !report || report.completedRequests !== report.plannedCases * 2 || report.failures?.length !== 0
  || !Array.isArray(report.results) || report.results.length !== report.completedRequests;
const processFailure = exitCode !== 0 || timedOut || spawnError || interrupted || !log.trim();
const runner = { status: nativeFailure || processFailure ? 'failed'
  : diagnostics.length ? 'policy_comparison_passed_native_evaluation_faults_block_activation' : 'strict_comparison_passed',
  activationAllowed: false, deploymentPerformed: false, authoringEnabled: false, projectId: 'demo-spool-review-fence', host: `127.0.0.1:${port}`,
  exitCode, timedOut, interrupted, spawnError: spawnError || null, nativeFailure, processFailure,
  evaluationFailures: diagnostics, expectedDenialDiagnostics: rulesExpectedDenialDiagnostics(`${log}\n${output}`),
  plannedCases: report?.plannedCases || 0, completedRequests: report?.completedRequests || 0,
  baselineSha256: report?.baselineSha256 || null, overlaySha256: report?.overlaySha256 || null,
  runnerLogSha256: createHash('sha256').update(output).digest('hex'), emulatorLogSha256: createHash('sha256').update(log).digest('hex') };
await writeFile(path.join(runDir, 'runner.log'), output, { mode: 0o600 });
await writeFile(path.join(runDir, 'verification.json'), JSON.stringify(runner, null, 2) + '\n', { mode: 0o600 });
await writeFile(path.join(evidence, 'latest-run.json'), JSON.stringify({ runDir, ...runner }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: runner.status, plannedCases: runner.plannedCases, completedRequests: runner.completedRequests,
  nativeFailure, processFailure, nativeEvaluationFaults: diagnostics.length, runDir }));
// A behavior-equivalent but evaluator-faulted baseline is NOT rules acceptance.
process.exitCode = runner.status === 'strict_comparison_passed' ? 0 : 1;
