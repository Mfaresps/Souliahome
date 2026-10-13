'use strict';

// Called inside the live backend container by Jenkins, only after health checks pass.
// Credentials come from the container environment and are never command arguments.
async function verifyLiveRelease(build, fetchLive = fetch) {
  if (!/^[1-9]\d{0,11}$/.test(String(build || ''))) throw new Error('A valid CI build number is required');
  const response = await fetchLive('http://frontend/version.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Live frontend version check failed');
  const marker = await response.json();
  if (String(marker.build) !== String(build) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(marker.version || ''))) {
    throw new Error('The live frontend does not match this CI build');
  }
  return { build: String(build), version: String(marker.version) };
}

async function announceRelease(service, connection, release) {
  const eventId = 'release:' + release.build;
  await service.enqueue('announcement', eventId, '', '', undefined, undefined, { releaseVersion: release.version });
  const recipients = await connection.collection('users').countDocuments({ role: { $in: ['admin', 'staff', 'viewer'] }, isActive: { $ne: false } });
  const recorded = await connection.collection('notificationinbox').countDocuments({ eventId });
  if (recorded < recipients) throw new Error('Release notification history is incomplete; retry this stage');
  return recorded;
}

async function main() {
  // Do this before connecting to the database or creating any notifications.
  const release = await verifyLiveRelease(process.argv[2]);
  if (!process.env.MONGODB_URI) throw new Error('Live database configuration is required');
  const mongoose = require('mongoose');
  const { NotificationsService } = require('../dist/notifications/notifications.service');
  const connection = await mongoose.createConnection(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    const service = new NotificationsService(connection);
    await service.onModuleInit();
    const count = await announceRelease(service, connection, release);
    console.log(`Release ${release.version}: notification recorded for ${count} accounts.`);
  } finally { await connection.close(); }
}

module.exports = { verifyLiveRelease, announceRelease };
if (require.main === module) main().catch(() => { console.error('Release notification failed. Check live version and database availability, then retry this stage.'); process.exitCode = 1; });
