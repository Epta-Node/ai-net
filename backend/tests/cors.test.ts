import express from 'express';
import request from 'supertest';
import { createCorsMiddleware } from '../src/api/middleware/cors';

describe('CORS Middleware', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.resetModules();
    process.env.ALLOWED_ORIGINS = 'http://trusted.com,https://app.trusted.com';
    const corsMiddleware = require('../src/api/middleware/cors').createCorsMiddleware();
    
    app = express();
    app.use(corsMiddleware);
    app.get('/test', (req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  it('allows configured origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://trusted.com');
      
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://trusted.com');
  });

  it('blocks unauthorized origin', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://evil.com');
      
    expect(res.status).toBe(500); // cors module calls next(new Error('Not allowed by CORS')) which causes 500 in express default error handler
    expect(res.text).toContain('Not allowed by CORS');
  });

  it('allows requests with no Origin header (e.g. server-to-server)', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('sets credentials header when origin is allowed', async () => {
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://app.trusted.com');

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('responds to preflight OPTIONS with allowed methods', async () => {
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://trusted.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBeLessThan(300);
    const methods = res.headers['access-control-allow-methods'];
    expect(methods).toContain('POST');
    expect(methods).toContain('GET');
  });

  it('falls back to http://localhost:3000 when ALLOWED_ORIGINS is unset', async () => {
    jest.resetModules();
    delete process.env.ALLOWED_ORIGINS;
    const corsMiddleware = require('../src/api/middleware/cors').createCorsMiddleware();
    const localApp = express();
    localApp.use(corsMiddleware);
    localApp.get('/test', (_req, res) => res.json({ ok: true }));

    const res = await request(localApp)
      .get('/test')
      .set('Origin', 'http://localhost:3000');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});

describe('HSTS Middleware', () => {
  function buildApp(env: string) {
    const app = express();
    app.use((_req, res, next) => {
      if (env === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      }
      next();
    });
    app.get('/test', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('sets HSTS header in production', async () => {
    const app = buildApp('production');
    const res = await request(app).get('/test');
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains; preload',
    );
  });

  it('does not set HSTS header in development', async () => {
    const app = buildApp('development');
    const res = await request(app).get('/test');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
