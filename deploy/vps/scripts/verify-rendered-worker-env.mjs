#!/usr/bin/env node

// Reads `docker compose config --format json` from stdin and validates only the
// activation-critical worker settings. It never prints rendered values because
// the Compose model contains production secrets.

const chunks = [];
let totalBytes = 0;
for await (const chunk of process.stdin) {
  totalBytes += chunk.length;
  if (totalBytes > 5 * 1024 * 1024) throw new Error('rendered Compose model exceeds the 5 MiB validation limit');
  chunks.push(chunk);
}
if (totalBytes === 0) throw new Error('expected rendered Compose JSON on stdin');
const model = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const worker = model?.services?.worker;
if (!worker || !Array.isArray(worker.profiles) || !worker.profiles.includes('writer')) {
  throw new Error('rendered Compose model does not contain the profiled cTrader worker');
}
const environment = worker.environment || {};
const alwaysRequired = [
  'CTRADER_ENCRYPTION_KEYS',
  'CTRADER_ACTIVE_KEY_VERSION',
];
for (const name of alwaysRequired) {
  if (typeof environment[name] !== 'string' || !environment[name].trim()) {
    throw new Error(`rendered worker environment is missing ${name}`);
  }
}
const oauthNames = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_REDIRECT_URI'];
const oauthConfigured = oauthNames.filter(name => typeof environment[name] === 'string' && environment[name].trim()).length;
if (oauthConfigured !== 0 && oauthConfigured !== oauthNames.length) {
  throw new Error('rendered worker has a partial official cTrader OAuth configuration');
}
const mcpEnabled = String(environment.CTRADER_MCP_ENABLED).toLowerCase() === 'true';
if (oauthConfigured === 0 && !mcpEnabled) {
  throw new Error('rendered worker needs official cTrader OAuth or MCP compatibility');
}
if (oauthConfigured === oauthNames.length && environment.CTRADER_REDIRECT_URI !== 'https://edgebook.trade/api/auth/ctrader/callback') {
  throw new Error('rendered worker cTrader callback is not the canonical HTTPS origin');
}
if (String(environment.SCHEDULER_ENABLED).toLowerCase() !== 'true') {
  throw new Error('rendered worker SCHEDULER_ENABLED must equal true at activation');
}
const activeVersion = String(environment.CTRADER_ACTIVE_KEY_VERSION);
if (!/^[1-9][0-9]*$/.test(activeVersion)) throw new Error('rendered worker active key version is invalid');
let keyring;
try { keyring = JSON.parse(environment.CTRADER_ENCRYPTION_KEYS); }
catch { throw new Error('rendered worker cTrader encryption keyring is not valid JSON'); }
if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring) || !Object.hasOwn(keyring, activeVersion)) {
  throw new Error('rendered worker active encryption key version is absent from the keyring');
}
for (const [version, encoded] of Object.entries(keyring)) {
  if (!/^[1-9][0-9]*$/.test(version) || typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('rendered worker keyring contains an invalid version or base64url key');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) {
    throw new Error('rendered worker keyring values must be canonical 32-byte base64url keys');
  }
}
const apiEnvironment = model?.services?.api?.environment || {};
for (const name of [...alwaysRequired, ...oauthNames, 'CTRADER_MCP_ENABLED']) {
  if (apiEnvironment[name] !== environment[name]) {
    throw new Error(`rendered API/worker cTrader setting differs for ${name}`);
  }
}
if (String(apiEnvironment.SCHEDULER_ENABLED).toLowerCase() !== 'false') {
  throw new Error('rendered API process must keep scheduling disabled');
}
process.stdout.write('Rendered cTrader worker environment passed structural validation (values redacted).\n');
