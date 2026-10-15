import { createFailureDiagnosticDecoder } from './test-failure-diagnostic.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readBounded, parseJson, sha256 } from './io.mjs';
import { createRuntimeDatabases, isDisposableDatabaseUrl } from './runtime-databases.mjs';
import { verificationEnvironment } from './process-env.mjs';
import { RUNTIME_SUITES, FULL_RUNTIME_BASELINE, NODE_CONSUMER_SUITES, FIXED_NODE_SUITES } from './runtime-suites.mjs';
import { PINNED_SUITES } from './pinned-suites.mjs';
import { RUNTIME_FILE_WEIGHTS, DEFAULT_RUNTIME_FILE_WEIGHT } from './runtime-file-weights.mjs';

import { createProgressDecoder } from './test-reporter.mjs';

const MAX_OUTPUT = 16_000_000, MAX_FILES = 512;
const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];
const reporter = fileURLToPath(new URL('./test-reporter.mjs', import.meta.url));
const result = (id, status, reason) => ({ check_id: id, status, reason });

export { isDisposableDatabaseUrl } from './runtime-databases.mjs';

async function suiteFiles(root, id) {
  let files;
  if (id === 'governance.unit') {
    files = (await readdir(resolve(root, 'packages/contribution-tools/test')))
      .filter(name => /^[a-z][a-z0-9-]*\.test\.mjs$/.test(name)).sort()
      .map(name => 'packages/contribution-tools/test/' + name);
  } else if (Object.hasOwn(NODE_CONSUMER_SUITES, id)) {
    const { directory, baseline } = NODE_CONSUMER_SUITES[id];
    const found = (await readdir(resolve(root, directory)))
      .filter(name => /^[a-z][a-z0-9_-]*\.test\.mjs$/.test(name)).map(name => directory + '/' + name);
    files = [...new Set([...baseline, ...found])].sort();
  } else if (Object.hasOwn(FIXED_NODE_SUITES, id)) {
    files = [...FIXED_NODE_SUITES[id]];
  } else if (id === 'runtime.full') {
    const found = (await readdir(resolve(root, 'tests/runtime')))
      .filter(name => /^[a-z][a-z0-9_-]*\.test\.ts$/.test(name)).map(name => 'tests/runtime/' + name);
    files = [...new Set([...FULL_RUNTIME_BASELINE, ...found])].sort();
  } else files = RUNTIME_SUITES[id];
  if (files.length > MAX_FILES) throw new Error('file_limit');
  for (const path of files) await readBounded(root, path);
  return files;
}

// No shell, package hooks, inherited NODE_OPTIONS, test context, credentials,
// or default database URL. Kill the isolated process group on POSIX timeout.
async function execute(root, files, loader, extraEnv, timeoutMs, signal) {
  const diagnosticEpoch = performance.now();
  let sources = [], sourceBytes = 0;
  try {
    for (const path of files) {
      const bytes = await readBounded(root,path); sourceBytes += bytes.length;
      if (sourceBytes > 32_000_000) throw Error('progress_source_limit');
      sources.push({path,source_sha256:sha256(bytes),source_lines:bytes.toString('utf8').split('\n').length});
    }
  } catch { sources = []; /* progress is optional, never final result evidence */ }
  return new Promise(done => {
    let loaderPath;
    try { if (loader === 'tsx') loaderPath = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href; }
    catch { done({ reason: 'runtime_loader_unavailable' }); return; }
    const args = [...(loader === 'tsx' ? ['--import', loaderPath] : []), '--test', '--test-concurrency=1',
      '--test-reporter=' + reporter, ...files];
    const env = verificationEnvironment();
    if (extraEnv) Object.assign(env, extraEnv);
    if (sources.length === files.length) env.FREEDOM_TEST_PROGRESS_FILES = JSON.stringify(files);
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, args, { cwd: root, env, detached: group, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const diagnostic = record => { try { process.stderr.write('freedom.test-progress ' + JSON.stringify(record) + '\n'); } catch { /* diagnostics never affect admission */ } };
    const progress = sources.length === files.length ? createProgressDecoder(sources, diagnostic) : {
      push() {}, finish: () => ({schema:'freedom.test-file-progress-summary/v1',selected_count:files.length,started_count:0,completed_count:0,incomplete:true}),
    };
    child.stdio[3].on('data', bytes => progress.push(bytes));
    child.stdio[3].on('error', () => {});
    const failureDiagnostic=createFailureDiagnosticDecoder(sources,record=>{try{process.stderr.write('freedom.test-failure-diagnostic '+JSON.stringify(record)+'\n');}catch{}});
    child.stdio[4].on('data',bytes=>failureDiagnostic.push(bytes));
    child.stdio[4].on('error',()=>{});
    let size = 0, output = [], reason;
    const stop = code => {
      reason ??= code;
      try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const abort = () => stop('test_cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('test_timeout'), Math.max(1,timeoutMs - (performance.now() - diagnosticEpoch)));
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > MAX_OUTPUT) stop('test_output_limit');
      else output.push(bytes);
    });
    child.stderr.on('data', bytes => { size += bytes.length; if (size > MAX_OUTPUT) stop('test_output_limit'); });
    child.on('error', () => { reason ??= 'test_process_failed'; });
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer);
      diagnostic(progress.finish());
      signal?.removeEventListener('abort', abort);
      done({ output: Buffer.concat(output), reason, exit_code: code, termination_signal: terminationSignal, failed: code !== 0 || terminationSignal !== null });
    });
  });
}

