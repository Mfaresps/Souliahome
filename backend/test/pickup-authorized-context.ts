import { runInNewContext as runVm, RunningCodeOptions } from 'vm';

/** Existing workflow fixtures act as an authorized operator. Permission denials
 * are exercised separately in pickup-permissions.spec.ts. */
export function runInNewContext(code: string, context: any, options?: RunningCodeOptions): any {
  context._puCanEdit ??= () => true;
  context._puRequireEdit ??= () => true;
  context._puSyncPermissions ??= () => {};
  context._requirePageAccess ??= () => true;
  return runVm(code, context, options);
}
