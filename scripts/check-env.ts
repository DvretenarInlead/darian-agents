/**
 * Environment preflight (code-review). Run before/at deploy to fail fast with a
 * clear list of what's configured vs missing, instead of discovering a missing
 * secret when a feature first runs. Hard-fails only on true requirements
 * (DATABASE_URL, and a malformed ENVELOPE_MASTER_KEY); everything else is
 * reported as a per-feature readiness checklist.
 *
 *   node dist/scripts/check-env.js     # or: pnpm tsx scripts/check-env.ts
 */
import { loadConfig } from '../src/config/index.js';

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
}
function missing(label: string): void {
  console.log(`  ✗ ${label}`);
}

function main(): void {
  let hardFail = false;

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('Config invalid (DATABASE_URL is required):\n', (err as Error).message);
    process.exit(1);
  }

  console.log('Core:');
  ok('DATABASE_URL set');
  if (cfg.envelope.masterKey) {
    const len = Buffer.from(cfg.envelope.masterKey, 'base64').length;
    if (len === 32) ok('ENVELOPE_MASTER_KEY valid (32 bytes)');
    else {
      missing(`ENVELOPE_MASTER_KEY must be 32 bytes base64 (got ${len})`);
      hardFail = true;
    }
  } else {
    missing('ENVELOPE_MASTER_KEY unset — envelope encryption (transcripts, MFA seeds) will throw when used');
  }

  const features: Array<[string, boolean]> = [
    ['Meeting extraction / board (ANTHROPIC_API_KEY)', Boolean(cfg.anthropic.apiKey)],
    ['Fireflies transcript fetch (FIREFLIES_API_KEY)', Boolean(cfg.fireflies.apiKey)],
    ['Webhook receiver mounted (FIREFLIES_WEBHOOK_SECRET)', Boolean(cfg.fireflies.webhookSecret)],
    ['HubSpot sync (HUBSPOT_ACCESS_TOKEN)', Boolean(cfg.hubspot.accessToken)],
    ['HubSpot admin-mode owner resolution (HUBSPOT_SERVICE_KEY)', Boolean(cfg.hubspot.serviceKey)],
    ['Repo scoring (GITHUB_TOKEN)', Boolean(cfg.github.token)],
    ['Off-box audit shipping (AUDIT_SHIP_ENDPOINT)', Boolean(cfg.auditShip.endpoint)],
  ];
  console.log('\nFeatures (unset = that capability is simply inactive):');
  for (const [label, present] of features) (present ? ok : missing)(label);

  console.log(hardFail ? '\nPreflight FAILED.' : '\nPreflight OK.');
  process.exit(hardFail ? 1 : 0);
}

main();
