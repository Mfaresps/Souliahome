import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { HealthController } from '../../src/core/health.controller';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Deployment readiness endpoint', () => {
  let app: INestApplication;
  let url: string;
  const command = jest.fn();
  const connection: any = { readyState: 1, db: { command } };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: getConnectionToken(), useValue: connection }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()) + '/api/health';
  });
  beforeEach(() => {
    connection.readyState = 1;
    connection.db = { command };
    command.mockReset().mockResolvedValue({ ok: 1 });
  });
  afterAll(async () => { await app?.close(); });
  it('responds without login credentials after verifying MongoDB', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(command).toHaveBeenCalledWith({ ping: 1 }, { timeoutMS: 2000 });
  });
  it.each([0, 2, 3])('returns 503 when MongoDB is not connected (state %s)', async state => {
    connection.readyState = state;
    const res = await fetch(url);
    expect(res.status).toBe(503);
    expect(command).not.toHaveBeenCalled();
  });
  it('returns 503 if the database handle is unavailable', async () => {
    connection.db = undefined;
    expect((await fetch(url)).status).toBe(503);
  });
  it('returns 503 for failed database commands without exposing database details', async () => {
    command.mockRejectedValueOnce(new Error('private database connection detail'));
    const res = await fetch(url);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('private database connection detail');
  });
  it('uses readiness for deployment and no longer posts artificial login attempts', () => {
    const pipeline = readFileSync(resolve(__dirname, '../../../Jenkinsfile'), 'utf8');
    const health = pipeline.slice(pipeline.indexOf("stage('Health check')"), pipeline.indexOf("stage('Notify live release')"));
    expect(health).toContain('http://localhost:8080/api/health');
    expect(health).not.toContain('/api/auth/login');
    expect(health).not.toContain('__healthcheck__');
    expect(pipeline).not.toContain('__hc__');
    expect(pipeline).not.toContain('/api/auth/login');
    expect(health).toContain('[ "$api_code" = "200" ]');
  });
});
