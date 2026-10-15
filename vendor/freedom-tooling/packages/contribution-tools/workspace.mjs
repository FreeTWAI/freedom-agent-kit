import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactPath, readBounded, sha256 } from './io.mjs';
import { VerificationError, requireCondition as check } from './errors.mjs';
import { verificationEnvironment } from './process-env.mjs';

export function git(root, args, maxBuffer = 4_000_000, input) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root, maxBuffer, input, env: verificationEnvironment(), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch { throw new VerificationError('git_state_unavailable', true); }
}

export function resolveCommit(root, ref) {
  check(typeof ref === 'string' && ref.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9_./~-]*$/.test(ref)
    && !/[\r\n]/.test(ref), 'invalid_base_ref');
  const sha = git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).toString().trim();
  check(/^[a-f0-9]{40}$/.test(sha), 'invalid_source_commit');
  return sha;
}

function paths(bytes) {
  const result = bytes.toString('utf8').split('\0').filter(Boolean);
  check(result.length <= 8192, 'workspace_path_limit');
  for (const path of result) artifactPath(path);
  return result;
}

export async function inspectWorkspace(root, baseRef) {
  const repositoryRoot = resolve(root);
  check(git(repositoryRoot, ['rev-parse', '--show-prefix']).toString().trim() === '', 'run_from_repository_root');
  const base = resolveCommit(repositoryRoot, baseRef), head = resolveCommit(repositoryRoot, 'HEAD');
  const workspaceId = sha256(await realpath(repositoryRoot));
  // rev-parse returns HEAD for detached checkouts. Do not expose local paths.
  const branch = git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
  const tracked = paths(git(repositoryRoot, ['ls-files', '-z']));
  const untracked = paths(git(repositoryRoot, ['ls-files', '--others', '--exclude-standard', '-z']));
  const baseFiles = paths(git(repositoryRoot, ['ls-tree', '-rz', '--name-only', base]));
  const changes = new Set([
    ...paths(git(repositoryRoot, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--'])),
    ...paths(git(repositoryRoot, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--'])),
    ...untracked,
  ]);
  const flags = git(repositoryRoot, ['ls-files', '-v', '-z']).toString().split('\0').filter(Boolean);
  check(flags.every(line => line.startsWith('H ')), 'unsupported_index_flags');
  check(!tracked.some(path => path.startsWith('.freedom/')), 'context_artifacts_must_not_be_tracked');
  const index = git(repositoryRoot, ['ls-files', '--stage', '-z']);
  const changed = [...changes].sort(), fileStates = [];
  for (const path of changed) {
    check(!path.split('/').some(part => part === '.env' || part.startsWith('.env.') && part !== '.env.example'), 'secret_path_changed');
    try {
      await lstat(resolve(repositoryRoot, path));
      fileStates.push([path, sha256(await readBounded(repositoryRoot, path))]);
    } catch (error) {
      if (error.code === 'ENOENT') fileStates.push([path, 'deleted']);
      else throw error;
    }
  }
  return { root: repositoryRoot, workspace_id: workspaceId, branch, base_commit: base, head_commit: head, changed_paths: changed,
    tracked_paths: tracked, candidate_paths: [...new Set([...tracked, ...untracked])].sort(), base_paths: baseFiles,
    workspace_sha256: sha256(JSON.stringify({ workspaceId, branch, base, head, index: sha256(index), files: fileStates })) };
}

export function readRevisionFile(workspace, path) {
  artifactPath(path);
  check(workspace.base_paths.includes(path), 'baseline_file_missing');
  const entry = git(workspace.root, ['ls-tree', workspace.base_commit, '--', path]).toString();
  check(entry.startsWith('100644 blob ') || entry.startsWith('100755 blob '), 'baseline_file_not_regular');
  return git(workspace.root, ['show', `${workspace.base_commit}:${path}`], 2_000_000);
}
