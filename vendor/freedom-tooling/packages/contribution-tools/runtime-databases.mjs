import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import fs from 'node:fs';

// Only bounded, reviewed vocabulary reaches CI logs. Never serialize errors,
// connection URLs, database names, SQL, or server detail/message fields.
export function runtimeCleanupDiagnostic(phase, result, error, elapsedMs) {
  const phases = ['owner_close', 'cleaner_connect', 'cleaner_identity', 'owner_stop',
    'database_owner', 'database_stop', 'database_stop_readback', 'drop',
    'cleaner_close', 'verifier_connect', 'verifier_identity', 'cleaner_stop', 'absence', 'verifier_close'];
  const results = ['unknown_ack', 'rejected', 'failed', 'unverified', 'verified_absent', 'no_owned_names'];
  const codes = ['cleanup_deadline', 'cleanup_identity', 'owner_backend_unsettled',
    'database_backend_unsettled', 'ownership_mismatch', 'cleaner_identity_missing',
    'verification_budget_exhausted', 'database_present'];
  const sqlstates = ['57014', '57P01', '55006', '42501', '3D000', '08006', '08003', '53300', '53200', '58030'];
  const messages = {'Query read timeout': 'query_read_timeout',
    'Connection terminated unexpectedly': 'connection_terminated',
    'Connection terminated': 'connection_terminated', 'timeout expired': 'connection_timeout'};
  const code = error == null ? 'none' : sqlstates.includes(error.code) ? error.code
    : codes.includes(error.message) ? error.message
    : Object.hasOwn(messages, error.message) ? messages[error.message] : 'unclassified';
  return {event: 'runtime_database_cleanup', phase: phases.includes(phase) ? phase : 'unknown',
    result: results.includes(result) ? result : 'unverified', code,
    elapsed_ms: Number.isFinite(elapsedMs) ? Math.max(0, Math.min(20000, Math.floor(elapsedMs))) : 0};
}

// Admission checks are not proof that a database is disposable. Its operator
// must provision an isolated test-only server; this library never discovers one.
export function isDisposableDatabaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || url.password
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(url.username)
      || !/^\/fp_[a-z0-9_]{1,59}$/.test(url.pathname)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) return false;
    const entries = [...url.searchParams];
    if (entries.length === 0) return true;
    if (entries.length !== 1 || entries[0][0] !== 'host') return false;
    const socket = entries[0][1];
    return /^\/[a-zA-Z0-9_./-]+$/.test(socket) && resolve(socket) === socket && socket !== '/';
  } catch { return false; }
}


