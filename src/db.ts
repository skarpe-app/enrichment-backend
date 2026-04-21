import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config.js';

// Prisma uses the transaction pooler (PgBouncer, port 6543).
// connection_limit=1 in the URL — PgBouncer multiplexes internally.
const pool = new Pool({ connectionString: config.DATABASE_URL_POOLER });
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({
  adapter,
  log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Direct pg pool for one-off operations that need session-level connections.
// pg-boss uses its own internal pool on DATABASE_URL_DIRECT (see worker.ts).
export const directPool = new Pool({
  connectionString: config.DATABASE_URL_DIRECT,
  max: 3,
});

export async function disconnectAll() {
  await prisma.$disconnect();
  await pool.end();
  await directPool.end();
}
