import { z } from 'zod';

// ---- potongan skema yang dipakai ulang ------------------------------------
const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1, 'Wajib diisi').max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const rupiah = z.number().int().min(0).max(1_000_000_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal harus berformat YYYY-MM-DD');
/** Angka desimal dikirim sebagai string (maks. 3 desimal) agar tidak kena pembulatan. */
const dec = (signed = false) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine(
      (v) => (signed ? /^-?\d{1,11}(\.\d{1,3})?$/ : /^\d{1,11}(\.\d{1,3})?$/).test(v),
      'Angka tidak valid (maksimal 3 desimal)',
    );
const createdAt = z.string().datetime({ offset: true }).optional();

export interface EntitySpec {
  table: string;
  /** Hanya kolom yang BOLEH ditulis klien. created_by, device_id, is_system, dll diisi/dijaga server. */
  schema: z.AnyZodObject;
}

const spec = (table: string, shape: z.ZodRawShape): EntitySpec => ({
  table,
  schema: z.object({ ...shape, created_at: createdAt }).strict(),
});

/** Entitas MVP yang boleh dikirim lewat /sync/push. Kunci = nama tabel. */
export const ENTITIES: Record<string, EntitySpec> = {
  accounts: spec('accounts', {
    name: text(100),
    type: z.enum(['cash', 'bank']),
    bank_name: optText(100),
    account_number: optText(50),
    opening_balance: z.number().int().default(0),
    is_active: z.boolean().default(true),
  }),
  trx_categories: spec('trx_categories', {
    name: text(100),
    direction: z.enum(['in', 'out']),
    field_allowed: z.boolean().default(false),
    is_active: z.boolean().default(true),
  }),
  lands: spec('lands', {
    name: text(100),
    location: optText(200),
    area_ha: dec().nullish(),
    ownership: z.enum(['owned', 'rented']),
    landlord_name: optText(100),
    landlord_phone: optText(30),
    rent_cost: rupiah.nullish(),
    rent_start: date.nullish(),
    rent_end: date.nullish(),
    status: z.enum(['empty', 'planted', 'ready_harvest', 'harvested']).default('empty'),
    notes: optText(1000),
  }),
  suppliers: spec('suppliers', { name: text(100), phone: optText(30), address: optText(300) }),
  warehouses: spec('warehouses', { name: text(100), notes: optText(500) }),
  items: spec('items', {
    code: text(40),
    name: text(150),
    category: z.enum(['seed', 'fertilizer', 'pesticide', 'medicine', 'harvest', 'tool']),
    unit: text(20),
    buy_price: rupiah.default(0),
    sell_price: rupiah.default(0),
    min_stock: dec().default('0'),
    notes: optText(1000),
    is_active: z.boolean().default(true),
  }),
  cash_transactions: spec('cash_transactions', {
    account_id: uuid,
    direction: z.enum(['in', 'out']),
    kind: z.enum(['normal', 'transfer']).default('normal'),
    category_id: uuid.nullish(),
    land_id: uuid.nullish(),
    season_id: uuid.nullish(),
    amount: z.number().int().positive().max(1_000_000_000_000),
    trx_date: date,
    description: optText(500),
    transfer_group_id: uuid.nullish(),
  }),
  stock_movements: spec('stock_movements', {
    item_id: uuid,
    warehouse_id: uuid,
    move_type: z.enum(['purchase_in', 'harvest_in', 'usage_out', 'sale_out', 'adjustment']),
    qty_delta: dec(true),
    unit_price: rupiah.nullish(),
    supplier_id: uuid.nullish(),
    land_id: uuid.nullish(),
    season_id: uuid.nullish(),
    cash_transaction_id: uuid.nullish(),
    move_date: date,
    notes: optText(500),
  }),
};

/** Urutan entitas di respons pull (induk lebih dulu agar relasi aman diterapkan di HP). */
export const ENTITY_ORDER = [
  'accounts',
  'trx_categories',
  'lands',
  'suppliers',
  'warehouses',
  'items',
  'cash_transactions',
  'stock_movements',
] as const;
