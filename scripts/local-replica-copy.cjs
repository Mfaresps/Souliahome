#!/usr/bin/env node
'use strict';
// Explicit, local development only. Never loads .env, starts Nest, or overwrites a database.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
const { MongoClient, BSON } = localRequire('mongodb');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => BSON.EJSON.stringify(value, { relaxed: false });
const decode = value => BSON.EJSON.parse(value, { relaxed: false });
const indexSpec = index => Object.fromEntries(Object.entries(index).filter(([k]) => !['v', 'ns'].includes(k)));
function indexSignature(indexes) {
  return encode(indexes.map(indexSpec).sort((a, b) => a.name.localeCompare(b.name)));
}
function localUri(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'mongodb:' || !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
      parsed.username || parsed.password || !/^\/[a-zA-Z0-9_-]+$/.test(parsed.pathname)) {
    throw Error('Explicit unauthenticated loopback development database required');
  }
  return parsed;
}
async function inventory(db) {
  const collections = await db.listCollections().toArray();
  if (collections.some(c => c.type !== 'collection' || c.name.startsWith('system.') || Object.keys(c.options || {}).length)) {
    throw Error('Nonstandard collection options require separate review');
  }
  return collections.sort((a, b) => a.name.localeCompare(b.name));
}
async function fingerprint(db, name, onDocument) {
  const hash = createHash('sha256'); let count = 0;
  for await (const raw of db.collection(name).find({}, { raw: true }).sort({ _id: 1 })) {
    if (!Buffer.isBuffer(raw)) throw Error('Raw BSON cursor required');
    hash.update(raw); count++;
    if (onDocument) await onDocument(raw);
  }
  return { count, sha256: hash.digest('hex') };
}
function readManifest(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !manifest.backupComplete || !Array.isArray(manifest.collections)) throw Error('Incomplete backup');
  return manifest;
}
async function backupDatabase(db, directory) {
  const collections = await inventory(db);
  fs.mkdirSync(directory); // Deliberately fails if any previous backup exists.
  const manifest = { format: 1, createdAt: new Date().toISOString(), backupComplete: false, collections: [] };
  for (const [i, collection] of collections.entries()) {
    const filename = `${i}.bson`, fd = fs.openSync(path.join(directory, filename), 'wx');
    let result;
    try {
      result = await fingerprint(db, collection.name, raw => {
        let offset = 0;
        while (offset < raw.length) offset += fs.writeSync(fd, raw, offset, raw.length - offset);
      });
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const indexes = await db.collection(collection.name).listIndexes().toArray();
    manifest.collections.push({ name: collection.name, filename, ...result, indexes: encode(indexes) });
  }
  manifest.backupComplete = true;
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}
async function verifyDatabase(db, manifest, allowExtra = false) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  if (!allowExtra && names.length !== manifest.collections.length) throw Error('Collection count mismatch');
  for (const row of manifest.collections) {
    if (!names.includes(row.name)) throw Error('Missing collection');
    const actual = await fingerprint(db, row.name);
    if (actual.count !== row.count || actual.sha256 !== row.sha256) throw Error('Document fingerprint mismatch');
    if (indexSignature(await db.collection(row.name).listIndexes().toArray()) !== indexSignature(decode(row.indexes))) {
      throw Error('Index metadata mismatch');
    }
  }
  return { collections: manifest.collections.length, documents: manifest.collections.reduce((n, r) => n + r.count, 0), verified: true };
}
async function restoreDatabase(db, directory) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName || !hello.isWritablePrimary || hello.logicalSessionTimeoutMinutes == null) throw Error('Writable replica set required');
  const ttl = await db.admin().command({ getParameter: 1, ttlMonitorEnabled: 1 });
  if (ttl.ttlMonitorEnabled !== false) throw Error('Disable target TTL monitor until verification completes');
  if ((await db.listCollections({}, { nameOnly: true }).toArray()).length) throw Error('Target must be completely empty; use a fresh database to recover');
  const manifest = readManifest(directory);
  // Verify ALL backup bytes before writing anything to the new target.
  for (const row of manifest.collections) {
    if (!/^\d+\.bson$/.test(row.filename)) throw Error('Invalid backup filename');
    const bytes = fs.readFileSync(path.join(directory, row.filename));
    if (digest(bytes) !== row.sha256) throw Error('Backup checksum mismatch');
    let offset = 0, count = 0;
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length) throw Error('Truncated BSON backup');
      const size = bytes.readInt32LE(offset);
      if (size < 5 || offset + size > bytes.length) throw Error('Invalid BSON backup');
      BSON.deserialize(bytes.subarray(offset, offset + size), { promoteValues: false, bsonRegExp: true });
      offset += size; count++;
    }
    if (count !== row.count) throw Error('Backup document count mismatch');
  }
  for (const row of manifest.collections) {
    const collection = await db.createCollection(row.name);
    const bytes = fs.readFileSync(path.join(directory, row.filename));
    let offset = 0, batch = [];
    while (offset < bytes.length) {
      const size = bytes.readInt32LE(offset);
      batch.push(BSON.deserialize(bytes.subarray(offset, offset + size), { promoteValues: false, bsonRegExp: true }));
      offset += size;
      if (batch.length === 200 || offset === bytes.length) { await collection.insertMany(batch, { ordered: true }); batch = []; }
    }
    const indexes = decode(row.indexes).filter(i => i.name !== '_id_').map(indexSpec);
    if (indexes.length) await collection.createIndexes(indexes);
  }
  return verifyDatabase(db, manifest);
}
async function copyDatabase(source, target, directory) {
  if ((await target.listCollections({}, { nameOnly: true }).toArray()).length) throw Error('Target must be empty');
  let locked = false;
  try {
    // Stops TTL and all other writers during the cross-collection snapshot and verification.
    const lock = await source.admin().command({ fsync: 1, lock: true }); locked = true;
    if (lock.lockCount !== 1) throw Error('Source already had an external fsync lock; manual review required');
    const manifest = await backupDatabase(source, directory);
    const result = await restoreDatabase(target, directory);
    await verifyDatabase(source, manifest);
    fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
    return result;
  } finally { if (locked) await source.admin().command({ fsyncUnlock: 1 }); }
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log('Local development only; backend writers must be stopped first. Never overwrites a target.\n' +
      'node scripts/local-replica-copy.cjs copy SOURCE_URI_ENV TARGET_URI_ENV NEW_BACKUP_DIRECTORY\n' +
      'node scripts/local-replica-copy.cjs restore TARGET_URI_ENV BACKUP_DIRECTORY\n' +
      'node scripts/local-replica-copy.cjs verify TARGET_URI_ENV BACKUP_DIRECTORY\n' +
      'Requires a separate loopback replica set with TTL monitor disabled during restore. Backup contains private data.');
    return;
  }
  const [mode, first, second, third, extra] = process.argv.slice(2);
  if (extra || !['copy', 'restore', 'verify'].includes(mode) || !first || !second || (mode === 'copy' ? !third : !!third)) throw Error('Invalid arguments');
  const sourceUri = mode === 'copy' ? process.env[first] : null;
  const targetUri = process.env[mode === 'copy' ? second : first];
  const targetAddress = localUri(targetUri);
  if (sourceUri && (localUri(sourceUri).port || '27017') === (targetAddress.port || '27017')) throw Error('Separate source and target server ports required');
  const directory = path.resolve(mode === 'copy' ? third : second);
  const options = { serverSelectionTimeoutMS: 10000, retryWrites: false };
  const clients = [];
  try {
    const target = await MongoClient.connect(targetUri, options); clients.push(target);
    let result;
    if (mode === 'copy') {
      const source = await MongoClient.connect(sourceUri, options); clients.push(source);
      result = await copyDatabase(source.db(), target.db(), directory);
    } else if (mode === 'restore') result = await restoreDatabase(target.db(), directory);
    else result = await verifyDatabase(target.db(), readManifest(directory));
    console.log(JSON.stringify(result));
  } finally { await Promise.all(clients.map(c => c.close())); }
}
module.exports = { backupDatabase, restoreDatabase, verifyDatabase, copyDatabase, readManifest, localUri };
if (require.main === module) main().catch(error => { console.error(`Local replica operation stopped: ${error.name}. No connection details logged; inspect backup manifest and keep the original database.`); process.exitCode = 1; });
