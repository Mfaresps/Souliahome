import { CallHandler, CanActivate, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, Observable, throwError } from 'rxjs';
import { ApiKeysService } from './api-keys.service';
import { readApiKey } from './api-key.util';

export const API_SCOPE_KEY = 'apiScope';
/** The section a /v1 route belongs to; the key must hold it. */
export const ApiScopeRequired = (scope: string) => SetMetadata(API_SCOPE_KEY, scope);

/**
 * The client IP for the API key's allow-list.
 * ⚠ `X-Real-IP` is written by nginx from the TCP peer ($remote_addr) and cannot be set by the
 * caller. `X-Forwarded-For`'s first entry CAN be forged (nginx appends), so it is never used here.
 */
export function apiClientIp(req: any): string {
  const real = req?.headers?.['x-real-ip'];
  const v = typeof real === 'string' && real ? real : req?.ip || req?.socket?.remoteAddress || '';
  return String(v).replace(/^::ffff:/, '');
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeysService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const scope = this.reflector.get<string>(API_SCOPE_KEY, context.getHandler());
    const started = Date.now();
    const ip = apiClientIp(req);
    // Every request is logged — refused ones too — once the response is sent.
    res.on('finish', () => {
      const k = req.apiKey;
      const query = String(req.originalUrl || req.url || '').split('?')[1] || '';
      this.keys.record({
        keyId: k ? String(k._id) : '',
        keyName: k?.name || '',
        prefix: k?.prefix || req.apiKeyPrefix || '',
        method: String(req.method || ''),
        path: String(req.route?.path ? '/api' + req.route.path.replace(/^\/api/, '') : req.path || ''),
        query: query.slice(0, 300),
        status: Number(res.statusCode) || 0,
        ms: Date.now() - started,
        ip,
        ua: String(req.headers?.['user-agent'] || '').slice(0, 160),
        code: req.apiErrorCode || undefined,
        scope: scope || undefined,
        detail: req.apiLogDetail || undefined,
      });
    });
    const raw = readApiKey(req.headers);
    if (raw) req.apiKeyPrefix = raw.slice(0, 14);
    try {
      const key = await this.keys.authenticate(raw, ip, scope);
      req.apiKey = key;
      res.setHeader('X-RateLimit-Limit', String(key.rateLimit));
      return true;
    } catch (e: any) {
      const body = e?.getResponse?.();
      req.apiErrorCode = body?.code || 'ERROR';
      if (e?.apiKey) req.apiKey = e.apiKey;
      if (body?.retryAfter) res.setHeader('Retry-After', String(body.retryAfter));
      throw e;
    }
  }
}

/** Records the error code of a refused handler call in the request log. */
@Injectable()
export class ApiLogInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(catchError((e) => {
      const body = e?.getResponse?.();
      req.apiErrorCode = (body && typeof body === 'object' && body.code) || e?.name || 'ERROR';
      return throwError(() => e);
    }));
  }
}
