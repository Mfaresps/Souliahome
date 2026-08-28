import { SettingsService } from '../../src/settings/settings.service';

/**
 * Guards the backup/restore contract.
 *
 * The bug these tests exist to prevent: a new module adds a Mongo collection, but nobody updates
 * the backup lists — so backups silently omit it, and a restore looks like it succeeded while that
 * data is gone for good. Every list below must stay in sync; these tests fail loudly when they drift.
 */
describe('SettingsService backup coverage', () => {
  const BACKUP = SettingsService.BACKUP_COLLECTIONS;
  const ALLOWED = SettingsService.ALLOWED_COLLECTIONS;
  // SECTION_COLLECTIONS is private — read it the way the coverage check needs to.
  const SECTIONS: Record<string, string[]> = (SettingsService as any).SECTION_COLLECTIONS;
  const sectionCols = Object.values(SECTIONS).flat();

  /**
   * Nothing is backed up and then left unrestorable any more. `users` used to be —
   * captured, then skipped by both restore paths — which is why a restore onto a clean
   * database produced a full transaction history with no employee accounts and a
   * performance leaderboard of unresolvable ids.
   */
  const NEVER_RESTORED: string[] = [];

  it('backs up every collection that clear-data is allowed to wipe', () => {
    // Otherwise the "safety backup" taken before a wipe cannot actually restore what it wiped.
    const wipedButNotBackedUp = ALLOWED.filter(c => !BACKUP.includes(c));
    expect(wipedButNotBackedUp).toEqual([]);
  });

  it('assigns every backed-up collection to a selective-restore section', () => {
    // A collection missing here is silently skipped by selectiveRestoreBackup().
    const orphaned = BACKUP.filter(
      c => !NEVER_RESTORED.includes(c) && !sectionCols.includes(c),
    );
    expect(orphaned).toEqual([]);
  });

  it('does not reference unknown collections in selective-restore sections', () => {
    // A section naming a collection that is never backed up would delete live data and then
    // restore nothing into it.
    const unknown = sectionCols.filter(c => !BACKUP.includes(c));
    expect(unknown).toEqual([]);
  });

  it('assigns each collection to exactly one section', () => {
    // Two sections owning one collection means restoring the second wipes the first's result.
    const seen = new Set<string>();
    const duplicates = sectionCols.filter(c => (seen.has(c) ? true : (seen.add(c), false)));
    expect(duplicates).toEqual([]);
  });

  it('restores the users collection, so employee accounts survive a restore', () => {
    // The regression this replaces: `users` was captured but skipped on restore, so
    // accounts, job titles, perms — and every performance log's employeeId target —
    // vanished on a restore to a fresh database.
    expect(BACKUP).toContain('users');
    expect(sectionCols).toContain('users');
  });

  it('never lets clear-data wipe the users collection', () => {
    // Restoring users is safe only because it is a MERGE. Clear-data has no merge path,
    // so accounts must stay out of ALLOWED_COLLECTIONS or a wipe locks everyone out.
    expect(ALLOWED).not.toContain('users');
  });

  it('keeps employee accounts and their performance data in the same section', () => {
    // Restoring points without the accounts they belong to yields a leaderboard of ids
    // nobody can read; restoring them separately makes that the default outcome.
    const sectionOf = (col: string) =>
      Object.keys(SECTIONS).find(k => SECTIONS[k].includes(col));
    expect(sectionOf('users')).toBe(sectionOf('employeeperformancelogs'));
    expect(sectionOf('users')).toBe(sectionOf('employeeshifts'));
  });

  it('has no duplicate entries in the backup list', () => {
    expect(BACKUP.length).toBe(new Set(BACKUP).size);
  });

  it('covers the collections added by the newer modules', () => {
    // Explicit regression anchor for the modules that were missing before this fix.
    for (const col of [
      'categories', 'collections', 'collectionproducts',
      'inventorymovements', 'supplierledgerentries', 'supplierreturnorders',
      'vaultbalances',
    ]) {
      expect(BACKUP).toContain(col);
      expect(sectionCols).toContain(col);
    }
  });
});