// The caller must explicitly provide a disposable, local test server. Each
// invocation owns only these fresh databases; it never drops the supplied DB.
export async function createRuntimeDatabases(baseUrl, count, provisionTimeoutMs = 20_000) {
  if (![1, 2, 4].includes(count)) throw Error('invalid_runtime_shards');
  if (!Number.isSafeInteger(provisionTimeoutMs) || provisionTimeoutMs < 1 || provisionTimeoutMs > 20_000) throw Error('invalid_provision_timeout');
  const provisionDeadline = performance.now() + provisionTimeoutMs;
  if (!isDisposableDatabaseUrl(baseUrl)) throw Error('test_database_rejected');
  const { Client } = createRequire(import.meta.url)('pg');
  const prefix = `fp_suite_${process.pid}_${randomBytes(8).toString('hex')}`;
  const connection = (application_name, limits = {}) => {
    const client = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 2000,
      query_timeout: 2000, statement_timeout: 2000, application_name, ...limits });
    client.on('error', () => { /* query/cleanup failures never print connection details */ });
    return client;
  };
  const ownerApplication = prefix + '_owner', client = connection(ownerApplication, { connectionTimeoutMillis: Math.min(2000, provisionTimeoutMs) });
  const names = [], urls = [];
  let owner, ownerPid;
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  async function close(connection, maximum = 1000) {
    let timer;
    const ended = await Promise.race([connection.end().then(() => true, () => false),
      new Promise(done => { timer = setTimeout(() => done(false), Math.max(0, maximum)); })]);
    clearTimeout(timer);
    if (!ended) connection.connection?.stream?.destroy();
    return ended;
  }
  async function cleanup() {
    // One absolute 20s budget, inside the suite's unchanged 24s cleanup reserve.
    // In particular, DROP may wait for a checkpoint; it must not inherit the
    // short metadata-query timeout or gain an unbounded per-database budget.
    const started = performance.now();
    const deadline = started + 20_000;
    let phase = 'owner_close';
    const diagnostic = (result, error) => {
      // Initialize Node's lazy pipe handle before raw writes. Otherwise an inherited
      // blocking fd can stall before Node configures the pipe as nonblocking.
      // A tiny synchronous fd write makes EPIPE catchable here; stream.write
      // can emit an uncaught asynchronous error after returning successfully.
      // Logging must never change cleanup success, failure, or its deadline.
      try {
        const fd = process.stderr.fd;
        // Linux CI exposes the actual open-file flags. If nonblocking output
        // cannot be proved, omit this optional diagnostic rather than stall.
        if (process.platform !== 'linux') return;
        const flags = /^flags:\s+([0-7]+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
        if (!flags || !(Number.parseInt(flags[1], 8) & fs.constants.O_NONBLOCK)) return;
        fs.writeSync(fd, JSON.stringify(runtimeCleanupDiagnostic(phase, result, error, performance.now() - started)) + '\n');
      }
      catch { /* A closed diagnostic stream cannot change cleanup semantics. */ }
    };
    const remaining = () => Math.floor(deadline - performance.now());
    async function boundedQuery(c, text, values = [], maximum = 2000) {
      const milliseconds = Math.min(maximum, remaining() - 100);
      if (milliseconds <= 0) throw Error('cleanup_deadline');
      await c.query({ text: "SELECT set_config('statement_timeout',$1,false)",
        values: [String(milliseconds)], query_timeout: Math.min(1000, remaining()) });
      const timeout = Math.min(milliseconds + 50, remaining());
      if (timeout <= 0) throw Error('cleanup_deadline');
      return c.query({ text, values, query_timeout: timeout });
    }
    async function identity(c) {
      const row = (await boundedQuery(c, 'SELECT current_database() AS database, current_user AS owner, session_user AS session, pg_backend_pid() AS pid')).rows[0];
      if (row?.database !== new URL(baseUrl).pathname.slice(1) || row.owner !== owner || row.session !== owner) throw Error('cleanup_identity');
      return row.pid;
    }
    async function stop(c, pid, application) {
      const rows = (await boundedQuery(c, 'SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE pid=$1 AND usename=$2 AND application_name=$3', [pid, owner, application])).rows;
      if (rows.some(row => row.stopped !== true)) {
        // A backend may leave between pg_stat_activity and termination. Only
        // a fresh absence observation can reconcile a false acknowledgement.
        const live = await boundedQuery(c, 'SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND usename=$2 AND application_name=$3', [pid, owner, application]);
        if (live.rowCount) throw Error('owner_backend_unsettled');
      }
    }
    // CREATE may commit with an unknown ACK. Its exact nonce-bound owner must
    // stop before we consider any pre-registered name on a fresh connection.
    await close(client, Math.min(1000, remaining()));
    if (!names.length) { diagnostic('no_owned_names'); return true; }
    const cleanupApplication = prefix + '_cleanup';
    const cleaner = connection(cleanupApplication, { connectionTimeoutMillis: Math.max(1, Math.min(2000, remaining())) });
    let okay = true, cleanerPid;
    try {
      phase = 'cleaner_connect'; await cleaner.connect();
      phase = 'cleaner_identity'; cleanerPid = await identity(cleaner);
      phase = 'owner_stop'; await stop(cleaner, ownerPid, ownerApplication);
      for (const [index, name] of names.entries()) {
        phase = 'database_owner';
        const found = await boundedQuery(cleaner, 'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [name]);
        if (!found.rows.length) continue;
        if (found.rows[0].owner !== owner) { okay = false; diagnostic('rejected', Error('ownership_mismatch')); continue; }
        phase = 'database_stop';
        const stopped = await boundedQuery(cleaner, 'SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
        if (stopped.rows.some(row => row.stopped !== true)) {
          phase = 'database_stop_readback';
          const live = await boundedQuery(cleaner, 'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
          if (live.rowCount) throw Error('database_backend_unsettled');
        }
        // Share the remaining cleanup budget across registered databases while
        // reserving four seconds for fresh reconciliation. Disk deletion can
        // exceed six seconds even when the checkpoint has already completed.
        const dropBudget = Math.floor((remaining() - 4000) / (names.length - index));
        phase = 'drop';
        try { await boundedQuery(cleaner, `DROP DATABASE ${quote(name)}`, [], dropBudget); }
        catch (error) { diagnostic('unknown_ack', error); /* Fresh reconciliation is still required. */ }
      }
    } catch (error) { okay = false; diagnostic('failed', error); }
    phase = 'cleaner_close';
    await close(cleaner, Math.min(1000, remaining()));
    // Never equate an ACK (or its absence) to proof of deletion. Settle the
    // exact cleanup backend, then positively verify every owned name absent.
    // An identity/ownership failure above cannot be converted into success.
    if (!okay || !cleanerPid || remaining() <= 1000) {
      diagnostic('unverified', Error(!okay ? 'unclassified' : !cleanerPid ? 'cleaner_identity_missing' : 'verification_budget_exhausted'));
      return false;
    }
    const verifier = connection(prefix + '_verify', { connectionTimeoutMillis: Math.min(2000, remaining()) });
    try {
      phase = 'verifier_connect'; await verifier.connect();
      phase = 'verifier_identity'; await identity(verifier);
      phase = 'cleaner_stop'; await stop(verifier, cleanerPid, cleanupApplication);
      phase = 'absence';
      const found = await boundedQuery(verifier, 'SELECT datname FROM pg_database WHERE datname=ANY($1)', [names]);
      const verified = found.rowCount === 0 && remaining() > 0;
      diagnostic(verified ? 'verified_absent' : 'unverified', verified ? undefined : Error(found.rowCount ? 'database_present' : 'cleanup_deadline'));
      return verified;
    } catch (error) { diagnostic('failed', error); return false; }
    finally { phase = 'verifier_close'; await close(verifier, Math.min(1000, remaining())); }
  }

  async function provisionQuery(text, values = [], maximum = 2000) {
    const budget = Math.min(maximum, Math.floor(provisionDeadline - performance.now()));
    if (budget <= 0) throw Error('provision_deadline');
    return client.query({ text, values, query_timeout: budget });
  }
  try {
    await client.connect();
    const identity = await provisionQuery('SELECT current_database() AS database, current_user AS owner, session_user AS session, pg_backend_pid() AS pid');
    owner = identity.rows[0].owner; ownerPid = identity.rows[0].pid;
    const supplied = new URL(baseUrl);
    if (identity.rows[0].database !== supplied.pathname.slice(1) || owner !== supplied.username
      || owner !== identity.rows[0].session) throw Error('runtime_database_identity');
    for (let index = 0; index < count; index++) {
      const name = `${prefix}_${index}`;
      const existing = await provisionQuery('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
      if (existing.rowCount) throw Error('runtime_database_collision');
      names.push(name); // register BEFORE CREATE, including unknown acknowledgements
      const createTimeout = Math.min(6000, Math.floor(provisionDeadline - performance.now()) - 100);
      if (createTimeout <= 0) throw Error('provision_deadline');
      await provisionQuery("SELECT set_config('statement_timeout',$1,false)", [String(createTimeout)]);
      await provisionQuery(`CREATE DATABASE ${quote(name)} OWNER ${quote(owner)} TEMPLATE template0`, [], createTimeout + 50);
      await provisionQuery("SET statement_timeout=2000");
      const url = new URL(baseUrl); url.pathname = '/' + name; urls.push(url.href);
    }
    if (performance.now() >= provisionDeadline) throw Error('provision_deadline');
    return { urls, cleanup };
  } catch {
    const error = Error('runtime_database_provision_failed');
    error.cleanupVerified = await cleanup();
    throw error;
  }
}