function countsValid(counts) {
  return counts && COUNT_KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && Number.isSafeInteger(counts.suites) && counts.suites >= 0
    && counts.tests === COUNT_KEYS.slice(1).reduce((sum, key) => sum + counts[key], 0);
}

function evidenceFor(raw, files) {
  const expected = new Set(files), seen = new Set(), ids = new Set();
  if (typeof raw.success !== 'boolean' || !countsValid(raw.counts) || !Array.isArray(raw.files)
    || raw.files.length !== files.length || !Array.isArray(raw.cases) || !Array.isArray(raw.suites)) return;
  const evidence = [];
  for (const item of raw.files) {
    if (!expected.has(item.file) || seen.has(item.file) || typeof item.success !== 'boolean' || !countsValid(item.counts)) return;
    seen.add(item.file);
    const cases = raw.cases.filter(entry => entry.file === item.file);
    const suites = raw.suites.filter(entry => entry.file === item.file);
    if (cases.length !== item.counts.tests || cases.length > 20_000 || suites.length !== item.counts.suites || suites.length > 20_000) return;
    for (const entry of [...cases, ...suites]) {
      if (!/^[a-f0-9]{64}$/.test(entry.case_sha256) || !COUNT_KEYS.slice(1).includes(entry.status) || ids.has(entry.case_sha256)) return;
      ids.add(entry.case_sha256);
    }
    if (COUNT_KEYS.slice(1).some(key => item.counts[key] !== cases.filter(entry => entry.status === key).length)) return;
    evidence.push({ path: item.file, counts: Object.fromEntries(COUNT_KEYS.map(key => [key, item.counts[key]])),
      cases: cases.map(({ case_sha256, status }) => ({ case_sha256, status })),
      suite_events: suites.map(({ case_sha256, status }) => ({ case_sha256, status })) });
  }
  if ([...raw.cases, ...raw.suites].some(item => !expected.has(item.file))
    || raw.counts.suites !== raw.suites.length
    || COUNT_KEYS.some(key => raw.counts[key] !== evidence.reduce((n, file) => n + file.counts[key], 0))) return;
  return evidence.sort((a, b) => a.path.localeCompare(b.path));
}

// Only runRuntimePartition passes a larger cap; caller options cannot raise it.
async function runGroup(root, selections, runtime, options, cap = runtime ? 900_000 : 60_000) {
  const files = [...new Set(selections.flatMap(item => item.files))].sort();
  const timeout = options.timeoutMs ?? cap;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > cap) {
    return selections.map(({ id }) => result(id, 'not_run', 'invalid_suite_timeout'));
  }
  const full = runtime && selections.some(item => item.id === 'runtime.full');
  const shardCount = full ? (options.runtimeShards ?? 4) : 1;
  if (![1, 2, 4].includes(shardCount) || (!runtime && shardCount !== 1 && options.runtimeShards !== undefined)) {
    return selections.map(({ id }) => result(id, 'not_run', 'invalid_runtime_shards'));
  }
  if (runtime && shardCount > 1) return runSharded(root, selections, files, options, timeout, shardCount);
  const ran = await execute(root, files, runtime ? 'tsx' : 'node', runtime ? { TEST_DATABASE_URL: options.testDatabaseUrl } : {}, timeout, options.signal);
  const failure = reason => selections.map(({ id, files: selected_files }) => ({
    ...result(id, reason === 'runtime_loader_unavailable' ? 'not_run' : 'failed', reason), selected_files,
  }));
  if (ran.reason) return failure(ran.reason).map(item => ({ ...item, evidence_sha256: sha256(ran.output ?? Buffer.alloc(0)) }));
  let raw, evidence;
  try { raw = parseJson(ran.output, { maxBytes: MAX_OUTPUT, maxNodes: 500_000 }); evidence = evidenceFor(raw, files); }
  catch { return failure('invalid_test_results'); }
  if (!evidence) return failure('incomplete_test_results');
  const evidence_sha256 = sha256(ran.output);
  return selections.map(({ id, files: selected }) => {
    const test_files = evidence.filter(item => selected.includes(item.path));
    const test_count = test_files.reduce((count, item) => count + item.counts.tests, 0);
    // Any process-level failure fails the batch, even if one subset passed.
    const passed = !ran.failed && raw.success && raw.files.every(file => file.success)
      && test_files.every(file => file.counts.tests > 0 && file.counts.tests === file.counts.passed
        && file.suite_events.every(event => event.status === 'passed'));
    return { ...result(id, passed ? 'passed' : 'failed', passed ? 'tests_executed' : ran.failed ? 'test_process_failed' : 'incomplete_test_results'),
      test_count, evidence_sha256, selected_files: selected, test_files };
  });
}

