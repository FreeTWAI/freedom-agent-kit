import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { artifactPath, readBounded } from './io.mjs';
import { requireCondition as check } from './errors.mjs';
import { git } from './workspace.mjs';

// Only ignored task artifacts can be written. This is not a general file writer.
export function validateArtifactOutputPath(path) {
  artifactPath(path);
  check(/^\.freedom\/(?:context|reports)\/[a-zA-Z0-9._/-]+\.json$/.test(path), 'report_path_denied');
}

function requireIgnored(root, path) {
  let pattern;
  try { pattern = git(root, ['check-ignore', '--no-index', '--non-matching', '--verbose', '-z', '--stdin'], 4096, path + '\0')
    .toString().split('\0')[2]; }
  catch { /* Ignore status must be established for both writes and reads. */ }
  check(typeof pattern === 'string' && pattern.length > 0 && !pattern.startsWith('!'), 'context_artifacts_must_be_ignored');
}

export async function readLocalArtifact(root, path, maxBytes) {
  validateArtifactOutputPath(path);
  requireIgnored(root, path);
  return readBounded(root, path, maxBytes);
}

export async function writeLocalArtifact(root, path, value) {
  validateArtifactOutputPath(path);
  let current = resolve(root);
  const rootStat = await lstat(current);
  check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'unsafe_artifact_root');
  for (const part of path.split('/').slice(0, -1)) {
    current = resolve(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_report_directory');
  }
  const target = resolve(root, path);
  try {
    const stat = await lstat(target);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'unsafe_report_target');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // An ignored directory is an actual Git property, not just a naming convention.
  requireIgnored(root, path);
  const temporary = resolve(dirname(target), '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.close(); handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return path;
}
