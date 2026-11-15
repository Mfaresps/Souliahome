// End-to-end check of merge-ready + add-to-run over the COMPILED API on the scratch copy
// `soulia_readymerge` (port 4391). Refuses to touch any other database.
const path = require('node:path');
const NM = 'D:/website/Souliahome/backend/node_modules/';
const { MongoClient, ObjectId } = require(NM + 'mongodb');
const jwt = require(NM + 'jsonwebtoken');
const DB = 'soulia_readymerge', API = 'http://127.0.0.1:4391/api', SECRET = 'scratch-readymerge-secret-0123456789';
if (DB === 'soulia') throw new Error('never the real database');

let pass = 0, fail = 0;
const check = (cond, msg, extra) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg, extra !== undefined ? JSON.stringify(extra) : ''); } };

(async () => {
  const client = await MongoClient.connect('mongodb://127.0.0.1:27018/?replicaSet=souliaDev');
  const db = client.db(DB);
  const tx = db.collection('transactions'), pickups = db.collection('bostapickups'), users = db.collection('users');
  const TAG = 'RMTEST';
  await tx.deleteMany({ _rmTest: TAG }); await pickups.deleteMany({ _rmTest: TAG }); await users.deleteMany({ _rmTest: TAG });

  // ── accounts
  const mkUser = async (username, role, perms) => {
    const _id = new ObjectId();
    await users.insertOne({ _id, _rmTest: TAG, username, name: username, password: 'x', role, perms, isActive: true, createdAt: new Date() });
    return jwt.sign({ sub: String(_id), username }, SECRET, { expiresIn: '1h' });
  };
  const staff = await mkUser('rm_staff', 'staff', ['pickup-orders', 'pickup-orders-edit']);
  const viewer = await mkUser('rm_viewer', 'staff', ['pickup-orders']);

  // ── fixtures
  let n = 0;
  const order = async (ref, extra = {}) => {
    const _id = new ObjectId(); n++;
    const doc = { _id, _rmTest: TAG, type: 'مبيعات', ref: String(997000 + n), client: 'RM ' + n, phone: '0100000' + String(n).padStart(4, '0'),
      date: '2026-11-14', total: 500 + n, remaining: 500 + n, deposit: 0, items: [{ code: 'RM', name: 'Test', qty: 1, price: 500 + n, total: 500 + n }],
      pickupStatus: 'Ready', pickupRef: ref, pickupDate: '2026-11-15', shipCo: 'Bosta', bostaOrderId: 'RMB' + n, bostaTrackingNumber: 'RMT' + n,
      bostaStatus: 'CREATED', warehouseCode: 'MAIN', cancelled: false, archived: false, pickupHistory: [], ...extra };
    await tx.insertOne(doc); return doc;
  };
  const request = async (orders, status = 'created') => {
    const _id = new ObjectId();
    await pickups.insertOne({ _id, _rmTest: TAG, status, active: true, bostaPickupId: 'RMP' + _id, businessLocationId: 'RML' + _id, scheduledDate: '2026-11-15',
      numberOfParcels: orders.length, orderIds: orders.map(o => String(o._id)), extraOrderIds: [], createdAt: new Date() });
    return _id;
  };
  const post = async (route, body, token = staff) => {
    const r = await fetch(API + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const get = id => tx.findOne({ _id: id });
  const counts = async () => Object.fromEntries(await Promise.all(['vaultentries', 'inventorymovements', 'supplierledgerentries', 'transactions'].map(async c => [c, await db.collection(c).countDocuments()])));
  const ids = rows => rows.map(o => String(o._id));

  const before = await counts();

  console.log('merge-ready — allowed');
  const a1 = await order('RM-A', { pickupDate: '2026-11-16' });
  const b1 = await order('RM-B'), b2 = await order('RM-B');
  const p1 = await request([b1, b2]);
  let r = await post('/transactions/pickup-orders/merge-ready', { sourceRef: 'RM-A', targetRef: 'RM-B', ids: ids([a1]) });
  check(r.status === 201 || r.status === 200, 'source without a pickup request joins a group under one → ' + r.status, r.body);
  check(r.body?.moved === 1 && r.body?.pickupRef === 'RM-B' && r.body?.pickupDate === '2026-11-15', 'response: moved 1, target ref and date', r.body);
  let a1n = await get(a1._id);
  check(a1n.pickupRef === 'RM-B' && a1n.pickupDate === '2026-11-15' && a1n.pickupStatus === 'Ready', 'order now in RM-B with the target pickup date, still Ready');
  check(a1n.pickupHistory.at(-1)?.action === 'merge-ready' && a1n.pickupHistory.at(-1)?.fromRef === 'RM-A' && a1n.pickupHistory.at(-1)?.by === 'rm_staff', 'history: merge-ready from RM-A by the caller');
  check(a1n.bostaStatus === 'CREATED' && a1n.bostaOrderId === a1.bostaOrderId && a1n.total === a1.total && a1n.remaining === a1.remaining, 'Bosta shipment and money fields untouched');
  check(JSON.stringify((await pickups.findOne({ _id: p1 })).orderIds) === JSON.stringify(ids([b1, b2])), 'pickup request membership unchanged (join stays a separate step)');

  const i1 = await order('RM-I'), j1 = await order('RM-J');
  await request([i1, j1]);
  r = await post('/transactions/pickup-orders/merge-ready', { sourceRef: 'RM-I', targetRef: 'RM-J', ids: ids([i1]) });
  check(r.body?.moved === 1, 'both groups under the SAME pickup request → allowed', r.body);
  const legacy = await order('RM-LEG', { shipCo: '', bostaOrderId: '', bostaTrackingNumber: '', bostaStatus: '', warehouseCode: '' });
  const legT = await order('RM-LEGT');
  r = await post('/transactions/pickup-orders/merge-ready', { sourceRef: 'RM-LEG', targetRef: 'RM-LEGT', ids: ids([legacy]) });
  check(r.body?.moved === 1, 'legacy order (no carrier, empty warehouse) → allowed', r.body);

  console.log('merge-ready — refused (nothing written)');
  const refused = async (label, src, dst, srcRows, reason, status = 400) => {
    const snap = await tx.find({ _id: { $in: srcRows.map(o => o._id) } }).toArray();
    const res = await post('/transactions/pickup-orders/merge-ready', { sourceRef: src, targetRef: dst, ids: ids(srcRows) });
    const after = await tx.find({ _id: { $in: srcRows.map(o => o._id) } }).toArray();
    check(res.status === status && (!reason || res.body?.reason === reason) && JSON.stringify(snap) === JSON.stringify(after),
      `${label} → ${res.status}${res.body?.reason ? ' ' + res.body.reason : ''} «${res.body?.message || ''}»`, res.body);
  };
  const c1 = await order('RM-C', { shipCo: 'Mylerz', bostaOrderId: '', bostaTrackingNumber: '', bostaStatus: '' }); await order('RM-D');
  await refused('other carrier', 'RM-C', 'RM-D', [c1], 'CARRIER');
  const e1 = await order('RM-E', { warehouseCode: 'ALEX' }); await order('RM-E2');
  await refused('other warehouse', 'RM-E', 'RM-E2', [e1], 'WAREHOUSE');
  const f1 = await order('RM-F', { bostaStatus: 'PICKED_UP' }), f2 = await order('RM-F'); await order('RM-F2');
  await refused('courier already collected one order', 'RM-F', 'RM-F2', [f1, f2], 'COLLECTED');
  const g1 = await order('RM-G', { pickupStatus: 'Picked-Up' }); await order('RM-G2');
  await refused('order handed over (Picked-Up)', 'RM-G', 'RM-G2', [g1], 'COLLECTED');
  const h1 = await order('RM-H'), h2 = await order('RM-H2');
  await request([h1]); await request([h2]);
  await refused('two different pickup requests', 'RM-H', 'RM-H2', [h1], 'PICKUP_REQUEST');
  const k1 = await order('RM-K'), k2 = await order('RM-K'); await order('RM-K2');
  await refused('stale selection (one of two ids)', 'RM-K', 'RM-K2', [k1], null, 409);
  await refused('merge into itself', 'RM-K', 'RM-K', [k1, k2], null, 400);
  await order('RM-GONE', { pickupStatus: 'Shipped', bostaStatus: 'IN_TRANSIT' });
  await refused('target no longer ready', 'RM-K', 'RM-GONE', [k1, k2], null, 409);
  r = await post('/transactions/pickup-orders/merge-ready', { sourceRef: 'RM-K', targetRef: 'RM-K2', ids: ids([k1, k2]) }, viewer);
  check(r.status === 403, 'without pickup-orders-edit → 403', r.status);
  r = await post('/transactions/pickup-orders/merge-ready', { sourceRef: 'RM-K', targetRef: 'RM-K2', ids: ids([k1, k2]) }, null);
  check(r.status === 401, 'no token → 401', r.status);

  console.log('add-to-run (edit-run window) — same rules');
  const l1 = await order('RM-L', { pickupDate: '2026-11-17' }), l2 = await order('RM-L'); await order('RM-M');
  r = await post('/transactions/pickup-orders/add-to-run', { ids: ids([l1]), pickupRef: 'RM-M' });
  check(r.body?.updated === 1, 'moving one selected order → updated 1', r.body);
  const l1n = await get(l1._id), l2n = await get(l2._id);
  check(l1n.pickupRef === 'RM-M' && l1n.pickupDate === '2026-11-15' && l2n.pickupRef === 'RM-L', 'only the selected order moved, with the target date');
  const q1 = await order('RM-Q', { pickupStatus: 'Picked-Up' }); await order('RM-Q2');
  r = await post('/transactions/pickup-orders/add-to-run', { ids: ids([q1]), pickupRef: 'RM-Q2' });
  const q1n = await get(q1._id);
  check(r.status === 400 && r.body?.reason === 'COLLECTED' && q1n.pickupStatus === 'Picked-Up' && q1n.pickupRef === 'RM-Q',
    'Picked-Up order refused and NOT rewritten to Ready (old code did) → ' + r.status, r.body);
  const s1 = await order('RM-S', { shipCo: 'Mylerz', bostaOrderId: '', bostaTrackingNumber: '', bostaStatus: '' }); await order('RM-S2');
  r = await post('/transactions/pickup-orders/add-to-run', { ids: ids([s1]), pickupRef: 'RM-S2' });
  check(r.status === 400 && r.body?.reason === 'CARRIER' && (await get(s1._id)).pickupRef === 'RM-S', 'other carrier refused with a reason', r.body);
  const t1 = await order('RM-T'), t2 = await order('RM-T2'); await request([t1]); await request([t2]);
  r = await post('/transactions/pickup-orders/add-to-run', { ids: ids([t1]), pickupRef: 'RM-T2' });
  check(r.status === 400 && r.body?.reason === 'PICKUP_REQUEST', 'two pickup requests refused', r.body);
  const u1 = await order('RM-U', { cancelled: true }); await order('RM-U2');
  r = await post('/transactions/pickup-orders/add-to-run', { ids: ids([u1]), pickupRef: 'RM-U2' });
  check(r.status === 409, 'cancelled order → 409', r.body);
  r = await post('/transactions/pickup-orders/add-to-run', { ids: ids([l1]), pickupRef: 'RM-M' });
  check(r.status === 400, 'already in the target → 400', r.body);

  const after = await counts();
  check(after.vaultentries === before.vaultentries && after.inventorymovements === before.inventorymovements && after.supplierledgerentries === before.supplierledgerentries,
    'no vault, stock-movement or ledger row written by any call', { before, after });

  await tx.deleteMany({ _rmTest: TAG }); await pickups.deleteMany({ _rmTest: TAG }); await users.deleteMany({ _rmTest: TAG });
  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