// Deterministic longest-estimated-first allocation, then original file order
// within each serial process. Full local runner and matrix producer/aggregate
// use this same function; no selected file is dropped or split.
export function partitionRuntimeFiles(files, count) {
  if (![1, 2, 4, 6].includes(count) || files.length < count || new Set(files).size !== files.length) throw Error('invalid_runtime_partition');
  const loads = Array(count).fill(0), assignments = new Map();
  const ordered = files.map((path, index) => ({path, index, weight: RUNTIME_FILE_WEIGHTS[path] ?? DEFAULT_RUNTIME_FILE_WEIGHT}))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const {path, weight} of ordered) {
    let target = 0;
    for (let i = 1; i < count; i++) if (loads[i] < loads[target]) target = i;
    assignments.set(path, target); loads[target] += weight;
  }
  return Array.from({ length: count }, (_, index) => files.filter(path => assignments.get(path) === index));
}

async function runSharded(root, selections, files, options, timeout, count) {
  const deadline = performance.now() + timeout;
  let databases, partitions, shards = [], cleanup = false;
  let reason;
  try {
    partitions = partitionRuntimeFiles(files, count);
    databases = await createRuntimeDatabases(options.testDatabaseUrl, count,
      Math.max(1, Math.min(20_000, Math.floor(deadline - performance.now() - 24_000))));
    // Reserve bounded cleanup time within the original global budget.
    const remaining = deadline - performance.now() - 24_000;
    if (remaining <= 0 || options.signal?.aborted) reason = options.signal?.aborted ? 'test_cancelled' : 'test_timeout';
    else shards = await Promise.all(partitions.map(async (selected, index) => {
      const ran = await execute(root, selected, 'tsx', { TEST_DATABASE_URL: databases.urls[index] }, remaining, options.signal);
      let raw, evidence;
      if (!ran.reason) try {
        raw = parseJson(ran.output, { maxBytes: MAX_OUTPUT, maxNodes: 500_000 });
        evidence = evidenceFor(raw, selected);
      } catch { /* invalid evidence fails closed */ }
      return { selected_files: selected, evidence_sha256: sha256(ran.output ?? Buffer.alloc(0)),
        ...(Number.isInteger(ran.exit_code) ? { exit_code: ran.exit_code } : {}),
        ...(ran.termination_signal ? { termination_signal: ran.termination_signal } : {}),
        reason: ran.reason ?? (!evidence ? 'incomplete_test_results' : ran.failed || !raw.success || raw.files.some(file => !file.success) ? 'test_process_failed' : 'tests_executed'),
        ...(evidence ? { test_files: evidence } : {}) };
    }));
  } catch (error) { reason = 'runtime_database_provision_failed'; cleanup = error.cleanupVerified === true; }
  finally { if (databases) cleanup = await databases.cleanup(); }
  if (databases && !cleanup) reason = 'runtime_database_cleanup_failed';
  if (performance.now() > deadline) reason = 'test_timeout';
  reason ??= shards.find(shard => shard.reason !== 'tests_executed')?.reason;
  const evidence = shards.flatMap(shard => shard.test_files ?? []).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const covered = evidence.map(file => file.path);
  const cases = evidence.flatMap(file => [...file.cases, ...file.suite_events].map(event => event.case_sha256));
  if (!reason && (JSON.stringify(covered) !== JSON.stringify(files) || new Set(cases).size !== cases.length)) reason = 'incomplete_test_results';
  if (!reason && evidence.some(file => file.counts.tests === 0 || file.counts.tests !== file.counts.passed || file.suite_events.some(event => event.status !== 'passed'))) reason = 'incomplete_test_results';
  const evidence_sha256 = sha256(Buffer.from(JSON.stringify(shards.map(shard => ({ selected_files: shard.selected_files, evidence_sha256: shard.evidence_sha256 })))));
  if (performance.now() > deadline) reason = 'test_timeout';
  return selections.map(({ id, files: selected }) => {
    const test_files = evidence.filter(file => selected.includes(file.path));
    return { ...result(id, reason ? 'failed' : 'passed', reason ?? 'tests_executed'),
      selected_files: selected, ...(test_files.length ? { test_files } : {}), test_count: test_files.reduce((sum, file) => sum + file.counts.tests, 0),
      evidence_sha256, shards, database_cleanup_verified: cleanup };
  });
}

