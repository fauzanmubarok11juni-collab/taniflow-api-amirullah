import type { Permissions, Role } from '../../shared/permissions';

export type Filter = 'none' | 'own' | 'field_allowed';

export interface Scope {
  filter: Filter;
  /** Kolom yang dibuang dari baris sebelum dikirim ke HP. */
  omit: string[];
}

const FULL: Scope = { filter: 'none', omit: [] };
/** Akun kas sebagai data rujukan saja (nama + jenis), tanpa saldo awal dan nomor rekening. */
const ACCOUNT_REFERENCE_ONLY: Scope = { filter: 'none', omit: ['opening_balance', 'bank_name', 'account_number'] };

/** Data apa yang boleh diturunkan ke HP peran ini (null = tidak sama sekali). */
export function pullScope(perms: Permissions, role: Role, entity: string): Scope | null {
  const canRead = (resource: string) => perms.can(role, resource, 'R');
  const own: Filter = role === 'mandor' ? 'own' : 'none';

  switch (entity) {
    case 'accounts':
      if (canRead('accounts')) return FULL;
      // Peran yang boleh mencatat kas perlu daftar akun untuk memilih, tapi bukan saldonya.
      return perms.can(role, 'cash', 'C') ? ACCOUNT_REFERENCE_ONLY : null;
    case 'trx_categories':
      if (!canRead('categories')) return null;
      return { filter: role === 'mandor' ? 'field_allowed' : 'none', omit: [] };
    case 'lands':
      return canRead('lands') ? FULL : null;
    case 'items':
      return canRead('items') ? FULL : null;
    case 'warehouses':
      return canRead('items') || canRead('stock') ? FULL : null;
    case 'suppliers':
      return role !== 'mandor' && canRead('stock') ? FULL : null;
    case 'cash_transactions':
      return canRead('cash') ? { filter: own, omit: [] } : null;
    case 'stock_movements':
      return canRead('stock') ? { filter: own, omit: [] } : null;
    default:
      return null;
  }
}
