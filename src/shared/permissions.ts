import fs from 'node:fs';
import path from 'node:path';

export type Role = 'owner' | 'admin' | 'gudang' | 'mandor';
export type Act = 'R' | 'C' | 'U' | 'D';
type Rules = Record<string, Record<string, string>>;

/** Matriks hak akses dari permissions.json (file yang sama dipakai aplikasi Flutter). */
export class Permissions {
  constructor(private rules: Rules) {}
  can(role: Role, resource: string, act: Act): boolean {
    return (this.rules[role]?.[resource] ?? '').includes(act);
  }
}

export function loadPermissions(file = path.join(__dirname, '..', '..', 'permissions.json')): Permissions {
  return new Permissions(JSON.parse(fs.readFileSync(file, 'utf8')) as Rules);
}

export const permissions = loadPermissions();
