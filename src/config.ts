import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL wajib diisi'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET minimal 32 karakter'),
  ACCESS_TTL_SECONDS: z.coerce.number().default(900), // 15 menit
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
});

export const config = schema.parse(process.env);
