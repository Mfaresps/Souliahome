import { notificationBody } from '../../src/notifications/notifications.service';
import { notificationTitle } from '../../src/notifications/notification-titles';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const { verifyLiveRelease, announceRelease } = require('../../scripts/notify-release.cjs');

describe('Successful live release notifications', () => {
  it('verifies the exact live build before announcing it', async () => {
    const fetchLive = jest.fn(async () => ({ ok: true, json: async () => ({ build: '125', version: '1.0.125' }) }));
    expect(await verifyLiveRelease('125', fetchLive)).toEqual({ build: '125', version: '1.0.125' });
    expect(fetchLive).toHaveBeenCalledWith('http://frontend/version.json', expect.objectContaining({ cache: 'no-store' }));
    await expect(verifyLiveRelease('126', fetchLive)).rejects.toThrow('does not match');
    await expect(verifyLiveRelease('dev', fetchLive)).rejects.toThrow('CI build');
    await expect(verifyLiveRelease('125', async () => ({ ok: false }))).rejects.toThrow('version check');
  });
  it('uses one stable event for all accounts on retries and reports incomplete history', async () => {
    const service = { enqueue: jest.fn() };
    const count = jest.fn(async () => 3);
    const connection = { collection: () => ({ countDocuments: count }) };
    const release = { build: '125', version: '1.0.125' };
    expect(await announceRelease(service, connection, release)).toBe(3);
    await announceRelease(service, connection, release);
    expect(service.enqueue.mock.calls[0]).toEqual(service.enqueue.mock.calls[1]);
    expect(service.enqueue).toHaveBeenCalledWith('announcement', 'release:125', '', '', undefined, undefined, { releaseVersion: '1.0.125' });
    count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    await expect(announceRelease(service, connection, release)).rejects.toThrow('incomplete');
  });
  it.each(['ar', 'en'] as const)('includes the deployed version in the %s message', language => {
    const details = { releaseVersion: '1.0.125' };
    expect(notificationTitle('announcement', details, language)).toBe(language === 'ar' ? '🚀 تم رفع نسخة جديدة · SOULIA' : '🚀 New Version Is Live · SOULIA');
    expect(notificationBody('announcement', '', details, language)).toContain('1.0.125');
  });
  it('runs notifications only on main after the health check and ships the helper in the backend image', () => {
    const pipeline = readFileSync(resolve(__dirname, '../../../Jenkinsfile'), 'utf8');
    expect(pipeline.indexOf("stage('Notify live release')")).toBeGreaterThan(pipeline.indexOf("stage('Health check')"));
    expect(pipeline.slice(pipeline.indexOf("stage('Notify live release')"))).toContain("when { branch 'main' }");
    expect(readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8')).toContain('COPY scripts/notify-release.cjs');
  });
  it('provides the live inline deploy job with readiness and a release announcement after health succeeds', () => {
    const pipeline = readFileSync(resolve(__dirname, '../../../Jenkins.deploy.groovy'), 'utf8');
    expect(pipeline).toContain('cd /opt/Souliahome');
    expect(pipeline).toContain('http://127.0.0.1:8082/api/health');
    expect(pipeline).toContain('[ "$api" = "200" ]');
    expect(pipeline).not.toContain('/api/auth/login');
    expect(pipeline).not.toContain('__hc__');
    expect(pipeline.indexOf("stage('Notify live release')")).toBeGreaterThan(pipeline.indexOf("stage('Health check')"));
    expect(pipeline).toContain('scripts/notify-release.cjs "$BUILD_NUMBER"');
    // This is an inline job, not a multibranch job: branch conditions would
    // silently skip its health or announcement stages.
    expect(pipeline).not.toContain("when { branch");
  });
});
