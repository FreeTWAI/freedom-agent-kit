import { artifactPath, readBounded, parseJson, sha256 } from './io.mjs';
import { parseFormat, validateFormat } from './formats.mjs';
import { inspectWorkspace, readRevisionFile } from './workspace.mjs';
import { VerificationError, requireCondition as check } from './errors.mjs';
import { validateReleaseSet } from './contracts.mjs';
import { readLocalArtifact, writeLocalArtifact } from './local-artifacts.mjs';

export const ROOT_INSTRUCTIONS = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md'];
export const isModuleDescriptorPath = path => path === 'freedom.module.json' || path.endsWith('/freedom.module.json');
export function validateDescriptor(value) {
  validateFormat('moduleDescriptor', value);
  for (const path of value.owned_paths) {
    const prefix = path.endsWith('/**') ? path.slice(0, -3) : path;
    artifactPath(prefix);
    check(!prefix.includes('*'), 'invalid_module_pattern');
  }
  for (const path of [...value.public_exports, ...value.instructions, ...value.surfaces.map(surface => surface.entry)]) artifactPath(path);
  check(new Set(value.surfaces.map(surface => surface.surface_id)).size === value.surfaces.length, 'duplicate_surface');
  return value;
}

export function owns(descriptor, path) {
  return descriptor.owned_paths.some(pattern => pattern.endsWith('/**')
    ? path.startsWith(pattern.slice(0, -2)) : path === pattern);
}

export function selectImpact({ baseline, candidate, changedPaths, requestedPaths = [], scopes = [] }) {
  const descriptors = [...baseline, ...candidate], modules = new Set(), unknown = [];
  const known = new Set(descriptors.map(item => item.module_id));
  for (const scope of scopes) {
    check(known.has(scope), 'unknown_module_scope');
    modules.add(scope);
  }
  for (const path of new Set([...changedPaths, ...requestedPaths])) {
    artifactPath(path);
    const matched = descriptors.filter(item => owns(item, path));
    for (const item of matched) modules.add(item.module_id);
    if (ROOT_INSTRUCTIONS.includes(path)) for (const id of known) modules.add(id);
    if (!matched.length && !/^docs\/.*\.md$/.test(path) && !ROOT_INSTRUCTIONS.includes(path)) unknown.push(path);
  }
  // Renamed/deleted/shrunk candidate globs cannot subtract the baseline's impact.
  if (unknown.length) for (const id of known) modules.add(id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of descriptors) if (!modules.has(item.module_id) && item.dependencies.some(id => modules.has(id))) {
      modules.add(item.module_id); grew = true;
    }
  }
  const selected = descriptors.filter(item => modules.has(item.module_id));
  return { module_ids: [...modules].sort(), tests: [...new Set(selected.flatMap(item => item.tests))].sort(),
    instructions: [...new Set(selected.flatMap(item => item.instructions))].sort(), unknown_paths: [...new Set(unknown)].sort() };
}

async function descriptorsFor(workspace, revision) {
  const paths = (revision === 'base' ? workspace.base_paths : workspace.candidate_paths).filter(isModuleDescriptorPath);
  check(paths.length <= 256, 'module_limit');
  const descriptors = [];
  for (const path of paths) {
    let bytes;
    if (revision === 'base') bytes = readRevisionFile(workspace, path);
    else {
      try { bytes = await readBounded(workspace.root, path); }
      catch (error) { if (error.code === 'artifact_missing') continue; throw error; }
    }
    const descriptor = validateDescriptor(parseFormat('moduleDescriptor', bytes));
    // A descriptor change always selects its own previous/new module.
    descriptors.push({ ...descriptor, owned_paths: [...descriptor.owned_paths, path] });
  }
  check(new Set(descriptors.map(item => item.module_id)).size === descriptors.length, 'duplicate_module');
  const known = new Set(descriptors.map(item => item.module_id));
  for (const item of descriptors) check(item.dependencies.every(id => known.has(id)), 'module_dependency_missing');
  const active = new Set(), done = new Set(), byId = new Map(descriptors.map(item => [item.module_id, item]));
  const visit = id => {
    check(!active.has(id), 'module_dependency_cycle');
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    active.delete(id); done.add(id);
  };
  for (const id of known) visit(id);
  return descriptors;
}

