import type { FastifyRequest, FastifyReply } from 'fastify';
import { supabaseAdmin } from '../services/supabase.js';
import { prisma } from '../db.js';
import type { UserRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

// Extend Fastify request type
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

/**
 * Auth middleware: validates JWT via Supabase, loads profile, attaches to request.
 * Registered as a global preHandler on all /api/* routes except /api/health.
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // 1. Read Authorization header
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: {
        code: 'unauthenticated',
        message: 'Missing or malformed Authorization header',
      },
    });
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  // 2. Validate token via Supabase Auth
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return reply.status(401).send({
      error: {
        code: 'unauthenticated',
        message: 'Invalid or expired token',
      },
    });
  }

  // 3. Load profile
  const profile = await prisma.profile.findUnique({
    where: { id: data.user.id },
    select: { id: true, email: true, role: true },
  });

  if (!profile) {
    return reply.status(500).send({
      error: {
        code: 'profile_missing',
        message: 'Profile row not found for authenticated user',
      },
    });
  }

  // 4. Attach to request
  request.user = {
    id: profile.id,
    email: profile.email,
    role: profile.role,
  };
}

/**
 * Admin-only preHandler. Runs AFTER authMiddleware.
 * Returns 403 if the user is not an admin.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'ADMIN') {
    return reply.status(403).send({
      error: {
        code: 'forbidden',
        message: 'Admin access required',
      },
    });
  }
}
