import mongoose from 'mongoose';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';

/** Own mongod, own temporary directory, loopback only. Never reads application URI/config. */
export async function trackingMongo(replica = true) {
  const binary = process.env.SOULIA_TEST_MONGOD || 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe';
  if (!existsSync(binary)) throw new Error('Install mongod or set SOULIA_TEST_MONGOD; transaction tests must not silently skip');
  const port = await new Promise<number>((done, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address() as any; server.close(() => done(address.port)); });
  });
  const directory = mkdtempSync(join(tmpdir(), 'soulia-tracking-test-'));
  const child = spawn(binary, ['--dbpath', directory, '--bind_ip', '127.0.0.1', '--port', String(port),
    ...(replica ? ['--replSet', 'trackingTest'] : [])], { windowsHide: true, stdio: 'ignore' });
  let spawnError: Error | undefined; child.on('error', error => { spawnError = error; });
  const connection = mongoose.createConnection(`mongodb://127.0.0.1:${port}/tracking_scratch?directConnection=true`,
    { serverSelectionTimeoutMS: 10000, autoCreate: false, autoIndex: false });
  async function close() {
    await connection.close();
    if (child.pid && child.exitCode === null) await new Promise<void>(done => { child.once('exit', () => done()); child.kill(); });
    const target = resolve(directory), root = resolve(tmpdir()) + sep;
    if (target.startsWith(root) && target.includes('soulia-tracking-test-')) rmSync(target, { recursive: true, force: true });
  }
  try {
    await connection.asPromise(); if (spawnError) throw spawnError;
    if (replica) {
      await connection.db!.admin().command({ replSetInitiate: { _id: 'trackingTest', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
      const deadline = Date.now() + 20000;
      while (!(await connection.db!.admin().command({ hello: 1 })).isWritablePrimary) {
        if (Date.now() > deadline) throw new Error('Temporary replica set failed to elect primary');
        await new Promise(done => setTimeout(done, 100));
      }
    }
    // Match the application's default warehouse initialization in isolated service tests.
    await connection.collection('warehouses').insertOne({ code: 'MAIN', name: 'Main', active: true });
    return { connection, close };
  } catch (error) { await close(); throw error; }
}
