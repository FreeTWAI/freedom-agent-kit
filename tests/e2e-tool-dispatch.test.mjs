import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as http from 'node:http';

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

test('client successful execution: loadMemberWorkspace fetches and parses all endpoints', async () => {
    // 1. Create a local mock server
    const server = http.createServer((req, res) => {
        // We only mock the endpoints called by cli.mjs -> loadMemberWorkspace

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');

            // Removing query params from URL
            const url = new URL(req.url, `http://${req.headers.host}`);
            const route = url.pathname;
            if (route === '/api/v1/protocol') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    protocol: 'freedom.preview/v1',
                    revision: '0.4.1',
                    protocol_sha256: '41378c3b723f739cefdf8c53a82238b1e5d69cc13cdbf63b33a80d8080c807b2',
                    operations: ['login', 'logout', 'getSession', 'getDashboard', 'listWorks', 'getPositioning', 'listGuilds'],
                    authentication: 'member_session_csrf',
                    external_job_execution: false,
                    public_checkout: false
                }));
            } else if (route === '/api/v1/auth/login') {
                res.writeHead(200, {
                    'Set-Cookie': 'freedom_local_session=mocksession; Path=/; HttpOnly'
                });
                res.end(JSON.stringify({ csrf_token: 'mockcsrf', user: { user_id: '123e4567-e89b-12d3-a456-426614174000', email: 'maker@local.test', display_name: 'Maker' } }));
            } else if (route === '/api/v1/session') {
                res.writeHead(200);
                res.end(JSON.stringify({ csrf_token: 'mockcsrf', user: { user_id: '123e4567-e89b-12d3-a456-426614174000', email: 'maker@local.test', display_name: 'Maker' } }));
            } else if (route === '/api/v1/dashboard') {
                res.writeHead(200);
                res.end(JSON.stringify({}));
            } else if (route === '/api/v1/work-items') {
                res.writeHead(200);
                res.end(JSON.stringify({ items: [{ title: 'Work', work_item_id: '123e4567-e89b-12d3-a456-426614174000', aggregate_version: 1 }] }));
            } else if (route === '/api/v1/me/positioning') {
                res.writeHead(200);
                res.end(JSON.stringify({ profile: null, tracks: [], recommendations: [] }));
            } else if (route === '/api/v1/guilds') {
                res.writeHead(200);
                res.end(JSON.stringify({ items: [] }));
            } else if (route === '/api/v1/auth/logout') {
                res.writeHead(200);
                res.end(JSON.stringify({}));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ detail: 'Not found', status: 404, code: 'not_found' }));
            }
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api/v1`;

    try {
        const { loadMemberWorkspace } = await import('../src/index.mjs');
        const { PlatformClient } = await import('../packages/client/index.mjs');
        const client = await PlatformClient.loginDemo({ baseUrl, email: 'maker@local.test', password: 'freedom-local-demo' });

        const output = await loadMemberWorkspace(client);
        assert.equal(output.member.user_id, '123e4567-e89b-12d3-a456-426614174000');
        assert.equal(output.work.length, 1);
        assert.equal(output.work[0].title, 'Work');
    } finally {
        server.close();
    }
});

test('client unhandled server error during interaction', async () => {
    // 1. Create a local mock server
    const server = http.createServer((req, res) => {
        // We only mock the endpoints called by cli.mjs -> loadMemberWorkspace

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');

            // Removing query params from URL
            const url = new URL(req.url, `http://${req.headers.host}`);
            const route = url.pathname;
            if (route === '/api/v1/protocol') {
                res.writeHead(200);
                res.end(JSON.stringify({
                    protocol: 'freedom.preview/v1',
                    revision: '0.4.1',
                    protocol_sha256: '41378c3b723f739cefdf8c53a82238b1e5d69cc13cdbf63b33a80d8080c807b2',
                    operations: ['login', 'logout', 'getSession', 'getDashboard', 'listWorks', 'getPositioning', 'listGuilds'],
                    authentication: 'member_session_csrf',
                    external_job_execution: false,
                    public_checkout: false
                }));
            } else if (route === '/api/v1/auth/login') {
                res.writeHead(200, {
                    'Set-Cookie': 'freedom_local_session=mocksession; Path=/; HttpOnly'
                });
                res.end(JSON.stringify({ csrf_token: 'mockcsrf', user: { user_id: '123e4567-e89b-12d3-a456-426614174000', email: 'maker@local.test', display_name: 'Maker' } }));
            } else if (route === '/api/v1/session') {
                res.writeHead(500);
                res.end(JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', detail: 'Internal Server Error', status: 500, code: 'internal_error' }));
            } else if (route === '/api/v1/auth/logout') {
                res.writeHead(200);
                res.end(JSON.stringify({}));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ detail: 'Not found', status: 404, code: 'not_found' }));
            }
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api/v1`;

    try {
        const { loadMemberWorkspace } = await import('../src/index.mjs');
        const { PlatformClient } = await import('../packages/client/index.mjs');
        const client = await PlatformClient.loginDemo({ baseUrl, email: 'maker@local.test', password: 'freedom-local-demo' });

        await assert.rejects(loadMemberWorkspace(client), /Internal Server Error/);
    } finally {
        server.close();
    }
});
