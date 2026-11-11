#!/usr/bin/env node
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  appendNdjson,
  canonicalJson,
  encodeFirestoreValue,
  openNdjson,
  parseArgs,
  redactBrokerCredentials,
  sha256File,
} from '../lib/bundle.mjs';

function usage(message) {
  if (message) process.stderr.write(`ERROR: ${message}\n\n`);
  process.stderr.write(`Usage:
  node scripts/export-firebase.mjs --output /secure/new-directory [options]

Options:
  --project-id ID          Firebase project ID (or GCLOUD_PROJECT)
  --uid UID                Export only one user's Auth/Firestore/Storage data
  --storage-bucket NAME    Bucket name; required with --download-storage
  --download-storage       Copy users/*/screenshots objects into the bundle

Authentication uses Application Default Credentials. Never put a service-account
key in this repository. The output directory must not already exist.
`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args.output || args.output === true) usage('--output is required');
if (!isAbsolute(args.output)) usage('--output must be an absolute path');
if (args.uid === true) usage('--uid requires a Firebase UID');
if (args['project-id'] === true) usage('--project-id requires a value');
if (args['download-storage'] && !args['storage-bucket']) {
  usage('--storage-bucket is required with --download-storage');
}

const outputDir = resolve(args.output);
await mkdir(dirname(outputDir), { recursive: true, mode: 0o700 });
try {
  await stat(outputDir);
  usage(`output directory already exists: ${outputDir}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(outputDir, { mode: 0o700 });

const projectId = args['project-id'] || process.env.GCLOUD_PROJECT;
const app = initializeApp({
  credential: applicationDefault(),
  ...(projectId ? { projectId } : {}),
  ...(args['storage-bucket'] ? { storageBucket: args['storage-bucket'] } : {}),
});
const db = getFirestore(app);
const auth = getAuth(app);

const authPath = resolve(outputDir, 'auth-users.ndjson');
const firestorePath = resolve(outputDir, 'firestore.ndjson');
const storageIndexPath = resolve(outputDir, 'storage.ndjson');
const authOut = await openNdjson(authPath);
const firestoreOut = await openNdjson(firestorePath);
const storageOut = await openNdjson(storageIndexPath);

const counts = {
  authUsers: 0,
  firestoreDocuments: 0,
  documentsRedacted: 0,
  brokerDocumentsRedacted: 0,
  redactedCredentialFields: 0,
  storageObjects: 0,
};
const firestoreCollections = {};

function safeUserRecord(user) {
  const record = {
    uid: user.uid,
    email: user.email || null,
    emailVerified: Boolean(user.emailVerified),
    displayName: user.displayName || null,
    photoURL: user.photoURL || null,
    disabled: Boolean(user.disabled),
    providers: [...(user.providerData || [])].sort((left, right) =>
      `${left.providerId}:${left.uid}`.localeCompare(`${right.providerId}:${right.uid}`)).map((provider) => ({
      providerId: provider.providerId,
      uid: provider.uid,
      email: provider.email || null,
      displayName: provider.displayName || null,
      photoURL: provider.photoURL || null,
    })),
    metadata: {
      creationTime: user.metadata?.creationTime || null,
      lastSignInTime: user.metadata?.lastSignInTime || null,
    },
  };
  return redactBrokerCredentials(record).value;
}

async function exportAuthUsers() {
  if (args.uid) {
    const user = await auth.getUser(args.uid);
    await appendNdjson(authOut, safeUserRecord(user));
    counts.authUsers += 1;
    return;
  }
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of [...page.users].sort((left, right) => left.uid.localeCompare(right.uid))) {
      await appendNdjson(authOut, safeUserRecord(user));
      counts.authUsers += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);
}

async function exportDocument(docRef) {
  const snapshot = await docRef.get();
  if (snapshot.exists) {
    let data = encodeFirestoreValue(snapshot.data());
    const redaction = redactBrokerCredentials(data);
    data = redaction.value;
    const redactedFields = redaction.redacted;
    if (redactedFields.length) {
      counts.documentsRedacted += 1;
      counts.redactedCredentialFields += redactedFields.length;
      if (/^users\/[^/]+\/brokers\/[^/]+$/.test(docRef.path)) {
        counts.brokerDocumentsRedacted += 1;
      }
    }
    const segments = docRef.path.split('/');
    const collectionPath = segments.slice(0, -1).join('/');
    firestoreCollections[collectionPath] = (firestoreCollections[collectionPath] || 0) + 1;
    await appendNdjson(firestoreOut, {
      path: docRef.path,
      data,
      createTime: snapshot.createTime?.toDate?.().toISOString() || null,
      updateTime: snapshot.updateTime?.toDate?.().toISOString() || null,
      redactedFields,
    });
    counts.firestoreDocuments += 1;
  }
  const subcollections = (await docRef.listCollections()).sort((left, right) => left.id.localeCompare(right.id));
  for (const collection of subcollections) await exportCollection(collection);
}

async function exportCollection(collectionRef) {
  if (collectionRef.id === 'pendingAuth') return;
  const documentRefs = (await collectionRef.listDocuments()).sort((left, right) => left.path.localeCompare(right.path));
  for (const docRef of documentRefs) await exportDocument(docRef);
}

async function exportFirestoreUsers() {
  if (args.uid) {
    await exportDocument(db.collection('users').doc(args.uid));
    return;
  }
  await exportCollection(db.collection('users'));
}

function assertSafeObjectName(name) {
  const parts = name.split('/');
  if (!name || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) ||
      parts.some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error(`Unsafe Storage object name: ${name}`);
  }
}

async function exportStorage() {
  if (!args['download-storage']) return;
  const storageRoot = resolve(outputDir, 'storage');
  await mkdir(storageRoot, { recursive: false, mode: 0o700 });
  const bucket = getStorage(app).bucket(args['storage-bucket']);
  const prefix = args.uid ? `users/${args.uid}/screenshots/` : 'users/';
  const [files] = await bucket.getFiles({ prefix });
  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    assertSafeObjectName(file.name);
    if (!args.uid && !/^users\/[^/]+\/screenshots\//.test(file.name)) continue;
    const destination = resolve(storageRoot, ...file.name.split('/'));
    const rel = relative(storageRoot, destination);
    if (rel.startsWith(`..${sep}`) || rel === '..') throw new Error(`Object escaped storage root: ${file.name}`);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await file.download({ destination });
    const [metadata] = await file.getMetadata();
    const sha256 = await sha256File(destination);
    await appendNdjson(storageOut, {
      name: file.name,
      localPath: `storage/${file.name}`,
      size: Number(metadata.size || 0),
      contentType: metadata.contentType || null,
      md5Hash: metadata.md5Hash || null,
      crc32c: metadata.crc32c || null,
      updated: metadata.updated || null,
      sha256,
    });
    counts.storageObjects += 1;
  }
}

try {
  await exportAuthUsers();
  await exportFirestoreUsers();
  await exportStorage();
} finally {
  await Promise.all([authOut.close(), firestoreOut.close(), storageOut.close()]);
}

const files = {};
for (const name of ['auth-users.ndjson', 'firestore.ndjson', 'storage.ndjson']) {
  files[name] = await sha256File(resolve(outputDir, name));
}

const manifest = {
  formatVersion: 1,
  createdAt: new Date().toISOString(),
  projectId: projectId || app.options.projectId || null,
  scope: args.uid ? { type: 'user', uid: args.uid } : { type: 'all-users' },
  includesStorageObjects: Boolean(args['download-storage']),
  credentialsPolicy: {
    brokerCredentials: 'redacted',
    pendingAuth: 'not-exported',
    firebasePasswordHashes: 'not-exported',
    legacyCtraderTokens: 'not-migrated; fresh official OAuth required',
  },
  counts,
  firestoreCollections,
  files,
};
await writeFile(resolve(outputDir, 'manifest.json'), `${canonicalJson(manifest)}\n`, { mode: 0o600, flag: 'wx' });

process.stdout.write(`${JSON.stringify({ outputDir: await realpath(outputDir), counts }, null, 2)}\n`);