export async function runLocalSuites(root, ids, options = {}) {
  const results = new Map(), governance = [], fixedNode = [], runtime = [];
  for (const id of [...new Set(ids)].sort()) {
    const isRuntime = id === 'runtime.full' || Object.hasOwn(RUNTIME_SUITES, id);
    const isFixedNode = Object.hasOwn(FIXED_NODE_SUITES, id);
    if (id !== 'governance.unit' && !isRuntime && !Object.hasOwn(NODE_CONSUMER_SUITES, id) && !isFixedNode) { results.set(id, result(id, 'not_run', 'suite_adapter_unavailable')); continue; }
    if (isRuntime && !isDisposableDatabaseUrl(options.testDatabaseUrl)) {
      results.set(id, result(id, 'not_run', options.testDatabaseUrl === undefined ? 'test_database_required' : 'test_database_rejected')); continue;
    }
    let files;
    try { files = await suiteFiles(root, id); }
    catch { results.set(id, result(id, 'not_run', 'suite_files_unavailable')); continue; }
    if (!files.length) { results.set(id, { ...result(id, 'failed', 'empty_test_set'), test_count: 0 }); continue; }
    (isRuntime ? runtime : isFixedNode ? fixedNode : governance).push({ id, files });
  }
  // Fixed-file suites stay in their own non-runtime group so they keep the
  // 60-second budget and a planner failure does not fail governance.unit.
  for (const [selected, isRuntime] of [[governance, false], [fixedNode, false], [runtime, true]]) {
    if (selected.length) for (const item of await runGroup(root, selected, isRuntime, isRuntime ? options : { ...options, runtimeShards: 1 })) results.set(item.check_id, item);
  }
  return [...results.values()].sort((a, b) => a.check_id.localeCompare(b.check_id));
}

export async function runLocalSuite(root, id, options = {}) {
  return (await runLocalSuites(root, [id], options))[0];
}

const PINNED_OPTION_KEYS = Object.freeze(['testDatabaseUrl', 'env', 'timeoutMs', 'signal']);

