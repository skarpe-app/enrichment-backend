import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

/**
 * Supabase admin client (service_role key).
 * Used ONLY for:
 * 1. Auth token verification (supabaseAdmin.auth.getUser)
 * 2. Storage file operations (csv-uploads bucket)
 *
 * NEVER use for table CRUD — Prisma is the sole data layer.
 */
export const supabaseAdmin = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
