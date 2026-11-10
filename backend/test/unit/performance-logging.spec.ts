import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { installPerformanceLogging } from '../../src/shared/performance-logging';

describe('Production performance logging', () => {
  const original = process.env.PERFORMANCE_LOG_ENABLED;
  const originalThreshold = process.env.SLOW_REQUEST_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.PERFORMANCE_LOG_ENABLED;
    else process.env.PERFORMANCE_LOG_ENABLED = original;
    if (originalThreshold === undefined) delete process.env.SLOW_REQUEST_MS;
    else process.env.SLOW_REQUEST_MS = originalThreshold;
    jest.restoreAllMocks();
  });

  it('leaves logging disabled unless explicitly enabled', () => {
    delete process.env.PERFORMANCE_LOG_ENABLED;
    const app = { use: jest.fn() };
    expect(installPerformanceLogging(app as any)).toBeUndefined();
    expect(app.use).not.toHaveBeenCalled();
  });

  it('logs the route template once without customer identifiers or request data', () => {
    process.env.PERFORMANCE_LOG_ENABLED = 'true';
    process.env.SLOW_REQUEST_MS = '0.000001';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const app = { use: jest.fn() };
    const stop = installPerformanceLogging(app as any)!;
    try {
      const middleware = app.use.mock.calls[0][0];
      const response = Object.assign(new EventEmitter(), { statusCode: 200 });
      const next = jest.fn();
      middleware({ method: 'GET', route: { path: '/api/orders/:id' },
        url: '/api/orders/private-id?phone=secret', headers: { authorization: 'secret' } }, response, next);
      response.emit('finish'); response.emit('close');
      expect(next).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
        event: 'slow-request', route: '/api/orders/:id', status: 200, active: 0,
      });
      expect(warn.mock.calls[0][0]).not.toMatch(/private-id|phone|secret|authorization/);
    } finally { stop(); }
  });
});
