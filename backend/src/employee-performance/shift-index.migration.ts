import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmployeeShift, EmployeeShiftDocument } from './schemas/employee-shift.schema';

/**
 * Drops the obsolete UNIQUE index on employeeshifts.userId.
 *
 * ⚠ Why this exists at all — `autoIndex` CREATES, it never DROPS.
 * `EmployeeShift.userId` used to be `@Prop({ required: true, unique: true })`
 * ("one shift config per staff member"). That constraint was deliberately removed
 * when an employee became able to hold several shifts (Sun–Tue 9–5 AND Wed–Thu 12–8);
 * uniqueness moved to the (userId, daysOfWeek, window) combination, enforced in
 * EmployeeShiftService.assertNoOverlap, because Mongo cannot express "no two
 * documents whose daysOfWeek arrays intersect" as a schema-level constraint.
 *
 * But Mongoose's autoIndex only ever ADDS indexes that the schema declares. An index
 * the schema no longer mentions is left on the collection untouched, so every database
 * that ran the old build still enforces the retired rule. The visible symptom is that
 * assigning an employee a SECOND shift throws a duplicate-key error (11000), which the
 * global HttpExceptionFilter renders as «البيانات موجودة مسبقاً» — a message about
 * data that describes an index, so it reads as a bug in the roster rather than a
 * stale constraint. Assigning the first cell of a bulk selection already fails, which
 * is why the toast reports «تم تطبيق 0 من 4».
 *
 * ⚠ Only a UNIQUE index on userId ALONE is dropped. The plain, non-unique
 * `EmployeeShiftSchema.index({ userId: 1 })` is a real declared index that the
 * roster's sort depends on, and any compound index is somebody else's; dropping
 * either would be a silent performance or correctness regression. The `unique`
 * flag plus a single `userId` key is what identifies the retired constraint.
 *
 * ⚠ Never throws. A migration that takes the API down with it trades a broken
 * screen for a dead server — and this one runs on every boot, so a transient
 * database hiccup at startup must not be fatal. It is also idempotent: once the
 * index is gone there is nothing to match and the pass is a no-op.
 */
@Injectable()
export class ShiftIndexMigration implements OnModuleInit {
  private readonly logger = new Logger(ShiftIndexMigration.name);

  constructor(
    @InjectModel(EmployeeShift.name)
    private readonly shiftModel: Model<EmployeeShiftDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const collection = this.shiftModel.collection;

      // An empty/absent collection has no indexes to retire. listIndexes throws
      // NamespaceNotFound on a collection that was never created, so this is
      // checked rather than caught.
      const exists = await collection.listIndexes().toArray().catch(() => null);
      if (!exists) return;

      for (const idx of exists) {
        const keys = Object.keys((idx as { key?: Record<string, unknown> }).key || {});
        const isUnique = (idx as { unique?: boolean }).unique === true;
        // Single-key, on userId, and unique — the retired constraint, and nothing else.
        if (isUnique && keys.length === 1 && keys[0] === 'userId') {
          await collection.dropIndex((idx as { name: string }).name);
          this.logger.log(
            `Dropped obsolete unique index "${(idx as { name: string }).name}" on employeeshifts.userId — ` +
              'an employee may hold multiple shifts; overlap is enforced in EmployeeShiftService.assertNoOverlap',
          );
        }
      }
    } catch (err) {
      // Deliberately swallowed — see the class comment. The roster still works for
      // every install that never carried the old index.
      this.logger.warn(
        `Could not check/drop the obsolete employeeshifts.userId unique index: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
