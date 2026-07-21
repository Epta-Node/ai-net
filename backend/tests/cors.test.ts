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
});