function allowedInstruction(path) {
  artifactPath(path);
  check(ROOT_INSTRUCTIONS.includes(path) || path === 'DESIGN.md' || path.endsWith('/AGENTS.md') || /^(docs|modules|packages|contracts|governance)\/.*\.md$/.test(path)
    || path === 'vendor/freedom-tooling/governance/README.md', 'instruction_path_denied');
  check(!path.split('/').some(part => part.startsWith('.')), 'instruction_path_denied');
}

async function versionInputs(workspace, consume) {
  const inputs = [];
  const paths = ['contracts.lock.json', 'contracts/preview/v1/bundle.json', 'vendor/freedom-platform/bundle.json',
    'vendor/freedom-platform/release-set.json', 'package.json', 'package-lock.json', 'Cargo.lock'];
  for (const path of paths) for (const revision of ['base', 'candidate']) {
    if (!(revision === 'base' ? workspace.base_paths : workspace.candidate_paths).includes(path)) continue;
    let bytes;
    try { bytes = revision === 'base' ? readRevisionFile(workspace, path) : await readBounded(workspace.root, path); }
    catch (error) { if (revision === 'candidate' && error.code === 'artifact_missing') continue; throw error; }
    const input = { path, revision, sha256: sha256(bytes), bytes: bytes.length };
    // Only fixed, public contract formats are copied. Dependency manifests/locks
    // are fingerprinted, not dumped into context (they can contain registry URLs).
    if (!['package.json', 'package-lock.json', 'Cargo.lock'].includes(path)) {
      const data = parseJson(bytes);
      if (path === 'contracts.lock.json') validateFormat(data.format === 'freedom.contract-pin/v1' ? 'lockV1' : 'lockV2', data);
      else if (path.endsWith('/release-set.json')) validateReleaseSet(data);
      else {
        check(data.format === 'freedom.contract-bundle/v1' && data.protocol === 'freedom.preview/v1'
          && typeof data.protocol_sha256 === 'string' && /^[a-f0-9]{64}$/.test(data.protocol_sha256), 'invalid_preview_bundle');
        // Preview metadata is not a ReleaseSet or an execution authorization.
        input.content = JSON.stringify({ format: data.format, protocol: data.protocol, protocol_sha256: data.protocol_sha256 });
      }
      input.content ??= bytes.toString('utf8');
    }
    if (consume && input.content !== undefined) { consume('version', input); delete input.content; }
    inputs.push(input);
  }
  return inputs;
}

