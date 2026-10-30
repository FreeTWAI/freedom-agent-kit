import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'src', 'cli.mjs');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', ...options });
}

// 1. Tool invocation argument sanitization

test('adapter security - tool invocation argument sanitization: rejects extra arguments', () => {
  const result = runCli(['http://127.0.0.1:4310/api/v1', 'maker', 'extra-arg']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: node src\/cli\.mjs/);
});

test('adapter security - tool invocation argument sanitization: rejects missing arguments', () => {
  const result = runCli(['http://127.0.0.1:4310/api/v1']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: node src\/cli\.mjs/);
});

test('adapter security - tool invocation argument sanitization: rejects unauthorized roles', () => {
  const result = runCli(['http://127.0.0.1:4310/api/v1', 'admin']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: node src\/cli\.mjs/);
});

test('adapter security - tool invocation argument sanitization: rejects shell injection in role', () => {
  const result = runCli(['http://127.0.0.1:4310/api/v1', 'maker; echo hacked']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: node src\/cli\.mjs/);
});

test('adapter security - tool invocation argument sanitization: invalid URLs fail safely', () => {
  const result = runCli(['not-a-url', 'maker']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid URL/);
});

// 2. Environment isolation

test('adapter security - environment isolation: rejects non-loopback endpoints', () => {
  const result = runCli(['https://production.example.com/api/v1', 'maker']);
  // Valid role, valid arg length, so it gets to the fetch/login stage
  // However, PlatformClient.loginDemo will reject non-loopback URLs
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Demo login is restricted to HTTP loopback/);
});

test('adapter security - environment isolation: ignores and does not leak ambient credentials', () => {
  const env = { ...process.env, SECRET_TOKEN: 'leak-me-if-you-can', AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' };
  const result = runCli(['http://127.0.0.1:4310/api/v1', 'maker'], { env });
  assert.equal(result.stdout.includes('leak-me-if-you-can'), false);
  assert.equal(result.stderr.includes('leak-me-if-you-can'), false);
  assert.equal(result.stdout.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(result.stderr.includes('AKIAIOSFODNN7EXAMPLE'), false);
});

// 3. Execution boundaries

test('adapter security - execution boundaries: adapter source does not contain subprocess calls', async () => {
  const cliSource = await readFile(cliPath, 'utf8');
  assert.equal(cliSource.includes('child_process'), false);
  assert.equal(cliSource.includes('spawn('), false);
  assert.equal(cliSource.includes('exec('), false);
});
