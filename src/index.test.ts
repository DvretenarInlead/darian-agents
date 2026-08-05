import { describe, it, expect, beforeAll } from 'vitest';

// config() validates env lazily on first use; set the one required var before
// building the server. No webhook secret → the webhook route stays unmounted.
beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/test';
  delete process.env.FIREFLIES_WEBHOOK_SECRET;
});

const build = async () => (await import('./index.js')).buildServer();

describe('web server routes', () => {
  it('serves service info at / (no bare 404)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: 'darian-agents', status: 'ok' });
    await app.close();
  });

  it('serves liveness at /healthz', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('exposes Prometheus metrics at /metrics', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# HELP');
    await app.close();
  });
});
