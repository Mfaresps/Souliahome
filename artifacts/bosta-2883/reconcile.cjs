// Targeted local reconciliation using the application handler; default is read-only.
const fs = require('node:fs');
const path = require('node:path');
const backend = path.resolve(__dirname, '../../backend');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env'), quiet: true });
const mongoose = require(path.join(backend, 'node_modules/mongoose'));
const { BostaService } = require(path.join(backend, 'dist/bosta/bosta.service'));
const { FollowUpsService } = require(path.join(backend, 'dist/followups/followups.service'));
const { TransactionSchema } = require(path.join(backend, 'dist/transactions/schemas/transaction.schema'));
const { FollowUpSchema } = require(path.join(backend, 'dist/followups/schemas/followup.schema'));
const { MentionsService } = require(path.join(backend, 'dist/mentions/mentions.service'));
const { MentionSchema } = require(path.join(backend, 'dist/mentions/schemas/mention.schema'));
const { NotificationsService } = require(path.join(backend, 'dist/notifications/notifications.service'));
const apply = process.argv.includes('--apply');
function ensure(ok, message) { if (!ok) throw new Error(message); }
function snapshot(tx, followups) {
  return { ref: tx.ref, bostaStatus: tx.bostaStatus, bostaStatusLabel: tx.bostaStatusLabel,
    shipIssueState: tx.shipIssueState, shipIssueTrigger: tx.shipIssueTrigger,
    bostaDeliveryException: tx.bostaDeliveryException,
    financial: { total: tx.total, remaining: tx.remaining, paid: tx.paid, payStatus: tx.payStatus, codCollectionStatus: tx.codCollectionStatus },
    followups: followups.map(f => ({ id: String(f._id), ticketNo: f.ticketNo, status: f.status,
      source: f.autoSource, reason: f.reason, reminder: f.deferredUntil, resolution: f.resolution })) };
}
async function main() {
  ensure(/^mongodb:\/\/(?:127\.0\.0\.1|localhost):27018\//.test(process.env.MONGODB_URI || ''), 'Expected local database');
  const connection = await mongoose.createConnection(process.env.MONGODB_URI, {
    autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
  }).asPromise();
  try {
    const txModel = connection.model('Transaction', TransactionSchema);
    const followModel = connection.model('FollowUp', FollowUpSchema);
    const tx = await txModel.findOne({ ref: '2883' }).lean();
    ensure(tx && String(tx._id) === '6adfd94b6c8ef6018c1827d8' && tx.bostaOrderId === '5P8mTYVyHUFUvDvAxAfoC', 'Invoice identity changed');
    ensure(!tx.cancelled && !tx.deliveredAt && !tx.failedDelivery && tx.bostaStatus === 'IN_TRANSIT', 'Invoice state changed');
    const settings = await connection.collection('settings').findOne({});
    const response = await fetch('https://api.bosta.co/api/v0/deliveries/' + encodeURIComponent(tx.bostaOrderId), {
      headers: { Authorization: settings.bostaApiKey || process.env.BOSTA_API_KEY }, signal: AbortSignal.timeout(15000),
    });
    ensure(response.ok, 'Carrier GET failed');
    const body = await response.json(), d = body.data || body;
    ensure(d.state?.code === 24 && d.state?.lastExceptionCode === 3 && d.deliveryAttemptsLength === 1
      && d.attempts?.length === 1 && d.attempts[0].exception?.code === 3, 'Carrier evidence changed');
    const query = { transactionId: String(tx._id), autoSource: { $in: ['shipping-issue', 'shipping-followup'] } };
    const previousTickets = await followModel.find(query).lean();
    ensure(previousTickets.length === 1, 'Expected the existing follow-up thread');
    const before = snapshot(tx, previousTickets);
    if (!apply) { console.log(JSON.stringify({ mode: 'read-only', before, ready: true }, null, 2)); return; }
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(__dirname, runId + '-before.json'), JSON.stringify(before, null, 2));
    const mentions = new MentionsService(connection.model('Mention', MentionSchema));
    const followups = new FollowUpsService(followModel, mentions, { emitEvent() {}, emitToUser() {} }, null);
    // This one-order repair retains the employee already responsible for the thread.
    // The running application uses its normal live shift/availability assignment.
    const previous = previousTickets[0];
    followups.pickAvailableAssignee = async () => previous.responsibleId ? {
      userId: previous.responsibleId, username: previous.responsibleUsername,
      name: previous.responsibleName, reason: previous.assignSource || 'existing-assignee',
    } : null;
    const errors = [];
    followups.logger = { log() {}, warn() {}, error() { errors.push('Follow-up operation failed'); } };
    const service = new BostaService(txModel, null, null, null, null, null, null, followups);
    service.notifications = new NotificationsService(connection);
    service.logger = { log() {}, warn() {}, error() {} };
    await service.applyDeliveryUpdate(String(tx._id), tx, body, 'sync');
    const after = snapshot(await txModel.findById(tx._id).lean(), await followModel.find(query).lean());
    ensure(after.shipIssueState === '' && after.bostaDeliveryException?.code === 3, 'Correction not persisted');
    ensure(!errors.length && after.followups.some(f => f.source === 'shipping-followup' && f.status === 'في انتظار المتابعة'), 'Postponement follow-up not opened');
    ensure(JSON.stringify(before.financial) === JSON.stringify(after.financial), 'Financial fields unexpectedly changed');
    fs.writeFileSync(path.join(__dirname, runId + '-after.json'), JSON.stringify(after, null, 2));
    console.log(JSON.stringify({ mode: 'applied-local', after }, null, 2));
  } finally { await connection.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
