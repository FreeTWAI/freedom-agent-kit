import { buildContext, CONTEXT_LIMITS, writeContextDelivery, readContextDelivery } from './context.mjs';
import { verifyWorkspace } from './verify.mjs';
import { writeLocalArtifact, validateArtifactOutputPath } from './local-artifacts.mjs';
import { VerificationError, safeFailure } from './errors.mjs';

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['prepare', 'context', 'verify'].includes(command)) throw new VerificationError('unknown_command');
  const options = { baseRef: 'origin/main', requestedPaths: [], scopes: [] }, seen = new Set();
  let report, manifestPath, chunkIndex, complete = false;
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!value || value.startsWith('--') || seen.has(flag)) throw new VerificationError('invalid_arguments');
    seen.add(flag);
    if (flag === '--base-ref') options.baseRef = value;
    else if (flag === '--scope') options.scopes = value.split(',');
    else if (flag === '--paths') options.requestedPaths = value.split(',');
    else if (flag === '--report' && command === 'verify') report = value;
    else if (flag === '--manifest' && command === 'context') manifestPath = value;
    else if (flag === '--chunk' && command === 'context' && /^(0|[1-9][0-9]{0,3})$/.test(value)) chunkIndex = Number(value);
    else if (flag === '--check' && command === 'context' && value === 'complete') complete = true;
    else throw new VerificationError('invalid_arguments');
  }
  if (manifestPath || chunkIndex !== undefined || complete) {
    if (!manifestPath || complete === (chunkIndex !== undefined)
      || ['--base-ref', '--scope', '--paths'].some(flag => seen.has(flag))) throw new VerificationError('invalid_arguments');
  }
  return { command, options, report, manifestPath, chunkIndex, complete };
}

export async function runFreedomCli(args = process.argv.slice(2), repositoryRoot = process.cwd()) {
  try {
    const { command, options, report: reportPath, manifestPath, chunkIndex, complete } = parseArgs(args);
    if (manifestPath) {
      const result = await readContextDelivery(repositoryRoot, manifestPath, { chunkIndex, complete });
      console.log(JSON.stringify(result.value));
      return result.blockers.length ? 2 : 0;
    }
    if (reportPath) validateArtifactOutputPath(reportPath);
    if (command === 'verify') {
      const report = await verifyWorkspace({ repositoryRoot, ...options }, { testDatabaseUrl: process.env.TEST_DATABASE_URL });
      if (reportPath) await writeLocalArtifact(repositoryRoot, reportPath, report);
      console.log(JSON.stringify(report));
      return report.status === 'passed' ? 0 : report.status === 'unavailable' ? 2 : 1;
    }
    let context;
    try {
      ({ context } = await buildContext({ repositoryRoot, ...options }));
      if (Buffer.byteLength(JSON.stringify(context, null, 2) + '\n') > CONTEXT_LIMITS.bundle_bytes) throw new VerificationError('context_size_limit');
    } catch (error) {
      if (error.code !== 'context_size_limit') throw error;
      const built = await writeContextDelivery({ repositoryRoot, ...options });
      console.log(JSON.stringify(command === 'context' ? built.manifest : {
        format: built.manifest.format, assurance_level: 'local', context_path: built.manifestPath,
        delivery_id: built.manifest.delivery_id, binding: built.manifest.binding, chunk_count: built.chunks.length,
        read_chunk: `node scripts/freedom.mjs context --manifest ${built.manifestPath} --chunk 0`,
        check_complete: `node scripts/freedom.mjs context --manifest ${built.manifestPath} --check complete`,
      }));
      return built.context.blockers.length ? 2 : 0;
    }
    if (command === 'context') console.log(JSON.stringify(context));
    else {
      const path = await writeLocalArtifact(repositoryRoot, `.freedom/context/${context.task_id}/bundle.json`, context);
      console.log(JSON.stringify({ format: context.format, assurance_level: 'local', context_path: path,
        task_id: context.task_id, base_commit: context.base_commit, head_commit: context.head_commit,
        module_ids: context.module_ids, tests: context.tests, blockers: context.blockers }));
    }
    return context.blockers.length ? 2 : 0;
  } catch (error) {
    const failure = safeFailure(error);
    console.log(JSON.stringify({ format: 'freedom.cli-error/v1', assurance_level: 'local', ...failure }));
    return failure.status === 'unavailable' ? 2 : 1;
  }
}
