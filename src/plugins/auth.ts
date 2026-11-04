import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config';
import { pool } from '../db/pool';
import { ApiError } from '../shared/errors';
import { Act, Role, permissions } from '../shared/permissions';

export interface AuthUser {
  id: string;
  role: Role;
  deviceId: string;
  fullName: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; did: string };
    user: { sub: string; did: string };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthUser;
  }
  interface FastifyInstance {
    authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/** Lempar 403 bila peran pengguna tidak boleh melakukan [act] pada [resource]. */
export function assertCan(user: AuthUser, resource: string, act: Act): void {
  if (!permissions.can(user.role, resource, act)) {
    throw new ApiError(403, 'FORBIDDEN', 'Peran Anda tidak diizinkan melakukan ini.');
  }
}

export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: config.JWT_SECRET,
      sign: { expiresIn: config.ACCESS_TTL_SECONDS },
    });
    app.decorateRequest('auth', null as unknown as AuthUser);

    app.decorate('authenticate', async (req: FastifyRequest) => {
      try {
        await req.jwtVerify();
      } catch {
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau kedaluwarsa.');
      }
      const deviceId = req.headers['x-device-id'];
      if (typeof deviceId !== 'string' || deviceId !== req.user.did) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'Token tidak cocok dengan perangkat ini.');
      }
      // Peran dan status aktif selalu dibaca dari database, jadi perubahan Owner berlaku seketika.
      const r = await pool.query(
        'SELECT id, role, full_name, is_active FROM users WHERE id = $1 AND deleted_at IS NULL',
        [req.user.sub],
      );
      const u = r.rows[0];
      if (!u || !u.is_active) throw new ApiError(401, 'UNAUTHENTICATED', 'Akun tidak aktif.');
      req.auth = { id: u.id, role: u.role as Role, deviceId, fullName: u.full_name };
    });
  },
  { name: 'taniflow-auth' },
);
