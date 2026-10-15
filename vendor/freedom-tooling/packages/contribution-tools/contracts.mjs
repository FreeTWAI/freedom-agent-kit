import { createPublicKey, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { VerificationError, requireCondition as check } from './errors.mjs';
import { assertSchema } from './schema.mjs';
import { parseFormat, validateFormat } from './formats.mjs';
import { artifactPath, uniquePaths, readBounded, listArtifacts, readRemoteBounded,
  parseJson, sha256, MAX_ARTIFACTS, MAX_TOTAL_BYTES } from './io.mjs';

export const CANONICAL_REPOSITORY = 'FreeTWAI/freedom-platform';
const SIGNING_DOMAIN = Buffer.from('freedom.release-set-signature/v1\0', 'utf8');
const fileDigest = { type: 'object', required: ['sha256', 'bytes'], additionalProperties: false,
  properties: { sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    bytes: { type: 'integer', minimum: 0, maximum: 2_000_000 } } };
const legacyBundleSchema = {
  type: 'object', required: ['format', 'protocol', 'revision', 'protocol_sha256', 'files'], additionalProperties: false,
  properties: {
    format: { const: 'freedom.contract-bundle/v1' }, protocol: { const: 'freedom.preview/v1' },
    revision: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._+-]*$' },
    protocol_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    files: { type: 'object', additionalProperties: fileDigest },
  },
};

function uniqueBy(items, field, code) {
  check(new Set(items.map(item => item[field])).size === items.length, code);
}

export function validateReleaseSet(manifest) {
  validateFormat('releaseSet', manifest);
  const paths = uniquePaths(manifest.artifacts.map(artifact => artifact.path));
  check(!paths.has('release-set.json') && !paths.has('release-set.proof.json'), 'self_referential_release');
  check(manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0) <= MAX_TOTAL_BYTES, 'artifact_total_limit');
  uniqueBy(manifest.contracts, 'family', 'duplicate_contract_family');
  uniqueBy(manifest.libraries, 'library_id', 'duplicate_library');
  const references = new Set();
  for (const component of [...manifest.contracts, ...manifest.libraries, manifest.policy, manifest.generator, manifest.fixtures]) {
    for (const path of component.artifacts) {
      artifactPath(path);
      check(paths.has(path), 'missing_release_artifact');
      references.add(path);
    }
  }
  check(paths.size === references.size, 'unclassified_release_artifact');
  for (const library of manifest.libraries) {
    check(library.runtime_profiles.every(profile => manifest.profiles.includes(profile)), 'unknown_runtime_profile');
  }
  return manifest;
}

// This signature profile signs exact published bytes with an explicit domain,
// not reserialized JSON or the historical preview/SQL digest algorithm.
export function releaseSigningBytes(manifestBytes) {
  const manifest = parseJson(manifestBytes);
  validateReleaseSet(manifest);
  return Buffer.concat([SIGNING_DOMAIN, Buffer.from(manifestBytes)]);
}

