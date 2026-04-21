import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Database
  DATABASE_URL_POOLER: z.string().min(1),
  DATABASE_URL_DIRECT: z.string().min(1),

  // Company default AI
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_DEFAULT_PROMPT_ID: z.string().min(1),
  OPENAI_DEFAULT_PROMPT_VERSION: z.string().min(1),
  OPENAI_DEFAULT_MODEL: z.string().default('gpt-4.1-mini'),

  // Security
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  // Server
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Frontend URL (for CORS in production — the separately deployed frontend origin)
  FRONTEND_URL: z.string().url().optional(),

  // Scraper user agent (defaults to Chrome in proxy-racer.ts if not set)
  SCRAPER_USER_AGENT: z.string().optional(),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof envSchema>;
