import mongoose, { Connection, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../../src/users/users.service';
import { UserSchema, UserDocument } from '../../src/users/schemas/user.schema';
import { requireJwtSecret } from '../../src/auth/jwt-secret.util';

// Passwords are kept as a bcrypt hash only. A plain-text copy used to be stored so an admin
// could "show" it; it is no longer written, is cleared at start-up, and no user list sends a
// credential to the browser.
describe('user credentials', () => {
  const dbName = `soulia_test_users_credentials_${Date.now()}`;
  let connection: Connection;
  let model: Model<UserDocument>;
  let service: UsersService;

  beforeAll(async () => {
    connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    model = connection.model<UserDocument>('User', UserSchema as any) as any;
    service = new UsersService(model);
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('never stores the password in plain text, and login still checks the hash', async () => {
    await service.createUser({ username: 'sara', password: 'secret-123', name: 'Sara', role: 'staff' });
    const raw: any = await model.collection.findOne({ username: 'sara' });
    expect(raw.plainPassword).toBeUndefined();
    expect(await bcrypt.compare('secret-123', raw.password)).toBe(true);

    // A profile edit never changes the password (Nov 27, 2026): only setPassword does.
    await service.updateUser(String(raw._id), { password: 'changed-456' } as any);
    const kept: any = await model.collection.findOne({ username: 'sara' });
    expect(await bcrypt.compare('secret-123', kept.password)).toBe(true);

    await service.setPassword(String(raw._id), 'changed-456');
    const after: any = await model.collection.findOne({ username: 'sara' });
    expect(after.plainPassword).toBeUndefined();
    expect(await bcrypt.compare('changed-456', after.password)).toBe(true);
    expect(after.passwordHistory).toHaveLength(1);
  });

  it('refuses any of the last 5 passwords and keeps 4 old hashes at most', async () => {
    await service.createUser({ username: 'omar', password: 'pw-one-111', name: 'Omar', role: 'staff' });
    const id = String((await model.collection.findOne({ username: 'omar' }) as any)._id);
    for (const p of ['pw-two-222', 'pw-three-333', 'pw-four-444', 'pw-five-555', 'pw-six-666']) await service.setPassword(id, p);
    const raw: any = await model.collection.findOne({ _id: (await model.collection.findOne({ username: 'omar' }) as any)._id });
    expect(raw.passwordHistory).toHaveLength(4);
    expect(await service.passwordReused(id, 'pw-six-666')).toBe(true);   // current
    expect(await service.passwordReused(id, 'pw-two-222')).toBe(true);   // 5th most recent
    expect(await service.passwordReused(id, 'pw-one-111')).toBe(false);  // 6th: allowed again
  });

  it('clears plain-text copies left by older versions at start-up, once', async () => {
    await model.collection.insertOne({ username: 'old', name: 'Old', role: 'staff', password: await bcrypt.hash('x-123456', 4), plainPassword: 'x-123456' } as any);
    await service.onModuleInit();
    expect(await model.collection.countDocuments({ plainPassword: { $exists: true } })).toBe(0);
    const old: any = await model.collection.findOne({ username: 'old' });
    expect(await bcrypt.compare('x-123456', old.password)).toBe(true); // login unaffected
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('sends no credential in any user list', async () => {
    await model.collection.updateOne({ username: 'sara' }, { $set: { totpSecret: 'JBSWY3DPEHPK3PXP', plainPassword: 'leftover' } });
    const lists = [await service.findAllForAdmin(), await service.findAll()];
    for (const list of lists) {
      for (const u of list.map(d => d.toObject() as any)) {
        expect(u.password).toBeUndefined();
        expect(u.plainPassword).toBeUndefined();
        expect(u.totpSecret).toBeUndefined();
      }
    }
    // The TOTP check reads the full record and still finds the secret.
    const full = await service.findByUsername('sara');
    expect(full?.totpSecret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses to run without a JWT secret instead of using a known default', () => {
    expect(() => requireJwtSecret(undefined)).toThrow(/JWT_SECRET/);
    expect(() => requireJwtSecret('   ')).toThrow(/JWT_SECRET/);
    expect(requireJwtSecret('a-real-secret')).toBe('a-real-secret');
  });
});
