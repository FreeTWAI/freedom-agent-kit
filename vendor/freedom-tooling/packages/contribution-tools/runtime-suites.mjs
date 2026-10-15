// Central, reviewed suite IDs only. Descriptor data never supplies executable
// paths, arguments or commands. Full coverage retains this baseline and also
// discovers new direct *.test.ts files; deleting baseline tests is not a pass.
const paths = names => names.map(name => `tests/runtime/${name}.test.ts`);
export const RUNTIME_SUITES = Object.freeze(Object.fromEntries(Object.entries({
  'runtime.command-core': ['command-core'],
  'runtime.guild-blocks': ['guild-blocks'],
  'runtime.guild-presentation': ['guild-blocks', 'guild-launchpad', 'guild-launchpad-contracts', 'guild-launchpad-profiles', 'launchpad-profile-defaults'],
  'runtime.resource-scopes': ['resource-scopes'],
  'runtime.scoped-member-command': ['scoped-member-command'],
  'runtime.avatar': ['avatar', 'image-runtime', 'image-cloudflare'],
  'runtime.member-card': ['member-ecard', 'member-directory', 'social-links', 'member-card-qr'],
  'runtime.member-reporting': ['member-reporting'],
  'runtime.work': ['flows', 'benefits', 'co-creation'],
  'runtime.work-privacy': ['work-privacy'],
  'runtime.personal-content': ['personal-content', 'community-relations', 'community-search', 'work-privacy'],
  'runtime.preview-protocol': ['preview-protocol'],
  'runtime.event-outcomes': ['event-outcomes', 'squad-outcomes', 'event-highlights', 'event-highlight-assets', 'worker-adapter'],
}).map(([id, names]) => [id, Object.freeze(paths(names))])));

// Reviewed consumer adapters share the same bounded reporter/process runner.
// They never invoke package scripts or receive the producer's database URL.
export const NODE_CONSUMER_SUITES = Object.freeze({
  'consumer.agent-kit': Object.freeze({ directory: 'tests', baseline: Object.freeze(['tests/workspace.test.mjs']) }),
  'consumer.storefront': Object.freeze({ directory: 'tests', baseline: Object.freeze(['tests/read-client.test.mjs', 'tests/storefront.test.mjs', 'tests/templates.test.mjs']) }),
});

// Fixed producer files. No directory discovery, package hook, or database URL.
// The list is host code; a descriptor cannot add or replace a path.
export const FIXED_NODE_SUITES = Object.freeze({
  'e2e.harness': Object.freeze(['scripts/run-e2e.test.mjs']),
});

