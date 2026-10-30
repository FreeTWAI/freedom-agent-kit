import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.mjs');

test('tool invocation execution: requires correct arguments', () => {
    const result = spawnSync('node', [cliPath]);
    // The current CLI implementation exits with 0 if args.length == 0
    assert.equal(result.status, 0, 'Should exit cleanly without arguments, printing usage');
    assert.match(result.stdout.toString(), /Usage: node src\/cli\.mjs/, 'Should print usage');
});

test('tool invocation error handling: gracefully handles connection failure', () => {
    // Testing dispatch to a non-existent local server to ensure it fails cleanly
    // without dumping raw exceptions to the agent console.
    const result = spawnSync('node', [cliPath, 'http://127.0.0.1:4310/api/v1', 'maker']);
    assert.equal(result.status, 1, 'Should exit with failure status');

    const stderr = result.stderr.toString();
    const stdout = result.stdout.toString();

    // It should log a clean error message, not a raw unhandled promise rejection
    assert.match(stderr, /fetch failed|ECONNREFUSED/i, 'Should report connection issue');
    assert.equal(stdout, '', 'Should not output invalid JSON to stdout on error');
});

test('tool recovery behavior: agent can parse error and retry or fallback', () => {
    // This simulates how the agent dispatches the tool, catches the error,
    // and would perform recovery based on the CLI's standard error exit.
    const attempt1 = spawnSync('node', [cliPath, 'http://127.0.0.1:4310/api/v1', 'invalid_role']);
    assert.equal(attempt1.status, 1);
    assert.match(attempt1.stdout.toString(), /Usage:/, 'Agent sees usage error');

    // Agent recovers by providing a valid role
    const attempt2 = spawnSync('node', [cliPath, 'http://127.0.0.1:4310/api/v1', 'client']);
    assert.equal(attempt2.status, 1);
    assert.match(attempt2.stderr.toString(), /fetch failed|ECONNREFUSED/i, 'Agent sees connection error now');
});
