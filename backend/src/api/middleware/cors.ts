import cors from 'cors';
import { allowedOrigins } from '../../config';

export function createCorsMiddleware() {
  const origins = allowedOrigins();

  return cors({
    origin: (origin, callback) => {
      if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'walletpublickey', 'x-challenge', 'x-signature'],
  });
}