export const FULL_RUNTIME_BASELINE = Object.freeze(paths(`
newcomer-guides newcomer-guide-dialogue guide-anchors guide-pack-assets
chat-content direct-message-receipts member-card-qr member-session-lifecycle
admin-access-session admin-access-sync admin-access admin-appointments admin-guild-candidates admin-sync-worker
agent-commerce agent-connections agent-connections-adversarial asset-authority-compatibility asset-engine asset-lifecycle-races asset-lifecycle asset-maintenance asset-r2 asset-storage asset-media-profiles media-inventory media-backup-coordinator avatar avatar-bridge
avatar-command-compat avatar-upload benefits bootstrap-contracts bootstrap-http bootstrap-http-contracts bootstrap-issuer bootstrap-proof bootstrap-session-contracts bootstrap-session-proof bootstrap-sessions bootstrap-sessions-adversarial bootstrap-status bootstrap-status-adversarial client-connections co-creation
command-core commerce community-search credential-ingest-authorizations credential-ingest-broker credential-ingest-process credential-ingest-adversarial credential-broker-store credential-broker-crypto credential-broker-adversarial development-access-grant-race development-access development-map device-authorizations device-authorizations-adversarial device-pairing-contracts device-pairing-proof e2e-auth-isolation
event-highlights events-past execution-authority-adversarial execution-prerequisites execution-runs execution-runs-adversarial execution-runs-grants execution-state execution-state-adversarial fixed-behavior-harness flows freedom_env game-console-feed game-console-routing game-console
generator-drift github-app-setup github-history github-identity github-repository-read github-social-routes github-social-store
github-social github-sync guild-category-preferences guild-entry-questions guild-experts guild-member-tiers guild-preferences guild-profile
guild-workspace guild-launchpad guild-launchpad-contracts guild-launchpad-deadline identity-member image-cloudflare image-runtime link-preview maintainer-worker member-execution-contracts member-execution-http member-execution-http-adversarial member-execution-http-contracts member-channel-access
member-blocking member-reporting member-channels-core member-communications member-connections member-directory member-ecard member-experience
model-broker-authorizations model-broker-bridge model-broker-client model-broker-process model-broker-bridge-adversarial
model-step-service model-step-contracts model-step-adversarial member-model-http member-model-http-adversarial
member-model-settings member-model-settings-adversarial member-model-settings-process
member-device-bootstrap-http member-device-bootstrap-adversarial member-device-browser member-device-client
machine-text-proof machine-text-authority scoped-command-context private-ai-path
machine-model-execution machine-model-http machine-model-revocation machine-model-broker
agent-commerce-key-expiry shop-service-command shop-service-identity shop-key-exit
model-adapter-common model-adapter-independent model-adapter-registry model-byok-adapter model-claude-adapter model-cli-probe model-codex-adapter
member-services member-skill-registration notification-events onboarding-diagnostics onboarding opensource-marketing
page-github page-issue-label page-tools-notification password-hash password-recovery email-change platform-admin platform-credentials
portal-client-recovery positioning preview-protocol private-policy-grants private-result-races private-result-schema private-results private-work-commands private-work-http private-work-http-adversarial private-work-policy private-work-policy-adversarial published-skills repo-author-claims repo-maintainer-admin
repo-maintainer-claims repo-maintainer-guild repo-maintainer-handoff repo-maintainer-policy repo-maintainer-sync
repo-maintainer-webhook resource-scopes runtime-proof runtime-registration runtime-registration-adversarial runtime-registration-contracts runtime-registration-grants scoped-member-command scoped-member-domain-revalidation scoped-tenant-domain-revalidation share-promotion skill-book-guides skill-book-upstreams
skill-collaboration skill-discovery skill-share-content skill-sharing skill-submission-upgrades skill-submissions
skill-upload-chat skill-upload-client social-links squad-invitations tenant-authority-policy-grants tenant-authorization tenant-data-catalog tenant-data-isolation tenant-high-risk-verification tenant-instance-permissions tenant-membership-identity tenant-ownership tenant-ownership-transfer tenant-policy-operator tenant-read-deadline tenant-recovery tenant-rls-b2a-runtime-role tenant-rls-runtime-role tenant-snapshot-evidence-rls tenant-transaction tenant-work tenant-work-authority-races tenant-work-schema verification-test-data work-privacy work-result-client worker-adapter tenant-rls-retarget tenant-route-matrix module-registry module-registry-review module-registry-rls-runtime-role module-provisioning module-capacity module-registry-schema module-instance-lifecycle module-instance-archive
guild-launchpad-journey
ai-sister-guides asset-http-range auth-pruning community-discovery credential-ingest-rate-budget credential-setup-ui domain-media-gc domain-media-policy-grants
event-banner-assets event-create-rate-limit event-highlight-assets event-video-assets link-preview-egress login-lockout-recovery machine-device-client media-accepted-formats-playback
media-backup-archive media-backup-daily media-backup-evidence media-backup-retention media-backup-transfer media-domain-bridge media-recovery-bundle media-session-recovery
media-verify member-service-cursor migration-runner-plan model-step-revocation-races native-text-invocation native-text-process openrouter-byok operator-avatar-backfill
operator-banner-social-backfill operator-event-video-backfill operator-media-backfill operator-media-runtime-grants operator-skill-highlight-backfill organization-project-editing platform-json-body private-ai-preflight
session-cookie-security social-preview-assets social-thumbnail-assets verify-guild-work worker-private-ai-ingest
storefront-presentation-contracts hosted-store-media-contracts hosted-store-photo-state hosted-store-photo storefront-product-photo-core storefront-product-photo-sql storefront-product-photo-native hosted-store hosted-store-isolation hosted-order-contracts hosted-order-http hosted-order-http-contracts hosted-seller-orders hosted-seller-order-ui hosted-order-ui hosted-direct-orders hosted-store-offering
guild-launchpad-profiles launchpad-profile-defaults production-dossier positioning-action-card
message-images message-image-ack message-image-upload-reader message-image-preview json-wire
personal-content community-relations first-participation social-feed social-post-edit social-share notification-preferences
event-participation-api event-participation-reminders event-reminders-delivery event-waitlist
event-outcomes squad-outcomes
participation-metrics
`.trim().split(/\s+/)).sort());
