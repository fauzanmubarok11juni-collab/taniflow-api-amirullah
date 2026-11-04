import crypto from 'node:crypto';
import * as argon2 from 'argon2';

export const hashSecret = (secret: string): Promise<string> => argon2.hash(secret, { type: argon2.argon2id });

export const verifySecret = (hash: string, secret: string): Promise<boolean> =>
  argon2.verify(hash, secret).catch(() => false);

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export const newToken = (): string => crypto.randomBytes(32).toString('base64url');
