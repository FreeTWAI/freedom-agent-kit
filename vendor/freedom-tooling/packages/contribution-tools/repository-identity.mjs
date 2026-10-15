// Only the reviewed repository-set transport changes. Published manifests,
// signatures, source commits and vendor bytes keep their recorded identity.
export const PLATFORM_REPOSITORY = 'FreeTWAI/freedom-platform';
export const HISTORICAL_PLATFORM_REPOSITORY = 'FreeTWAI-AI/freedom-platform';
const names = ['freedom-platform', '.github', 'freedom-agent-kit',
  'freedom-growth-automation', 'freedom-project-page', 'freedom-project-template',
  'freedom-skill-registry', 'freedom-storefront', 'freedom-supplier-client'];
const transports = new Map(names.map(name => ['FreeTWAI-AI/' + name, 'FreeTWAI/' + name]));
transports.set('FreeTWAI-AI/FreeTWAI-AI.github.io', 'FreeTWAI/FreeTWAI.github.io');
const current = new Set(transports.values());

export function repositoryTransport(recorded) {
  if (current.has(recorded)) return recorded;
  if (transports.has(recorded)) return transports.get(recorded);
  throw Error('unsupported_repository_transport');
}
export function matchesRecordedRepository(recorded, repository) {
  // The host's actual identity must be current; aliases apply only to records.
  return current.has(repository) && (recorded === repository || transports.get(recorded) === repository);
}
export function isPlatformSourceRepository(recorded) {
  return recorded === PLATFORM_REPOSITORY || recorded === HISTORICAL_PLATFORM_REPOSITORY;
}