async function collectContext({ repositoryRoot, baseRef = 'origin/main', requestedPaths = [], scopes = [], repository }, consume) {
  check(Array.isArray(requestedPaths) && requestedPaths.length <= 4096 && Array.isArray(scopes) && scopes.length <= 256, 'invalid_arguments');
  for (const path of requestedPaths) artifactPath(path);
  for (const scope of scopes) check(typeof scope === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(scope)
    && !/[\r\n]/.test(scope), 'invalid_module_scope');
  const workspace = await inspectWorkspace(repositoryRoot, baseRef);
  if (!repository) {
    const pkg = parseJson(await readBounded(workspace.root, 'package.json'));
    // Reviewed existing scoped consumer names; this labels local context, never
    // authenticates a remote repository or grants publisher trust.
    const scopedNames = {
      '@freetwai/agent-kit': 'freedom-agent-kit',
      '@freetwai/freedom-storefront': 'freedom-storefront',
      '@freetwai/freedom-growth-automation': 'freedom-growth-automation',
      '@freetwai/freedom-skill-registry': 'freedom-skill-registry',
    };
    const name = Object.hasOwn(scopedNames, pkg.name) ? scopedNames[pkg.name] : pkg.name;
    check(typeof name === 'string' && /^freedom-[a-z-]+$/.test(name) && !/[\r\n]/.test(name), 'repository_identity_required');
    repository = 'FreeTWAI/' + name;
  }
  const baseline = await descriptorsFor(workspace, 'base'), candidate = await descriptorsFor(workspace, 'candidate');
  const impact = selectImpact({ baseline, candidate, changedPaths: workspace.changed_paths, requestedPaths, scopes });
  const blockers = [], documents = [], seen = new Set(); let totalBytes = 0;
  if (!baseline.length) blockers.push('baseline_governance_unavailable');
  if (!candidate.length) blockers.push('candidate_governance_unavailable');
  if (impact.unknown_paths.length) blockers.push('surface_unmapped');
  const sharedInstructions = ['contracts/README.md', 'vendor/freedom-tooling/governance/README.md']
    .filter(path => workspace.base_paths.includes(path) || workspace.candidate_paths.includes(path));
  const relevantPaths = [...workspace.changed_paths, ...requestedPaths, ...[...baseline, ...candidate]
    .filter(item => impact.module_ids.includes(item.module_id)).flatMap(item => item.owned_paths.map(path => path.replace(/\/\*\*$/, '/')))];
  const nestedInstructions = [...workspace.base_paths, ...workspace.candidate_paths].filter(path => path.endsWith('/AGENTS.md')
    && relevantPaths.some(target => target.startsWith(path.slice(0, -'AGENTS.md'.length))));
  const instructions = [...new Set([...ROOT_INSTRUCTIONS, ...sharedInstructions, ...nestedInstructions, ...impact.instructions])];
  for (const path of instructions) {
    allowedInstruction(path);
    for (const revision of ['base', 'candidate']) {
      if (revision === 'base' && !workspace.base_paths.includes(path)) {
        if (ROOT_INSTRUCTIONS.includes(path) || baseline.some(item => impact.module_ids.includes(item.module_id) && item.instructions.includes(path))) {
          blockers.push('baseline_instruction_missing');
        }
        continue;
      }
      let bytes;
      try { bytes = revision === 'base' ? readRevisionFile(workspace, path) : await readBounded(workspace.root, path); }
      catch (error) {
        if (revision === 'candidate' && error.code === 'artifact_missing') { blockers.push('instruction_missing'); continue; }
        throw error;
      }
      const digest = sha256(bytes), identity = path + ':' + digest;
      if (!consume && seen.has(identity)) continue;
      seen.add(identity); totalBytes += bytes.length;
      if (!consume) check(totalBytes <= 512_000, 'context_size_limit');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new VerificationError('invalid_instruction_encoding'); }
      const document = { path, revision, sha256: digest, bytes: bytes.length, content };
      if (consume) consume('instruction', document);
      else documents.push(document);
    }
  }
  // Descriptors cite policies, not new ACLs. Existence is not behavior coverage.
  for (const descriptor of candidate) if (impact.module_ids.includes(descriptor.module_id)) {
    for (const entry of [...descriptor.public_exports, ...descriptor.surfaces.map(surface => surface.entry)]) {
      await readBounded(workspace.root, entry);
    }
  }
  const context = { format: 'freedom.coding-context/v1', assurance_level: 'local',
    task_id: 'task-' + sha256(JSON.stringify([workspace.base_commit, workspace.head_commit, workspace.workspace_sha256, requestedPaths, scopes])).slice(0, 16),
    repository, workspace_id: workspace.workspace_id, branch: workspace.branch,
    base_commit: workspace.base_commit, head_commit: workspace.head_commit,
    workspace_sha256: workspace.workspace_sha256, requested_paths: [...new Set(requestedPaths)].sort(), changed_paths: workspace.changed_paths,
    module_ids: impact.module_ids, documents, version_inputs: await versionInputs(workspace, consume),
    publisher_trust: 'unverified', library_usage: 'not_checked',
    tests: impact.tests, blockers: [...new Set(blockers)].sort() };
  if (!consume) check(totalBytes + context.version_inputs.reduce((sum, input) => sum + Buffer.byteLength(input.content ?? ''), 0) <= 512_000, 'context_size_limit');
  validateFormat('codingContext', context);
  const after = await inspectWorkspace(workspace.root, baseRef);
  check(after.workspace_sha256 === workspace.workspace_sha256, 'workspace_changed_during_context');
  return { context, workspace, baseline, candidate, impact };
}

