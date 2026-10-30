# Freedom Agent Kit

<!-- freedom-repository-guide:start -->
## 在自由工坊的位置

[自由工坊](https://freetwai.com) 讓會員先完成定位、選擇公會並領取 Repo 技能書，再以供貨、商店、開源作品、行銷與小隊共同完成成果。

讓不同 AI 工具使用同一份平台協定與會員狀態入口。 已提供 pinned client/protocol 匯出、本機示範狀態 CLI 及 adapter 說明。

真正的 Agent device flow、ExecutionGrant 與可執行 MCP server 尚未實作；會員客戶端的讀取授權不等同 Agent 執行權。

本 repo 的維護者負責「讓不同 AI 工具使用同一份平台協定與會員狀態入口。」這個模組；公會職稱與自填 GitHub slug 不授予寫入權。

程式／內容入口：[src/cli.mjs](src/cli.mjs)、[packages/client/](packages/client/)、[packages/protocol/](packages/protocol/)、[adapters/](adapters/)、[mcp/freedom-work-server/](mcp/freedom-work-server/)。協作先讀 [CONTRIBUTING.md](CONTRIBUTING.md)，讓 Agent 讀 [AGENTS.md](AGENTS.md)；從[本倉 Issues](https://github.com/FreeTWAI/freedom-agent-kit/issues)認領、[查看既有 PR](https://github.com/FreeTWAI/freedom-agent-kit/pulls)避免重工。

只消費 freedom-platform 的固定協定，不建立第二份任務／會員資料庫。不把本機 demo 登入拿到公開站，也不讓 agent 取得使用者 cookie 或擴權。 跨 repo 的協定由[中央平台](https://github.com/FreeTWAI/freedom-platform)維護。
<!-- freedom-repository-guide:end -->

共用 Platform protocol 與可供不同 AI CLI 呼叫的會員狀態工具。中央會員、工作、定位、公會都由 `freedom-platform` 保存；此 repo 沒有另一個資料庫。

## Core Modules

The repository is structured to provide a common protocol and status entry points for different AI tools:

- **`src/cli.mjs`**: The local demonstration CLI. It reads the member's workspace status and exits, providing a testable entry point without storing session state.
- **`src/index.mjs`**: Central workspace assembly. It imports the shared member-workspace implementation, running read operations without leaking session envelopes.
- **`packages/client/`**: Re-exports a pinned version of the central `PlatformClient` from `freedom-platform`.
- **`packages/protocol/`**: Re-exports the pinned central protocol DTOs and interfaces.
- **`adapters/`**: Examples and adapters for different AI CLIs (e.g., Claude, Codex, Grok). They consume the output of the local demo CLI.
- **`mcp/freedom-work-server/`**: A placeholder for the Model Context Protocol (MCP) server integration, currently documenting limitations and pending agent device-flow integrations.

## API Reference

### `PlatformClient` (from `packages/client/index.mjs`)
A client wrapper for the central platform APIs.
- **`PlatformClient.loginDemo({ baseUrl, email, password })`**: Authenticates a local demo account and returns an authorized client instance. *Note: Only accepts explicit local test accounts.*
- **`client.call(endpoint, { body })`**: Calls a platform endpoint. Used internally and for `logout`.

### `loadMemberWorkspace(client)` (from `src/index.mjs`)
Fetches and aggregates the current workspace state for a given member.
- **Arguments**: An authorized `PlatformClient` instance.
- **Returns**: A JSON-serializable object containing preview read operations (e.g., identity, selected guild, work items). Omits session credentials from the output.

## Usage Examples

### CLI Usage

```sh
# Install dependencies
npm ci

# Run test suite
npm test

# Execute local demo CLI
node src/cli.mjs http://127.0.0.1:4310/api/v1 maker
```

The CLI only allows explicit local demonstration accounts. It reads the member status and logs out immediately. It does not output cookies or CSRF tokens, claim tasks, issue payments, or perform external actions. This demo login method cannot bypass Cloudflare Access. Real Agent device flow, short-lived ExecutionGrant, and MCP servers are pending implementation.

### Programmatic Usage (Node.js)

```javascript
import { PlatformClient } from './packages/client/index.mjs';
import { loadMemberWorkspace } from './src/index.mjs';

async function fetchDemoWorkspace() {
  const baseUrl = 'http://127.0.0.1:4310/api/v1';
  let client;

  try {
    // 1. Authenticate with a local demo account
    client = await PlatformClient.loginDemo({
      baseUrl,
      email: 'maker@local.test',
      password: 'freedom-local-demo'
    });

    // 2. Fetch workspace state using the shared central implementation
    const workspace = await loadMemberWorkspace(client);
    console.log('Workspace State:', JSON.stringify(workspace, null, 2));

  } catch (error) {
    console.error('Error fetching workspace:', error.message);
  } finally {
    // 3. Ensure session is cleanly closed
    if (client) {
      await client.call('logout', { body: {} });
    }
  }
}

fetchDemoWorkspace();
```

## Shared Member Workspace and Source Verification

`packages/client` and `packages/protocol` only re-export fixed versions from `vendor/freedom-platform`. `contracts.lock.json` records the source SHA and bundle digest; verify it with `node scripts/verify-contracts.mjs --remote`.

`src/index.mjs` imports the central member-workspace implementation from `vendor/freedom-libraries`. It executes the existing five preview read operations and excludes the session envelope. The preview contract is pinned separately; its bounded Work page operation does not change the complete legacy Work list used by this loader. `consumer-libraries.lock.json` preserves the shared library's separate exact source commit and bytes; this lock does not approve a release or prove runtime coverage.

Verify against an independently selected source commit before publishing:

```sh
node scripts/verify-consumer-libraries.mjs FreeTWAI/freedom-agent-kit EXPECTED_PLATFORM_SHA --source-root /path/to/freedom-platform
```

The verifier accepts the current `FreeTWAI` repository identity while preserving the historical identity recorded in the library lock. Use that library's independently selected source SHA, not the preview bundle's source SHA.

Once that exact source is publicly available, `--remote` can replace `--source-root /path/to/freedom-platform`. Local source checks use committed Git objects, not uncommitted working-tree files.

All supply protocols and changes reside in [freedom-platform](https://github.com/FreeTWAI/freedom-platform); do not manually modify vendor files here. Different AI tools consume the same DTOs without creating individual task truths. Code license is unassigned (manifest is NOASSERTION); open source visibility does not grant extra permissions.
