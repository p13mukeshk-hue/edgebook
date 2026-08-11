#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(deployRoot, '../..');
const read = path => readFileSync(resolve(repoRoot, path), 'utf8');
const failures = [];
const requireText = (value, pattern, label) => {
  if (!pattern.test(value)) failures.push(`Missing: ${label}`);
};
const rejectText = (value, pattern, label) => {
  if (pattern.test(value)) failures.push(`Forbidden: ${label}`);
};
const serviceBlock = (compose, name, nextName) => {
  const start = compose.indexOf(`  ${name}:`);
  const end = nextName ? compose.indexOf(`  ${nextName}:`, start + name.length + 3) : compose.length;
  if (start < 0 || end < 0) {
    failures.push(`Could not isolate Compose service ${name}`);
    return '';
  }
  return compose.slice(start, end);
};

const compose = read('deploy/vps/docker-compose.yml');
const runtimeEnvExample = read('deploy/vps/env/edgebook.env.example');
const rehearsalComposeFixture = read('deploy/vps/env/rehearsal-compose.env.example');
rejectText(compose, /^\s*env_file\s*:/m, 'broad Compose env_file injection');
requireText(read('.github/workflows/edgebook-ci.yml'), /Verify deployment script executable modes[\s\S]*?\[\[ ! -x "\$script" \]\]/, 'CI executable-mode release gate');
requireText(compose, /-\s*["']127\.0\.0\.1:3210:3210["']/, 'loopback-only API port 3210');
rejectText(compose, /0\.0\.0\.0:3210:3210|8787:8787/, 'public/conflicting host port');
requireText(compose, /fetch\('http:\/\/127\.0\.0\.1:3210\/readyz'\)/, 'API healthcheck requires database schema and writable uploads');
rejectText(compose, /fetch\('http:\/\/127\.0\.0\.1:3210\/healthz'\)/, 'liveness-only Docker healthcheck');
requireText(compose, /\.\/deploy\/vps\/postgres\/init\/001-bootstrap\.sh:\/docker-entrypoint-initdb\.d\/001-bootstrap\.sh:ro/, 'bootstrap path is relative to the documented project directory');
const buildContexts = [...compose.matchAll(/^\s+context:\s*(\S+)\s*$/gm)].map(match => match[1]);
if (buildContexts.length !== 2 || buildContexts.some(context => context !== '.')) failures.push('Build contexts must resolve from the documented project directory');

const api = serviceBlock(compose, 'api', 'worker');
for (const secret of ['MIGRATION_DATABASE_URL', 'POSTGRES_SUPERUSER_PASSWORD', 'EDGEBOOK_DB_OWNER_PASSWORD']) {
  rejectText(api, new RegExp(secret), `API receives ${secret}`);
}
requireText(api, /SCHEDULER_ENABLED:\s*["']false["']/, 'web process scheduler disabled');
for (const variable of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_REDIRECT_URI', 'CTRADER_ENCRYPTION_KEYS', 'CTRADER_ACTIVE_KEY_VERSION']) {
  requireText(api, new RegExp(`${variable}:\\s*\\$\\{${variable}:-\\}`), `API permits credentialless staging for ${variable}`);
  requireText(runtimeEnvExample, new RegExp(`^${variable}=$`, 'm'), `example leaves ${variable} blank for credentialless staging`);
  requireText(rehearsalComposeFixture, new RegExp(`^${variable}=$`, 'm'), `Compose rehearsal fixture leaves ${variable} blank`);
}
requireText(runtimeEnvExample, /^# https:\/\/edgebook\.trade\/api\/auth\/ctrader\/callback$/m, 'canonical cTrader callback documented without creating a partial example');
requireText(runtimeEnvExample, /^# CTRADER_ENCRYPTION_KEYS='\{"1":"<43-character-base64url-key>"\}'$/m, 'single-quoted cTrader keyring example');

const worker = serviceBlock(compose, 'worker', 'migrate');
requireText(worker, /profiles:\s*\[["']writer["']\]/, 'writer profile gate');
requireText(worker, /command:\s*\[["']node["'],\s*["']dist\/ctrader\/worker\.js["']\]/, 'dedicated cTrader worker');
rejectText(worker, /MIGRATION_DATABASE_URL|POSTGRES_SUPERUSER_PASSWORD|EDGEBOOK_DB_OWNER_PASSWORD/, 'worker receives database administration secret');
for (const variable of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'CTRADER_REDIRECT_URI', 'CTRADER_ENCRYPTION_KEYS', 'CTRADER_ACTIVE_KEY_VERSION']) {
  requireText(worker, new RegExp(`${variable}:\\s*\\$\\{${variable}:-\\}`), `inactive worker interpolation is blank-safe for ${variable}`);
}
requireText(read('server/src/ctrader/worker.ts'), /if \(!config\.cTrader\.enabled\) throw new Error\(/, 'activated worker fails closed without complete cTrader configuration');
const renderedWorkerGate = read('deploy/vps/scripts/verify-rendered-worker-env.mjs');
for (const requirement of ['CTRADER_REDIRECT_URI', 'CTRADER_ENCRYPTION_KEYS', 'CTRADER_ACTIVE_KEY_VERSION', 'SCHEDULER_ENABLED']) {
  requireText(renderedWorkerGate, new RegExp(requirement), `rendered worker gate checks ${requirement}`);
}
rejectText(renderedWorkerGate, /JSON\.stringify\s*\(\s*(?:model|environment)|console\.log\s*\(\s*(?:model|environment)|process\.stdout\.write\s*\(\s*(?:model|environment)/, 'rendered worker gate logs secret-bearing model');

const migrator = serviceBlock(compose, 'migrate', 'migration-tools');
requireText(migrator, /DATABASE_URL:\s*\$\{MIGRATION_DATABASE_URL:-\}/, 'inactive migrator interpolation is blank-safe and owner URL remains restricted to migrator');
rejectText(migrator, /GOOGLE_CLIENT_ID|SESSION_PEPPER|CTRADER_|POSTGRES_SUPERUSER_PASSWORD|EDGEBOOK_DB_OWNER_PASSWORD/, 'migrator receives unrelated secret');
requireText(rehearsalComposeFixture, /^COMPOSE_PROFILES=$/m, 'Compose rehearsal fixture has no active profiles');
requireText(rehearsalComposeFixture, /^MIGRATION_DATABASE_URL=$/m, 'Compose rehearsal fixture leaves inactive migrator URL blank');

const migrationTools = serviceBlock(compose, 'migration-tools', 'cleanup');
requireText(migrationTools, /profiles:\s*\[["']migration["']\]/, 'Firebase migration tool profile gate');
requireText(migrationTools, /dockerfile:\s*deploy\/vps\/Dockerfile\.migration/, 'isolated migration tool image');
requireText(migrationTools, /MIGRATION_DATABASE_URL:\s*\$\{MIGRATION_DATABASE_URL:-\}/, 'migration tools receive owner URL only when configured');
requireText(migrationTools, /TARGET_DATABASE_URL:\s*\$\{MIGRATION_DATABASE_URL:-\}/, 'snapshot target URL remains inside migration tools');
requireText(migrationTools, /\/srv\/edgebook-migration\/input:\/migration-input:ro/, 'migration input is read-only');
requireText(migrationTools, /\/srv\/edgebook-migration\/output:\/migration-output(?:\s|$)/m, 'migration output is separately writable');
requireText(migrationTools, /\/srv\/edgebook-data\/uploads:\/srv\/edgebook-data\/uploads(?:\s|$)/m, 'migration upload scope is explicit');
rejectText(migrationTools, /GOOGLE_CLIENT_ID|SESSION_PEPPER|CTRADER_|POSTGRES_SUPERUSER_PASSWORD|EDGEBOOK_DB_OWNER_PASSWORD|ports:/, 'migration tools receive unrelated secrets or host ports');
requireText(read('deploy/vps/Dockerfile.migration'), /USER 12001:12001[\s\S]*ENTRYPOINT \["node"\]/, 'non-root migration tool entrypoint');

const cleanup = serviceBlock(compose, 'cleanup', null);
requireText(cleanup, /profiles:\s*\[["']jobs["']\]/, 'cleanup profile gate');
requireText(cleanup, /dist\/uploads\/cleanup\.js/, 'dedicated screenshot cleanup job');
rejectText(cleanup, /MIGRATION_DATABASE_URL|POSTGRES_|CTRADER_|GOOGLE_CLIENT_ID|SESSION_PEPPER/, 'cleanup receives unrelated secret');

const backupScript = read('deploy/vps/scripts/backup-edgebook.sh');
const stackUnit = read('deploy/vps/systemd/edgebook-stack.service');
const backupUnit = read('deploy/vps/systemd/edgebook-backup.service');
const cleanupUnit = read('deploy/vps/systemd/edgebook-cleanup.service');
const tmpfiles = read('deploy/vps/tmpfiles.d/edgebook.conf');
for (const [value, label] of [[backupScript, 'backup script'], [cleanupUnit, 'cleanup unit']]) {
  requireText(value, /\/run\/edgebook\/maintenance\.lock/, `${label} shared maintenance lock`);
  rejectText(value, /\/run\/lock\/edgebook-maintenance\.lock/, `${label} unprovisioned legacy lock`);
}
requireText(backupUnit, /ReadWritePaths=[^\n]*\/run\/edgebook/, 'backup unit writable lock directory');
requireText(cleanupUnit, /ReadWritePaths=[^\n]*\/run\/edgebook/, 'cleanup unit writable lock directory');
requireText(tmpfiles, /^d \/run\/edgebook 0750 root root -$/m, 'volatile maintenance lock directory provisioning');
for (const directory of ['input', 'output']) {
  requireText(tmpfiles, new RegExp(`^d \/srv\/edgebook-migration\/${directory} 0700 12001 12001 -$`, 'm'), `private migration ${directory} directory`);
}
requireText(stackUnit, /^ExecStop=.*--profile writer stop --timeout 30 worker api postgres$/m, 'stack stop always includes profiled worker');

const nginx = read('deploy/vps/nginx/edgebook.conf');
requireText(nginx, /server_name\s+www\.edgebook\.trade;/, 'www canonical redirect server');
requireText(nginx, /location = \/api\/events\s*\{[\s\S]*?proxy_buffering off;[\s\S]*?proxy_read_timeout 1h;/, 'unbuffered long-lived SSE proxy');
requireText(nginx, /~\^\/api\/\s+"private, no-store";/, 'API response no-store cache map');
requireText(nginx, /\/api\/events\s+"private, no-store, no-transform";/, 'SSE no-store/no-transform cache map');
requireText(nginx, /location = \/api\/auth\/ctrader\/callback\s*\{[\s\S]*?access_log off;/, 'OAuth callback access logging disabled');
requireText(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/, 'unspoofable forwarded client IP');
requireText(nginx, /proxy_set_header Host edgebook\.trade;/, 'canonical upstream Host');
requireText(nginx, /proxy_set_header X-Forwarded-Proto https;/, 'fixed HTTPS forwarded protocol');
rejectText(nginx, /proxy_set_header Host \$host;|proxy_set_header X-Forwarded-Proto \$scheme;/, 'client-derived canonical upstream origin');
requireText(nginx, /Content-Security-Policy/, 'production CSP');
requireText(nginx, /Permissions-Policy\s+"camera=\(\), microphone=\(self\), geolocation=\(\)"/, 'first-party-only microphone permission for journal dictation');
rejectText(nginx, /cloudfunctions\.net|firebaseio\.com|firebasestorage|www\.gstatic\.com\/firebasejs/, 'Firebase/Cloud Functions origin in production proxy policy');

const build = read('deploy/vps/scripts/build-public.sh');
for (const publicFile of ['client/api-client.js', 'client/auth-adapter.js', 'client/data-adapter.js']) {
  requireText(build, new RegExp(publicFile.replace(/[./]/g, '\\$&')), `allowlisted public file ${publicFile}`);
}
requireText(build, /--mode rehearsal\|cutover/, 'separate rehearsal/cutover artifacts');
requireText(build, /firebaseDependency["']?:false/, 'VPS-only artifact marker');
requireText(build, /sha256sum "\$destination\/client\/\$asset\.js"/, 'content-derived client adapter cache version');
requireText(build, /sed -i [^\n]*client\/\$asset\.js\?v=\$asset_hash/, 'versioned module imports in every public page');
requireText(build, /! -e "\$destination\/client\/firebase-fallback\.js"/, 'Firebase fallback module absence gate');
rejectText(build, /install[^\n]*firebase-fallback\.js/, 'Firebase fallback module copied into VPS artifact');
rejectText(build, /sed[^\n]*enableFirebaseFallback/, 'artifact-only fallback flag rewrite');

for (const page of ['app.html', 'index.html', 'landing.html']) {
  rejectText(read(page), /enableFirebaseFallback|firebase-fallback|www\.gstatic\.com\/firebasejs/, `${page} Firebase runtime dependency`);
}
rejectText(read('404.html'), /Firebase Command-Line Interface|Firebase Hosting/i, 'Firebase-branded production 404 page');
requireText(read('404.html'), /Edgebook/i, 'Edgebook-branded production 404 page');
if (existsSync(resolve(repoRoot, 'client', 'firebase-fallback.js'))) failures.push('Firebase fallback runtime module must be removed from source');
rejectText(read('app.html'), /https:\/\/[^'"\s]*cloudfunctions\.net/, 'active Cloud Functions endpoint in app');

const firebase = JSON.parse(read('firebase.json'));
if (Object.keys(firebase).length !== 0) failures.push('firebase.json must remain fail-closed with no deploy targets');
if (['index.js', 'package.json', 'package-lock.json'].some(file => existsSync(resolve(repoRoot, 'functions', file)))) {
  failures.push('active root functions/ runtime must remain tag-archived, not deployable');
}

if (failures.length) {
  process.stderr.write(`Deployment verification failed:\n${failures.map(item => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Deployment verification passed.\n');
}