export const CONTEXT_LIMITS = Object.freeze({
  bundle_bytes: 512_000, artifact_bytes: 512_000, chunk_content_bytes: 65_536,
  sources: 1024, chunks: 1024, total_content_bytes: 32_000_000,
});
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function boundedArtifact(value) {
  const bytes = jsonBytes(value);
  check(bytes.length <= CONTEXT_LIMITS.artifact_bytes, 'context_artifact_size_limit');
  return bytes;
}
function contentBudget() {
  let count = 0, bytes = 0;
  return input => {
    check(++count <= CONTEXT_LIMITS.sources, 'context_source_limit');
    bytes += Buffer.byteLength(input.content);
    check(bytes <= CONTEXT_LIMITS.total_content_bytes, 'context_total_size_limit');
  };
}

// The original small-bundle API retains its cap and schema. Metadata collection
// still reads/validates every applicable rule, without retaining its full text.
export async function buildContext(options) { return collectContext(options); }
export async function buildContextMetadata(options) {
  const admit = contentBudget();
  const built = await collectContext(options, (_kind, input) => admit(input));
  boundedArtifact(built.context);
  return built;
}

export async function buildContextDelivery(options) {
  const request = { baseRef: options.baseRef ?? 'origin/main',
    requestedPaths: Array.isArray(options.requestedPaths) ? [...options.requestedPaths] : options.requestedPaths ?? [],
    scopes: Array.isArray(options.scopes) ? [...options.scopes] : options.scopes ?? [],
    ...(options.repository === undefined ? {} : { repository: options.repository }) };
  const sources = [], parts = [], admit = contentBudget();
  const built = await collectContext({ ...request, repositoryRoot: options.repositoryRoot }, (kind, input) => {
    admit(input);
    const { content, ...source } = input, bytes = Buffer.from(content);
    const first = parts.length, sourceIndex = sources.length;
    for (let start = 0; start < bytes.length || start === 0;) {
      let end = Math.min(start + CONTEXT_LIMITS.chunk_content_bytes, bytes.length);
      // A fragment is complete UTF-8, including any BOM; no replacement or trim.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const fragment = bytes.subarray(start, end);
      check(parts.length < CONTEXT_LIMITS.chunks, 'context_chunk_limit');
      parts.push({ source_index: sourceIndex, offset: start, bytes: fragment.length,
        sha256: sha256(fragment), content: fragment.toString('utf8') });
      if (end === bytes.length) break;
      start = end;
    }
    sources.push({ kind, ...source, content_bytes: bytes.length, content_sha256: sha256(bytes),
      first_chunk: first, chunk_count: parts.length - first });
  });
  const { documents: _documents, format: _format, ...binding } = built.context;
  const selectedModules = descriptors => descriptors.filter(item => binding.module_ids.includes(item.module_id))
    .map(item => ({ module_id: item.module_id, dependencies: [...item.dependencies].sort() }));
  const selection = { unknown_paths: built.impact.unknown_paths,
    baseline_modules: selectedModules(built.baseline), candidate_modules: selectedModules(built.candidate) };
  const deliveryId = sha256(JSON.stringify({ binding, request, selection, sources }));
  const directory = `.freedom/context/${binding.task_id}/${deliveryId}`;
  const chunks = parts.map((part, index) => {
    const source = sources[part.source_index];
    const value = { format: 'freedom.coding-context-chunk/v1', assurance_level: 'local', delivery_id: deliveryId,
      index, source: { kind: source.kind, path: source.path, revision: source.revision, sha256: source.sha256, bytes: source.bytes,
        commit: source.revision === 'base' ? binding.base_commit : binding.head_commit,
        workspace_sha256: source.revision === 'candidate' ? binding.workspace_sha256 : null }, ...part };
    const bytes = boundedArtifact(value);
    return { path: `${directory}/chunk-${index}.json`, value, sha256: sha256(bytes), bytes: bytes.length };
  });
  const paths = [...new Set(sources.filter(source => source.kind === 'instruction').map(source => source.path))];
  const delta = paths.map(path => {
    const base = sources.find(source => source.kind === 'instruction' && source.path === path && source.revision === 'base');
    const candidate = sources.find(source => source.kind === 'instruction' && source.path === path && source.revision === 'candidate');
    return { path, status: !base ? 'added' : !candidate ? 'missing_candidate' : base.sha256 === candidate.sha256 ? 'unchanged' : 'changed',
      base_sha256: base?.sha256 ?? null, candidate_sha256: candidate?.sha256 ?? null };
  });
  const manifest = { format: 'freedom.coding-context-manifest/v1', assurance_level: 'local', delivery_id: deliveryId,
    request, binding, selection, limits: CONTEXT_LIMITS, sources, delta,
    chunks: chunks.map(({ path, sha256, bytes }, index) => ({ index, path, sha256, bytes })) };
  boundedArtifact(manifest);
  return { ...built, manifest, manifestPath: `${directory}/manifest.json`, chunks };
}

