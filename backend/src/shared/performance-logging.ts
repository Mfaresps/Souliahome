import { Logger } from '@nestjs/common';
import type { Express } from 'express';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/** Opt-in production measurements; never log request bodies, tokens or query strings. */
export function installPerformanceLogging(app: Express): (() => void) | undefined {
  if (process.env.PERFORMANCE_LOG_ENABLED !== 'true') return;
  const logger = new Logger('Performance');
  const configured = Number(process.env.SLOW_REQUEST_MS);
  const threshold = Number.isFinite(configured) && configured > 0 ? configured : 500;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let active = 0;
  let completed = 0;
  let cpu = process.cpuUsage();
  let sampledAt = performance.now();
  app.use((req, res, next) => {
    const startedAt = performance.now();
    active++;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      active--;
      completed++;
      const ms = performance.now() - startedAt;
      // Express route templates contain :id instead of customer/order identifiers.
      if (ms >= threshold) logger.warn(JSON.stringify({ event: 'slow-request',
        method: req.method, route: req.route?.path || 'unmatched', status: res.statusCode,
        ms: Math.round(ms), active }));
    };
    res.once('finish', done);
    res.once('close', done);
    next();
  });
  const timer = setInterval(() => {
    const now = performance.now();
    const usage = process.cpuUsage(cpu);
    const memory = process.memoryUsage();
    logger.log(JSON.stringify({ event: 'server-load', requests: completed, active,
      cpuPercent: Math.round((usage.user + usage.system) / ((now - sampledAt) * 10)),
      rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576),
      eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
      eventLoopMaxMs: Math.round(delay.max / 1e6) }));
    cpu = process.cpuUsage(); sampledAt = now; completed = 0; delay.reset();
  }, 60000);
  timer.unref();
  return () => { clearInterval(timer); delay.disable(); };
}
