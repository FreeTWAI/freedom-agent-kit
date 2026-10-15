import { buildContextMetadata } from './context.mjs';
import { inspectWorkspace, resolveCommit } from './workspace.mjs';
import { readBounded, parseJson, sha256 } from './io.mjs';
import { validateFormat } from './formats.mjs';
import { verifyContractPin } from './contracts.mjs';
import { safeFailure, requireCondition as check } from './errors.mjs';
import { runLocalSuites } from './suite-runner.mjs';
export { runLocalSuite, runLocalSuites } from './suite-runner.mjs';

async function contractCheck(workspace) {
  try {
    if (workspace.candidate_paths.includes('contracts.lock.json')) {
      await verifyContractPin({ repositoryRoot: workspace.root });
      return { check_id: 'contracts', status: 'passed', reason: 'local_pin_integrity' };
    }
    if (workspace.candidate_paths.includes('contracts/preview/v1/bundle.json')) {
      const bundle = parseJson(await readBounded(workspace.root, 'contracts/preview/v1/bundle.json'));
      check(bundle.format === 'freedom.contract-bundle/v1' && bundle.files && typeof bundle.files === 'object', 'invalid_preview_bundle');
      for (const [path, declared] of Object.entries(bundle.files)) {
        const bytes = await readBounded(workspace.root, 'contracts/preview/v1/' + path);
        check(bytes.length === declared.bytes && sha256(bytes) === declared.sha256, 'artifact_integrity_mismatch');
      }
      check(Object.keys(bundle.files).length > 0, 'empty_preview_bundle');
      return { check_id: 'contracts', status: 'passed', reason: 'producer_preview_bytes_only' };
    }
    return { check_id: 'contracts', status: 'not_run', reason: 'contract_source_missing' };
  } catch (error) {
    const failure = safeFailure(error);
    return { check_id: 'contracts', status: failure.status === 'unavailable' ? 'not_run' : 'failed', reason: failure.code };
  }
}

export async function verifyWorkspace(options, { suiteRunner, testDatabaseUrl } = {}) {
  const built = await buildContextMetadata(options), { workspace, context, impact } = built;
  const checks = [{ check_id: 'descriptors', status: 'passed', reason: 'schema_and_references_checked' }, await contractCheck(workspace)];
  for (const blocker of context.blockers) checks.push({ check_id: blocker, status: 'not_run', reason: blocker });
  const suites = new Set(impact.tests);
  if (impact.unknown_paths.length) {
    suites.add('governance.unit'); suites.add('runtime.full');
  }
  const codeChanged = workspace.changed_paths.some(path => /\.(?:[cm]?[jt]sx?|rs|sql|jsonc?)$/.test(path));
  if (codeChanged && !suites.size) checks.push({ check_id: 'coverage', status: 'not_run', reason: 'surface_unmapped' });
  if (suiteRunner) {
    for (const id of [...suites].sort()) checks.push(await suiteRunner(workspace.root, id));
  } else checks.push(...await runLocalSuites(workspace.root, [...suites], { testDatabaseUrl }));
  const runtimeChanged = impact.module_ids.some(id => id !== 'governance') || impact.unknown_paths.length > 0;
  if (runtimeChanged) checks.push({ check_id: 'runtime.surface-coverage', status: 'not_run', reason: 'registration_behavior_audit_required' });
  const current = await inspectWorkspace(workspace.root, workspace.base_commit);
  if (current.workspace_sha256 !== workspace.workspace_sha256) checks.push({ check_id: 'workspace', status: 'failed', reason: 'workspace_changed_during_verification' });
  if (resolveCommit(workspace.root, options.baseRef ?? 'origin/main') !== workspace.base_commit) {
    checks.push({ check_id: 'base', status: 'failed', reason: 'base_changed_during_verification' });
  }
  const status = checks.some(item => item.status === 'failed') ? 'failed'
    : checks.some(item => item.status === 'not_run') ? 'unavailable' : 'passed';
  const report = { format: 'freedom.verifier-report/v1', assurance_level: 'local', repository: context.repository,
    base_commit: workspace.base_commit, head_commit: workspace.head_commit, workspace_sha256: workspace.workspace_sha256,
    status, scope: impact.module_ids, checks, blockers: [...new Set(checks.filter(item => item.status !== 'passed').map(item => item.reason))].sort() };
  validateFormat('verifierReport', report);
  return report;
}