async function unchangedDelivery(repositoryRoot, built) {
  const current = await inspectWorkspace(repositoryRoot, built.manifest.request.baseRef);
  check(current.workspace_sha256 === built.context.workspace_sha256, 'stale_context_delivery');
}

export async function writeContextDelivery(options) {
  const built = await buildContextDelivery(options);
  for (const chunk of built.chunks) await writeLocalArtifact(built.workspace.root, chunk.path, chunk.value);
  await unchangedDelivery(built.workspace.root, built);
  // The manifest is the final publication marker. A partial write never emits it.
  await writeLocalArtifact(built.workspace.root, built.manifestPath, built.manifest);
  await unchangedDelivery(built.workspace.root, built);
  return built;
}

export async function readContextDelivery(repositoryRoot, manifestPath, { chunkIndex, complete = false } = {}) {
  check(typeof manifestPath === 'string' && /^\.freedom\/context\/task-[a-f0-9]{16}\/[a-f0-9]{64}\/manifest\.json$/.test(manifestPath), 'context_manifest_path_denied');
  check(complete === true && chunkIndex === undefined || complete === false && Number.isSafeInteger(chunkIndex) && chunkIndex >= 0,
    'invalid_context_read');
  const storedBytes = await readLocalArtifact(repositoryRoot, manifestPath, CONTEXT_LIMITS.artifact_bytes);
  const stored = parseJson(storedBytes, { maxBytes: CONTEXT_LIMITS.artifact_bytes });
  check(stored.format === 'freedom.coding-context-manifest/v1' && stored.request && typeof stored.request === 'object'
    && !Array.isArray(stored.request) && Object.keys(stored.request).every(key => ['baseRef', 'requestedPaths', 'scopes', 'repository'].includes(key))
    && typeof stored.request.baseRef === 'string' && Array.isArray(stored.request.requestedPaths) && Array.isArray(stored.request.scopes), 'invalid_context_manifest');
  // A self-consistent local digest is not trusted evidence. Recompute complete
  // scope and bytes from this workspace; never follow candidate-supplied paths.
  const built = await buildContextDelivery({ ...stored.request, repositoryRoot });
  check(manifestPath === built.manifestPath && storedBytes.equals(boundedArtifact(built.manifest)), 'stale_or_modified_context_manifest');
  if (!complete) check(chunkIndex < built.chunks.length, 'context_chunk_out_of_range');
  for (const chunk of built.chunks) {
    const bytes = await readLocalArtifact(repositoryRoot, chunk.path, CONTEXT_LIMITS.artifact_bytes);
    check(bytes.length === chunk.bytes && sha256(bytes) === chunk.sha256, 'context_chunk_mismatch');
  }
  await unchangedDelivery(repositoryRoot, built);
  // Detect a manifest replaced while checking the source or the other chunks.
  check((await readLocalArtifact(repositoryRoot, manifestPath, CONTEXT_LIMITS.artifact_bytes)).equals(storedBytes), 'context_manifest_changed');
  const value = complete ? { format: 'freedom.coding-context-completeness/v1', assurance_level: 'local',
    delivery_id: built.manifest.delivery_id, binding: built.manifest.binding,
    complete: built.context.blockers.length === 0, sources: built.manifest.sources.length, chunks: built.chunks.length,
    publisher_trust: 'unverified', library_usage: 'not_checked' } : built.chunks[chunkIndex].value;
  return { value, blockers: built.context.blockers };
}
