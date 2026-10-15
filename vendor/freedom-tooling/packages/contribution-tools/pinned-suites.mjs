// Reviewed host data. Package scripts, globs and descriptors never change a suite.
// A directory suite runs its baseline plus every candidate file in its directory
// that matches its pattern: a candidate can add tests but cannot drop a baseline
// file. To remove or rename a baseline test, edit its baseline here on main in a
// reviewed PR. CI runs the pinned copy (job.workflow_sha), so the change applies
// from the next central pin upgrade, and the old file must stay until then.

const paths = (dir, ext, text) => Object.freeze(text.trim().split(/\s+/).map(name => `${dir}/${name}${ext}`));

const GOVERNANCE_BASELINE = paths('packages/contribution-tools/test', '.test.mjs', `
agent-kit-device-fixture agent-kit-device-profile behavior-harness-adversarial behavior-harness
behavior-supervisor checkout-repositories consumer-entry-coverage consumer-libraries
consumer-runtime-recipe consumer-source-profiles consumer-workspace context contracts
directory-build export github-app-publisher github-behavior-host github-consumer-host
github-consumer-profiles github-trusted-adapter io machine-device-cli pinned-e2e pinned-suite runtime-matrix
runtime-sharding runtime-weights suite-runner supervisor-create-lifecycle surface-adversarial surface-audit
test-reporter-progress trusted-ci
`);

const SKILL_CLIENT_BASELINE = paths('packages/skill-upload-client/test', '.test.mjs', `
cli
`);

const WORKER_BASELINE = paths('tests/worker', '.test.ts', `
authority-hardening authority-http-protocol avatar-assets broker-ingest-worker broker-worker-sql
broker-worker credential-ingest-diagnostic event-banner-assets event-highlight-assets
event-video-assets fetch-redirect github-sync-scheduled guide-pack-assets maintainer-scheduled
media-accepted-formats media-object-io media-operator-caller media-operator-images-worker
media-operator-private-worker media-operator-worker migration-maintenance
openrouter-acceptance-guard openrouter-native-owner-harness openrouter-provider
private-ai-composition private-ai-ingest private-ai-key-correspondence private-ai-native-owner-flow
private-ai-service-binding service-cover-assets share-go skill-image-assets social-preview-assets
social-thumbnail-assets workerd
`);

const DEPLOY_PREFLIGHT_BASELINE = paths('deploy/cloudflare/test', '.test.mjs', `
broker-wrangler guide-r2-purposes isolated-candidate media-caller media-restore-container
media-wrangler migration-operator migration-plan migration-reviewed-privileges preflight
release-agent-connections release-bootstrap-session release-bootstrap-status
release-compatibility-adversarial release-compatibility release-credential-broker
release-credential-ingest release-device-authorization release-domain-media release-execution-run
release-history-floor-adversarial release-member-device-management release-member-model-settings
release-member-prerequisites release-model-result release-model-step release-runtime-enrollment
shop-key-policy
`);

const CONTRACTS_PYTEST_BASELINE = Object.freeze([
  ...paths('docs/platform-plan/contracts/tests', '.py', `
test_client_credential_manifest test_domain_skill_overlay_contract test_five_clock_invariants
test_github_mock_semantics test_low_ops_contracts test_membership_submission_contract
test_portable_bundle_boundaries test_repository_manifest_identity test_retract_contract_parity
test_retracted_receipt_replay test_reviewer_appointment_entitlement test_settlement_execution_modes
test_work_reviewer_capacity test_xp_projection_rebuild
  `),
  ...paths('docs/platform-plan/execution/tools/tests', '.py', `
test_check_package_dag test_check_specs
  `)
].sort());

export const PINNED_SUITES = Object.freeze({
  'ci.governance-unit': Object.freeze({ directory: 'packages/contribution-tools/test', pattern: /^[a-z][a-z0-9-]*\.test\.mjs$/, baseline: GOVERNANCE_BASELINE, loader: 'node', database: false, timeoutMs: 300000, env: Object.freeze([]) }),
  'ci.selector-unit': Object.freeze({ files: Object.freeze(['scripts/ci/select-affected-jobs.test.mjs', 'scripts/ci/guild-presentation-profile.test.mjs']), loader: 'node', database: false, timeoutMs: 180000, env: Object.freeze([]) }),
  'ci.skill-client-unit': Object.freeze({ directory: 'packages/skill-upload-client/test', pattern: /^[a-z][a-z0-9_-]*\.test\.mjs$/, baseline: SKILL_CLIENT_BASELINE, loader: 'node', database: false, timeoutMs: 180000, env: Object.freeze([]) }),
  'ci.worker-unit': Object.freeze({ directory: 'tests/worker', pattern: /^[a-z][a-z0-9_-]*\.test\.ts$/, baseline: WORKER_BASELINE, loader: 'tsx', database: true, timeoutMs: 900000, env: Object.freeze(['HOME', 'FREEDOM_WORKERD_BUNDLE_DIR']) }),
  'ci.deploy-preflight': Object.freeze({ directory: 'deploy/cloudflare/test', pattern: /^[a-z][a-z0-9_-]*\.test\.mjs$/, baseline: DEPLOY_PREFLIGHT_BASELINE, loader: 'node', database: false, timeoutMs: 180000, env: Object.freeze([]) }),
  'ci.migration-postgres': Object.freeze({ files: Object.freeze(['tests/integration/migration-plan-postgres.test.ts', 'tests/integration/migration-entrypoints-postgres.test.ts', 'tests/runtime/migration-runner-plan.test.ts']), loader: 'tsx', database: false, timeoutMs: 600000, env: Object.freeze(['HOME', 'DOCKER_HOST', 'DOCKER_CONFIG']) }),
  'ci.consumer-repositories': Object.freeze({ files: Object.freeze(['tests/integration/repositories.test.ts', 'tests/integration/consumer-libraries.test.ts']), loader: 'tsx', database: true, timeoutMs: 600000, env: Object.freeze(['HOME', 'FREEDOM_REPOSITORIES_ROOT', 'FREEDOM_CONSUMER_SOURCE_COMMIT', 'FREEDOM_AGENT_KIT_ROOT', 'FREEDOM_STOREFRONT_ROOT', 'FREEDOM_SUPPLIER_CLIENT_ROOT', 'FREEDOM_SUPPLIER_SOURCE_COMMIT']) }),
  'ci.runtime-union-integration': Object.freeze({ files: Object.freeze(['tests/contribution-tools/runtime-union.integration.test.mjs']), loader: 'node', database: false, timeoutMs: 600000, env: Object.freeze([]) }),
  'ci.runtime-sharding-integration': Object.freeze({ files: Object.freeze(['tests/contribution-tools/runtime-sharding.integration.test.mjs']), loader: 'node', database: true, timeoutMs: 600000, env: Object.freeze([]) }),
  'ci.contracts-pytest': Object.freeze({ directories: Object.freeze(['docs/platform-plan/contracts/tests', 'docs/platform-plan/execution/tools/tests']), pattern: /^test_[a-z0-9_]+\.py$/, baseline: CONTRACTS_PYTEST_BASELINE, loader: 'pytest', database: false, timeoutMs: 300000, env: Object.freeze(['HOME']) }),
  'ci.pinned-pytest-integration': Object.freeze({ files: Object.freeze(['tests/contribution-tools/pinned-pytest.integration.test.mjs']), loader: 'node', database: false, timeoutMs: 300000, env: Object.freeze([]) })
});
