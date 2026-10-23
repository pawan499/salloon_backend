import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import swagger from 'swagger-ui-express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { logger } from './utils/core.js';
import { errors } from './middleware/http.js';
import { router } from './routes/index.js';
import { openapi } from './config/openapi.js';
export const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false }));
app.use(
  pinoHttp({
    logger,
    genReqId: () => randomUUID(),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);
app.use(express.json({ limit: '100kb' }));
app.get('/health/live', (_req, res) => res.json({ success: true, data: { status: 'alive' } }));
app.get('/health/ready', (_req, res) =>
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    success: mongoose.connection.readyState === 1,
    data: { database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' },
  }),
);
app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
app.use('/docs', swagger.serve, swagger.setup(openapi));
app.use('/api/v1', router);
app.use((_req, res) =>
  res
    .status(404)
    .json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } }),
);
app.use(errors);
