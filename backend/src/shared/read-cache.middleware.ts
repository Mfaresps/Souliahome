import type { NextFunction, Request, Response } from 'express';
import { invalidateReadCaches } from './read-cache.util';

/** Filter queries and presence heartbeats cannot change financial/operational screens. */
export function invalidateReadCachesOnWrite(req: Request, res: Response, next: NextFunction): void {
  const path = req.path.replace(/\/+$/, '');
  const preservesDisplay = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    || req.method === 'POST' && ['/api/transactions/movements-page', '/api/auth/update-last-seen'].includes(path);
  if (!preservesDisplay) {
    invalidateReadCaches();
    res.once('finish', invalidateReadCaches);
    res.once('close', invalidateReadCaches);
  }
  next();
}
