import { ClientSession } from 'mongoose';

/** Explicit atomic inventory/financial operation. External effects run after commit. */
export interface DatabaseWriteContext {
  session: ClientSession;
  afterCommit: Array<() => void | Promise<void>>;
  /** Internal receipt owner; never accepted from an HTTP DTO. */
  afterSalesCaseId?: string;
}
export function sessionQuery<T>(query: T, session?: ClientSession): T {
  return session ? (query as any).session(session) : query;
}
