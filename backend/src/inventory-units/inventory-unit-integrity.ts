import { Schema } from 'mongoose';

/** Data-layer restrictions only. Raw-driver maintenance requires separate privileged procedures. */
export function retainRecords(schema: Schema, message: string, appendOnly = false): void {
  const deny = () => { throw new Error(message); };
  schema.pre('deleteOne', { document: true, query: false }, deny);
  for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne', 'findOneAndReplace'] as const) {
    schema.pre(operation, deny);
  }
  if (appendOnly) {
    for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) schema.pre(operation, deny);
    schema.pre('save', function () { if (!this.isNew) deny(); });
  }
  // Cross-field/reference checks run on documents. Do not permit query updates to skip them.
  // A later transactional lifecycle writer must introduce its own validated conditional writes.
  if (!appendOnly) for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) schema.pre(operation, deny);
  schema.pre('bulkWrite', function (next, operations: any[]) {
    if (operations.some(operation => !operation.insertOne)) return next(new Error(message));
    // insertOne validation does not run document reference middleware. Use create/save for now.
    next(new Error('Inventory tracking bulk writes are unavailable before a validated lifecycle writer exists'));
  });
  schema.pre('insertMany', function () {
    throw new Error('Inventory tracking insertMany bypasses reference validation; use document create/save');
  });
}

/** MongoDB has no foreign keys. Enforce normal Mongoose deletion paths without altering old rows. */
export function restrictInventoryParentDeletion(schema: Schema, paths: string[], eventPaths: string[] = []): void {
  async function check(model: any, filter: any, session: any): Promise<void> {
    const parents = await model.find(filter).select('_id').session(session || null).lean().exec();
    const ids = parents.map((parent: any) => String(parent._id));
    if (!ids.length) return;
    const linked = paths.length && await model.db.collection('inventoryunits').findOne(
      { $or: paths.map(path => ({ [path]: { $in: ids } })) },
      { projection: { _id: 1 }, ...(session ? { session } : {}) },
    );
    const audited = eventPaths.length && await model.db.collection('inventoryunitevents').findOne(
      { $or: eventPaths.map(path => ({ [path]: { $in: ids } })) },
      { projection: { _id: 1 }, ...(session ? { session } : {}) },
    );
    if (linked || audited) throw new Error('Cannot delete a record referenced by retained inventory units/events');
  }
  for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne', 'findOneAndReplace'] as const) {
    schema.pre(operation, async function () {
      await check(this.model, this.getFilter(), this.getOptions().session);
    });
  }
  schema.pre('deleteOne', { document: true, query: false }, async function () {
    await check(this.constructor, { _id: this._id }, this.$session());
  });
  // Bulk delete/replace operations bypass the query middleware above.
  schema.pre('bulkWrite', function (next, operations: any[], options: any) {
    const model = this;
    void (async () => {
      for (const operation of operations) {
        const destructive = operation.deleteOne || operation.deleteMany || operation.replaceOne;
        if (destructive) await check(model, destructive.filter, options?.session);
      }
    })().then(() => next(), next);
  });
}

/** Uses the document's connection/session; never loads or starts AppModule. */
export async function referenceExists(document: any, collection: string, filter: any): Promise<boolean> {
  const session = document.$session();
  return !!await document.constructor.db.collection(collection).findOne(filter,
    { projection: { _id: 1 }, ...(session ? { session } : {}) });
}
