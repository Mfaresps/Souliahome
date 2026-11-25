import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, Observable, switchMap } from 'rxjs';
import { AbuseGuardService } from './abuse-guard.service';

/** Runs after the guards (so `req.user` is known) and before every write handler. */
@Injectable()
export class AbuseGuardInterceptor implements NestInterceptor {
  constructor(private readonly abuse: AbuseGuardService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    return from(this.abuse.beforeWrite(req)).pipe(switchMap(() => next.handle()));
  }
}