async function runPytestSuiteDefinition(root, id, files, suite, extraEnv, timeoutMs, options) {
  const deadline = performance.now() + timeoutMs;
  const failure = (reason, evidence_reason) => ({ ...result(id, 'failed', reason),
    selected_files: files, test_count: 0, ...(evidence_reason ? { evidence_reason } : {}) });
  let temp;
  try {
    temp = await mkdtemp(join(tmpdir(), 'fp-pinned-'));
    const junit = join(temp, 'junit.xml'), expected = join(temp, 'expected.json');
    await writeFile(expected, JSON.stringify(files));
    const config = join(temp, 'pytest.ini');
    await writeFile(config, '[pytest]\n');
    const args = ['-I', '-B', '-m', 'pytest', '-q', '-c', config, '--rootdir', resolve(root), '--noconftest',
      '-p', 'no:cacheprovider', '-o', 'junit_family=xunit1', '--junitxml', junit, ...files];
    // The environment allowlist already excludes PYTEST_ADDOPTS and PYTEST_PLUGINS.
    const env = { ...verificationEnvironment(), ...extraEnv, PYTHONDONTWRITEBYTECODE: '1', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' };
    if (options.signal?.aborted) return failure('test_cancelled');
    if (performance.now() >= deadline) return failure('test_timeout');
    const ran = await new Promise(done => {
      const group = process.platform !== 'win32';
      const child = spawn('python3', args, { cwd: root, env, detached: group, stdio: 'ignore' });
      let reason;
      const stop = code => {
        reason ??= code;
        try { if (group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
      };
      const abort = () => stop('test_cancelled');
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(() => stop('test_timeout'), Math.max(1, deadline - performance.now()));
      child.once('error', () => { reason ??= 'test_process_failed'; });
      child.once('close', (code, terminationSignal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        done({ reason, failed: code !== 0 || terminationSignal !== null });
      });
    });
    if (ran.reason || ran.failed) return failure(ran.reason ?? 'test_process_failed');
    if (options.signal?.aborted) return failure('test_cancelled');
    if (performance.now() >= deadline) return failure('test_timeout');
    const helperPath = fileURLToPath(new URL('../../scripts/ci/pinned_pytest_evidence.py', import.meta.url));
    const helper = spawnSync('python3', ['-I', helperPath, '--junit', junit, '--expected', expected],
      { cwd: root, env: verificationEnvironment(), encoding: 'utf8',
        timeout: Math.max(1, Math.min(30000, Math.floor(deadline - performance.now()))), maxBuffer: MAX_OUTPUT });
    if (performance.now() >= deadline) return failure('test_timeout');
    let parsed;
    try { parsed = parseJson(Buffer.from(helper.stdout ?? ''), { maxBytes: MAX_OUTPUT, maxNodes: 500_000 }); }
    catch { return failure('invalid_test_results'); }
    if (parsed.ok === false) return failure('incomplete_test_results',
      typeof parsed.reason === 'string' && /^[a-z_]+$/.test(parsed.reason) ? parsed.reason : 'invalid_evidence_reason');
    if (helper.status !== 0 || parsed.ok !== true || !Array.isArray(parsed.files)
      || !Number.isSafeInteger(parsed.total) || parsed.total < 1) return failure('incomplete_test_results');
    const test_files = parsed.files.map(file => ({ path: file.path,
      counts: { tests: file.tests, passed: file.passed, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
      cases: file.cases, suite_events: [] }));
    const ids = new Set();
    if (JSON.stringify(test_files.map(file => file.path)) !== JSON.stringify(files)
      || test_files.some(file => !Number.isSafeInteger(file.counts.tests) || file.counts.tests < 1
        || file.counts.tests !== file.counts.passed || !Array.isArray(file.cases)
        || file.cases.length !== file.counts.tests || file.cases.some(entry => {
          if (!entry || entry.status !== 'passed' || !/^[a-f0-9]{64}$/.test(entry.case_sha256) || ids.has(entry.case_sha256)) return true;
          ids.add(entry.case_sha256); return false;
        })) || parsed.total !== ids.size) return failure('incomplete_test_results');
    return { ...result(id, 'passed', 'tests_executed'), test_count: parsed.total,
      evidence_sha256: sha256(Buffer.from(helper.stdout)), selected_files: files, test_files };
  } catch {
    return failure('incomplete_test_results');
  } finally {
    if (temp) try { await rm(temp, { recursive: true, force: true }); }
    catch { return failure('incomplete_test_results'); }
  }
}

export async function runPinnedSuiteDefinition(root, id, suite, options = {}) {
  for (const key of Object.keys(options)) {
    if (!PINNED_OPTION_KEYS.includes(key)) return result(id, 'not_run', 'invalid_pinned_suite_options');
  }

  if (!suite || typeof suite !== 'object' || !Object.isFrozen(suite)) {
    return result(id, 'not_run', 'suite_adapter_unavailable');
  }

  const allowedSuiteKeys = ['files', 'directory', 'directories', 'pattern', 'baseline', 'loader', 'database', 'timeoutMs', 'env'];
  for (const key of Object.keys(suite)) {
    if (!allowedSuiteKeys.includes(key)) return result(id, 'not_run', 'suite_adapter_unavailable');
  }

  const directoryKeys = ['directory', 'directories', 'pattern', 'baseline'].filter(key => Object.hasOwn(suite, key));
  const validShape = Object.hasOwn(suite, 'files')
    ? directoryKeys.length === 0 && Array.isArray(suite.files)
    : (directoryKeys.length === 3 && typeof suite.directory === 'string' && suite.pattern instanceof RegExp && Array.isArray(suite.baseline)) ||
      (directoryKeys.length === 3 && Array.isArray(suite.directories) && suite.directories.length > 0 && suite.directories.every(d => typeof d === 'string') && suite.pattern instanceof RegExp && Array.isArray(suite.baseline) && suite.baseline.every(f => suite.directories.some(d => f.startsWith(d + '/'))));
  if (!validShape) return result(id, 'not_run', 'suite_adapter_unavailable');

  let files = [];
  if (suite.files) {
    files = [...suite.files];
  } else {
    const dirs = suite.directories || [suite.directory];
    try {
      const foundFiles = [];
      for (const dir of dirs) {
        const found = await readdir(resolve(root, dir));
        foundFiles.push(...found.filter(name => suite.pattern.test(name)).map(name => dir + '/' + name));
      }
      files = [...new Set([...suite.baseline, ...foundFiles])].sort();
    } catch {
      return result(id, 'not_run', 'suite_files_unavailable');
    }
  }

  files = [...new Set(files)].sort();
  if (files.length > MAX_FILES) return result(id, 'not_run', 'suite_files_unavailable');

  try {
    for (const path of files) {
      await readBounded(root, path);
    }
  } catch {
    return result(id, 'not_run', 'suite_files_unavailable');
  }

  if (files.length === 0) return { ...result(id, 'failed', 'empty_test_set'), test_count: 0, selected_files: files };

  if (suite.database) {
    if (!isDisposableDatabaseUrl(options.testDatabaseUrl)) {
      return result(id, 'not_run', options.testDatabaseUrl === undefined ? 'test_database_required' : 'test_database_rejected');
    }
  }

  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : suite.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > suite.timeoutMs) {
    return result(id, 'not_run', 'invalid_suite_timeout');
  }

  const extraEnv = {};
  if (suite.database) {
    extraEnv.TEST_DATABASE_URL = options.testDatabaseUrl;
  }
  if (suite.env && options.env) {
    for (const name of suite.env) {
      if (options.env[name] !== undefined) extraEnv[name] = options.env[name];
    }
  }

  if (suite.loader === 'pytest') {
    return runPytestSuiteDefinition(root, id, files, suite, extraEnv, timeoutMs, options);
  }

  const ran = await execute(root, files, suite.loader, extraEnv, timeoutMs, options.signal);
  const failure = reason => ({
    ...result(id, reason === 'runtime_loader_unavailable' ? 'not_run' : 'failed', reason),
    selected_files: files,
  });
  if (ran.reason) return { ...failure(ran.reason), evidence_sha256: sha256(ran.output ?? Buffer.alloc(0)) };

  let raw, evidence;
  try {
    raw = parseJson(ran.output, { maxBytes: MAX_OUTPUT, maxNodes: 500_000 });
    evidence = evidenceFor(raw, files);
  } catch {
    return failure('invalid_test_results');
  }
  if (!evidence) return failure('incomplete_test_results');

  const evidence_sha256 = sha256(ran.output);
  const test_count = evidence.reduce((count, item) => count + item.counts.tests, 0);

  const passed = !ran.failed && raw.success && raw.files.every(file => file.success)
      && evidence.every(file => file.counts.tests > 0 && file.counts.tests === file.counts.passed
        && file.suite_events.every(event => event.status === 'passed'));

  return {
    ...result(id, passed ? 'passed' : 'failed', passed ? 'tests_executed' : ran.failed ? 'test_process_failed' : 'incomplete_test_results'),
    test_count,
    evidence_sha256,
    selected_files: files,
    test_files: evidence
  };
}

export async function runPinnedSuite(root, id, options = {}) {
  for (const key of Object.keys(options)) {
    if (!PINNED_OPTION_KEYS.includes(key)) return result(id, 'not_run', 'invalid_pinned_suite_options');
  }

  const suite = PINNED_SUITES[id];
  if (!suite) return result(id, 'not_run', 'suite_adapter_unavailable');

  return runPinnedSuiteDefinition(root, id, suite, options);
}

const PARTITION_SCHEMA = 'freedom.runtime-partition/v1';
// Finite matrix capacity, including provisioning and verified cleanup. Hosted
// observations on 2026-10-15 put the same 55 files about 20% slower and the
// projected full partition beyond 1,224s. Keep legacy four-partition behavior;
// six hosts get 1,500s including the unchanged 24s cleanup reserve.
const PARTITION_BUDGET_MS = Object.freeze({ 4: 1_200_000, 6: 1_500_000 });
// Queueing can serialize all six hosts: allow six full partition budgets plus
// 30 minutes of bounded queue gaps. CI scopes artifacts to one run attempt;
// this wall span does not extend any partition's execution/cleanup deadline.
const MATRIX_WINDOW_MS = Object.freeze({ 4: 1_800_000, 6: 6 * 1_500_000 + 1_800_000 });
const identical = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strictKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function partitionCheck(value, code) { if (!value) throw Error(code); }

export async function runtimeSourceManifest(root) {
  const git = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, env: verificationEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  const candidate_commit = git.stdout?.trim();
  const clean = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {cwd:root,env:verificationEnvironment(),timeout:5000,maxBuffer:4096});
  partitionCheck(clean.status === 0, 'runtime_source_changed');
  partitionCheck(git.status === 0 && /^[a-f0-9]{40}$/.test(candidate_commit), 'runtime_candidate_unavailable');
  const files = await suiteFiles(root, 'runtime.full');
  const full_source_manifest = [];
  for (const path of files) full_source_manifest.push({ path, source_sha256: sha256(await readBounded(root, path)) });
  return { candidate_commit, full_source_manifest,
    manifest_sha256: sha256(Buffer.from(JSON.stringify(full_source_manifest))) };
}

// A matrix fragment is never a runtime.full result. Own one fresh nonce DB and
// one serial test process, including provisioning/cleanup inside its partition budget.
export async function runRuntimePartition(root, options = {}) {
  const count = options.partitionCount;
  partitionCheck([4, 6].includes(count) && Number.isInteger(options.partitionIndex) &&
    options.partitionIndex >= 0 && options.partitionIndex < count, 'invalid_runtime_partition');
  partitionCheck(Object.keys(options).every(key => ['partitionCount','partitionIndex','testDatabaseUrl','signal'].includes(key)), 'invalid_runtime_partition_options');
  const budget = PARTITION_BUDGET_MS[count];
  const started_at = new Date().toISOString(), deadline = performance.now() + budget;
  const source = await runtimeSourceManifest(root);
  const selected = partitionRuntimeFiles(source.full_source_manifest.map(file => file.path), count)[options.partitionIndex];
  const check_id = `runtime.partition.${options.partitionIndex}`;
  let databases, cleanup = false, report;
  try {
    partitionCheck(isDisposableDatabaseUrl(options.testDatabaseUrl), 'test_database_rejected');
    databases = await createRuntimeDatabases(options.testDatabaseUrl, 1, Math.max(1, Math.min(20_000, Math.floor(deadline - performance.now() - 24_000))));
    const remaining = Math.floor(deadline - performance.now() - 24_000);
    if (remaining <= 0) throw Error('test_timeout');
    [report] = await runGroup(root, [{id: check_id, files: selected}], true,
      {testDatabaseUrl: databases.urls[0], timeoutMs: remaining, runtimeShards: 1, signal: options.signal}, budget);
  } catch (error) {
    cleanup = error.cleanupVerified === true;
    const allowed = ['test_database_rejected','test_timeout'];
    report = result(check_id, 'failed', allowed.includes(error.message) ? error.message : 'runtime_database_provision_failed');
  } finally { if (databases) cleanup = await databases.cleanup(); }
  report = { ...report, selected_files: selected, database_cleanup_verified: cleanup };
  if (!cleanup) report = { ...report, status: 'failed', reason: 'runtime_database_cleanup_failed' };
  try { if (!identical(source, await runtimeSourceManifest(root))) report = {...report,status:'failed',reason:'runtime_source_changed'}; }
  catch { report = {...report,status:'failed',reason:'runtime_source_changed'}; }
  if (performance.now() > deadline) report = {...report,status:'failed',reason:'test_timeout'};
  return { schema: PARTITION_SCHEMA, check_id, partition_index: options.partitionIndex, partition_count: count,
    ...source, started_at, ended_at: new Date().toISOString(), database_cleanup_verified: cleanup, report };
}

/** Diagnostic candidate artifacts are untrusted. Recompute selection and reject
 * incomplete evidence; passing aggregation does not authenticate a host gate. */
export async function aggregateRuntimePartitions(root, fragments, options = {}) {
  const failure = reason => ({check_id:'runtime.full',status:'failed',reason,gate_enforced:false,merge_authorized:false});
  try {
    partitionCheck(Object.keys(options).every(key => ['partitionCount'].includes(key)) && [4, 6].includes(options.partitionCount ?? 4), 'runtime_partition_options_invalid');
    const numPartitions = options.partitionCount ?? 4;
    partitionCheck(Array.isArray(fragments) && fragments.length === numPartitions, 'runtime_partitions_missing');
    const source = await runtimeSourceManifest(root);
    const partitions = partitionRuntimeFiles(source.full_source_manifest.map(file => file.path), numPartitions);
    const seen = new Set(), identities = new Set(); let started = Infinity, ended = -Infinity;
    const files = [], ordered = [];
    for (const fragment of fragments) {
      partitionCheck(strictKeys(fragment, ['schema','check_id','partition_index','partition_count','candidate_commit','full_source_manifest','manifest_sha256','started_at','ended_at','database_cleanup_verified','report']), 'runtime_partition_schema');
      const index = fragment.partition_index;
      partitionCheck(fragment.schema === PARTITION_SCHEMA && fragment.partition_count === numPartitions && Number.isInteger(index) && index >= 0 && index < numPartitions && !seen.has(index), 'runtime_partition_identity');
      seen.add(index);
      partitionCheck(fragment.check_id === `runtime.partition.${index}` && fragment.candidate_commit === source.candidate_commit &&
        fragment.manifest_sha256 === source.manifest_sha256 && identical(fragment.full_source_manifest, source.full_source_manifest), 'runtime_partition_source_mismatch');
      for (const [key, value] of [['started_at',fragment.started_at],['ended_at',fragment.ended_at]]) {
        const timestamp = Date.parse(value);
        partitionCheck(typeof value === 'string' && Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value, 'runtime_partition_clock');
        if (key === 'started_at') started = Math.min(started,timestamp); else ended = Math.max(ended,timestamp);
      }
      const fragStarted = Date.parse(fragment.started_at);
      const fragEnded = Date.parse(fragment.ended_at);
      partitionCheck(fragEnded >= fragStarted, 'runtime_partition_clock');
      partitionCheck(fragEnded - fragStarted <= PARTITION_BUDGET_MS[numPartitions], 'runtime_partition_window_exceeded');
      const report = fragment.report;
      partitionCheck(strictKeys(report, ['check_id','status','reason','test_count','evidence_sha256','selected_files','test_files','database_cleanup_verified']) &&
        report.check_id === fragment.check_id && report.status === 'passed' && report.reason === 'tests_executed' &&
        fragment.database_cleanup_verified === true && report.database_cleanup_verified === true &&
        /^[a-f0-9]{64}$/.test(report.evidence_sha256) && identical(report.selected_files,partitions[index]) &&
        Array.isArray(report.test_files) && report.test_files.length === partitions[index].length, 'runtime_partition_incomplete');
      const selected = new Set(partitions[index]), covered = new Set(); let count = 0;
      for (const file of report.test_files) {
        partitionCheck(strictKeys(file,['path','counts','cases','suite_events']) && selected.has(file.path) && !covered.has(file.path), 'runtime_partition_file_union');
        covered.add(file.path);
        partitionCheck(strictKeys(file.counts,COUNT_KEYS) && COUNT_KEYS.every(key => Number.isSafeInteger(file.counts[key]) && file.counts[key] >= 0) &&
          file.counts.tests > 0 && file.counts.tests === file.counts.passed && COUNT_KEYS.slice(2).every(key => file.counts[key] === 0) &&
          Array.isArray(file.cases) && file.cases.length === file.counts.tests && Array.isArray(file.suite_events), 'runtime_partition_counts');
        for (const event of [...file.cases,...file.suite_events]) {
          partitionCheck(strictKeys(event,['case_sha256','status']) && /^[a-f0-9]{64}$/.test(event.case_sha256) && event.status === 'passed' && !identities.has(event.case_sha256), 'runtime_partition_case_union');
          identities.add(event.case_sha256);
        }
        count += file.counts.tests; files.push(file);
      }
      partitionCheck(Number.isSafeInteger(report.test_count) && report.test_count === count && count > 0, 'runtime_partition_counts');
      ordered[index] = fragment;
    }
    partitionCheck(ended - started <= MATRIX_WINDOW_MS[numPartitions], 'runtime_full_window_exceeded');
    files.sort((a,b) => a.path.localeCompare(b.path));
    partitionCheck(identical(files.map(file => file.path), source.full_source_manifest.map(file => file.path)), 'runtime_partition_file_union');
    partitionCheck(identical(source,await runtimeSourceManifest(root)), 'runtime_source_changed');
    return {check_id:'runtime.full',status:'passed',reason:'tests_executed',gate_enforced:false,merge_authorized:false,
      ...source, started_at:new Date(started).toISOString(),ended_at:new Date(ended).toISOString(),
      selected_files:files.map(file => file.path),test_files:files,test_count:files.reduce((sum,file)=>sum+file.counts.tests,0),
      database_cleanup_verified:true,partition_count:numPartitions,
      evidence_sha256:sha256(Buffer.from(JSON.stringify(ordered))),
      partition_evidence_sha256:ordered.map(fragment=>fragment.report.evidence_sha256)};
  } catch (error) { return failure(/^runtime_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'runtime_partition_invalid'); }
}