// Authoring helper only: no signing, fetching, publication or consumer writes.
export async function buildReleaseSet({ artifactRoot, artifactPaths, metadata }) {
  const paths = [...uniquePaths(artifactPaths)].sort(), artifacts = [];
  for (const path of paths) {
    const bytes = await readBounded(artifactRoot, path);
    artifacts.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  check(metadata && !Object.hasOwn(metadata, 'artifacts'), 'authoring_artifacts_are_derived');
  const manifest = validateReleaseSet({ ...metadata, artifacts });
  const sort = value => Array.isArray(value) ? value.map(sort)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  // Deterministic authoring encoding, NOT RFC 8785 or the execution digest.
  return Buffer.from(JSON.stringify(sort(manifest), null, 2) + '\n');
}

function time(value) {
  const parsed = Date.parse(value);
  check(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, 'invalid_trust_time');
  return parsed;
}

export function verifyReleaseProof(manifestBytes, proofBytes, {
  // Supplied only by the verifier's operator, never resolved from candidate files.
  trustProfile, environment = 'production', now = Date.now(), maxTrustAgeMs = 86_400_000,
} = {}) {
  const manifest = validateReleaseSet(parseJson(manifestBytes));
  const proof = parseFormat('proof', proofBytes), digest = sha256(manifestBytes);
  check(proof.manifest_sha256 === digest, 'proof_subject_mismatch');
  if (!trustProfile) throw new VerificationError('release_trust_unavailable', true);
  validateFormat('trust', trustProfile);
  check(['fixture', 'staging', 'production'].includes(environment), 'invalid_environment');
  check(trustProfile.environment === environment, 'trust_environment_mismatch');
  check(trustProfile.version === manifest.trust_profile_version, 'trust_version_mismatch');
  check(Number.isFinite(now) && Number.isSafeInteger(maxTrustAgeMs) && maxTrustAgeMs > 0, 'invalid_trust_time');
  const issued = time(trustProfile.issued_at), expires = time(trustProfile.expires_at);
  check(expires > issued && expires - issued <= maxTrustAgeMs, 'invalid_trust_window');
  if (now < issued || now >= expires || now - issued > maxTrustAgeMs) {
    throw new VerificationError('release_trust_stale', true);
  }
  uniqueBy(trustProfile.keys, 'kid', 'duplicate_trust_key');
  check(new Set(trustProfile.keys.map(key => key.public_jwk.x)).size === trustProfile.keys.length, 'duplicate_trust_key');
  uniqueBy(trustProfile.releases, 'manifest_sha256', 'duplicate_release_status');
  const supported = trustProfile.releases.find(item => item.manifest_sha256 === digest);
  check(supported, 'release_not_approved');
  check(supported.state === 'supported', 'release_withdrawn');
  check(supported.policy_revision === manifest.policy.revision, 'policy_revision_mismatch');
  const signer = trustProfile.keys.find(item => item.kid === proof.kid);
  check(signer && signer.publisher_id === proof.publisher_id && signer.source_repository === manifest.source_repository,
    'publisher_not_approved');
  check(now >= time(signer.not_before) && now < time(signer.not_after), 'signing_key_inactive');
  const publicBytes = Buffer.from(signer.public_jwk.x, 'base64url'), signature = Buffer.from(proof.signature, 'base64url');
  check(publicBytes.length === 32 && publicBytes.toString('base64url') === signer.public_jwk.x,
    'invalid_public_key');
  check(signature.length === 64 && signature.toString('base64url') === proof.signature, 'invalid_signature');
  let valid = false;
  try {
    const key = createPublicKey({ key: signer.public_jwk, format: 'jwk' });
    check(key.asymmetricKeyType === 'ed25519', 'invalid_public_key');
    valid = verify(null, releaseSigningBytes(manifestBytes), key, signature);
  } catch { throw new VerificationError('invalid_signature'); }
  check(valid, 'invalid_signature');
  return { manifest, manifest_sha256: digest, publisher_id: signer.publisher_id,
    publisher_trust: environment === 'fixture' ? 'fixture' : 'operator_approved', environment };
}

export async function verifyArtifactSet(root, declarations) {
  const expected = uniquePaths(declarations.map(item => item.path));
  check(declarations.reduce((sum, item) => sum + item.bytes, 0) <= MAX_TOTAL_BYTES, 'artifact_total_limit');
  const actual = await listArtifacts(root);
  check(actual.length === expected.size && actual.every(path => expected.has(path)), 'artifact_set_mismatch');
  for (const artifact of declarations) {
    const bytes = await readBounded(root, artifact.path);
    check(bytes.byteLength === artifact.bytes && sha256(bytes) === artifact.sha256, 'artifact_integrity_mismatch');
  }
  return declarations.length;
}

export async function verifyLegacyPin({ repositoryRoot, vendorPath = 'vendor/freedom-platform', lock,
  remote = false, fetcher } = {}) {
  validateFormat('lockV1', lock);
  artifactPath(vendorPath);
  // Read through repositoryRoot as well, so a symlinked vendor parent cannot escape.
  const manifestBytes = await readBounded(repositoryRoot, vendorPath + '/bundle.json');
  check(sha256(manifestBytes) === lock.bundle_sha256, 'bundle_digest_mismatch');
  const bundle = assertSchema(parseJson(manifestBytes), legacyBundleSchema);
  check(bundle.protocol === lock.protocol && bundle.protocol_sha256 === lock.protocol_sha256, 'protocol_mismatch');
  const artifacts = Object.entries(bundle.files).map(([path, metadata]) => ({ path, ...metadata }));
  check(artifacts.length > 0 && artifacts.length <= MAX_ARTIFACTS, 'artifact_limit');
  uniquePaths(['bundle.json', ...artifacts.map(item => item.path)]);
  const all = [{ path: 'bundle.json', bytes: manifestBytes.length, sha256: lock.bundle_sha256 }, ...artifacts];
  const count = await verifyArtifactSet(resolve(repositoryRoot, vendorPath), all);
  if (remote) for (const artifact of all) {
    const bytes = await readRemoteBounded(`https://raw.githubusercontent.com/${CANONICAL_REPOSITORY}/${lock.source_commit}/${lock.bundle_path}/${artifact.path}`, fetcher);
    check(bytes.length === artifact.bytes && sha256(bytes) === artifact.sha256, 'pinned_source_mismatch');
  }
  return { format: 'freedom.pin-verification/v1', assurance_level: 'local', status: 'passed',
    profile: 'legacy_preview', source_commit: lock.source_commit, protocol: lock.protocol,
    artifact_count: count, publisher_trust: 'unverified', remote_source_checked: remote,
    execution_authorized: false };
}

export async function verifyContractPin({ repositoryRoot, vendorPath = 'vendor/freedom-platform',
  remote = false, fetcher, ...proofOptions } = {}) {
  const lock = parseJson(await readBounded(repositoryRoot, 'contracts.lock.json'));
  if (lock.format === 'freedom.contract-pin/v1') return verifyLegacyPin({ repositoryRoot, vendorPath, lock, remote, fetcher });
  validateFormat('lockV2', lock);
  check(!remote, 'remote_v2_not_supported');
  artifactPath(vendorPath);
  uniquePaths(lock.artifacts.map(item => item.path));
  const manifestBytes = await readBounded(repositoryRoot, vendorPath + '/' + lock.release_set.path);
  const proofBytes = await readBounded(repositoryRoot, vendorPath + '/' + lock.proof.path);
  check(sha256(manifestBytes) === lock.release_set.sha256 && sha256(proofBytes) === lock.proof.sha256, 'release_pin_mismatch');
  const validated = verifyReleaseProof(manifestBytes, proofBytes, proofOptions), manifest = validated.manifest;
  check(lock.source_repository === manifest.source_repository && lock.source_commit === manifest.source_commit, 'source_commit_mismatch');
  check(lock.profiles.every(profile => manifest.profiles.includes(profile)), 'unknown_runtime_profile');
  const pinned = new Map(lock.artifacts.map(item => [item.path, item]));
  check(pinned.size === manifest.artifacts.length && manifest.artifacts.every(item => {
    const pin = pinned.get(item.path);
    return pin && pin.sha256 === item.sha256 && pin.bytes === item.bytes;
  }), 'artifact_pin_mismatch');
  const all = [...manifest.artifacts,
    { path: lock.release_set.path, sha256: lock.release_set.sha256, bytes: manifestBytes.length },
    { path: lock.proof.path, sha256: lock.proof.sha256, bytes: proofBytes.length }];
  const count = await verifyArtifactSet(resolve(repositoryRoot, vendorPath), all);
  // The approved publisher attests the built artifacts; --remote is a legacy
  // source comparison, not an alternate way to approve a v2 release.
  return { format: 'freedom.pin-verification/v1', assurance_level: 'local', status: 'passed',
    profile: 'release_set', release_set_id: manifest.release_set_id, manifest_sha256: validated.manifest_sha256,
    source_commit: manifest.source_commit, artifact_count: count, publisher_trust: validated.publisher_trust,
    environment: validated.environment, remote_source_checked: false, execution_authorized: false,
    library_usage: 'not_checked' };
}

// Receives resolution records from a build analyzer, not package.json alone.
// This checks the records; collecting a trustworthy graph is a separate gate.
export function verifyLibraryResolution(manifest, profile, records) {
  validateReleaseSet(manifest);
  check(manifest.profiles.includes(profile), 'unknown_runtime_profile');
  check(Array.isArray(records) && records.length > 0 && records.length <= MAX_ARTIFACTS, 'resolution_unavailable');
  const libraries = new Map(manifest.libraries.map(item => [item.library_id, item]));
  const artifacts = new Map(manifest.artifacts.map(item => [item.path, item]));
  const seen = new Set();
  for (const record of records) {
    assertSchema(record, { type: 'object', required: ['library_id', 'version', 'artifact_path', 'sha256'], additionalProperties: false,
      properties: { library_id: { type: 'string' }, version: { type: 'string' }, artifact_path: { type: 'string' }, sha256: { type: 'string' } } });
    const library = libraries.get(record.library_id), artifact = artifacts.get(record.artifact_path);
    check(library && library.version === record.version && library.runtime_profiles.includes(profile), 'incompatible_library_resolution');
    check(artifact && library.artifacts.includes(record.artifact_path) && artifact.sha256 === record.sha256, 'library_integrity_mismatch');
    seen.add(record.library_id);
  }
  for (const library of manifest.libraries.filter(item => item.runtime_profiles.includes(profile))) {
    check(seen.has(library.library_id), 'missing_library_resolution');
  }
  return { status: 'passed', assurance_level: 'local', library_count: seen.size };
}
