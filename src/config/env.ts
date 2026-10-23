import 'dotenv/config';
import { z } from 'zod';
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
export const env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGODB_URI: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
    REDIS_URL: optionalUrl,
    PAYMENT_PROVIDER_URL: optionalUrl,
    PAYMENT_PROVIDER_TOKEN: z.string().optional(),
    MESSAGE_PROVIDER_URL: optionalUrl,
    MESSAGE_PROVIDER_TOKEN: z.string().optional(),
  })
  .parse(process.env);
if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET)
  throw new Error('JWT secrets must be different');
if (env.NODE_ENV === 'production') {
  for (const url of [env.PAYMENT_PROVIDER_URL, env.MESSAGE_PROVIDER_URL]) {
    if (url && !url.startsWith('https://'))
      throw new Error('Provider URLs must use HTTPS in production');
  }
}
