import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENTITIES } from '../src/modules/sync/entities';

const item = { code: 'UREA', name: 'Urea', category: 'fertilizer', unit: 'sak' };

test('items: nilai bawaan terisi saat membuat', () => {
  const r = ENTITIES.items.schema.parse(item);
  assert.equal(r.min_stock, '0');
  assert.equal(r.is_active, true);
  assert.equal(r.buy_price, 0);
});

test('items: update parsial hanya memuat kolom yang dikirim', () => {
  assert.deepEqual(ENTITIES.items.schema.partial().parse({ name: 'Urea Subsidi' }), { name: 'Urea Subsidi' });
});

test('kunci yang tidak dikenal (mis. created_by, is_system) ditolak', () => {
  assert.throws(() => ENTITIES.items.schema.parse({ ...item, created_by: 'x' }));
  assert.throws(() => ENTITIES.trx_categories.schema.parse({ name: 'X', direction: 'in', is_system: true }));
});

test('qty_delta menerima string/angka dengan maksimal 3 desimal', () => {
  const base = { item_id: crypto.randomUUID(), warehouse_id: crypto.randomUUID(), move_type: 'usage_out', move_date: '2026-11-01' };
  assert.equal(ENTITIES.stock_movements.schema.parse({ ...base, qty_delta: '-2.5' }).qty_delta, '-2.5');
  assert.equal(ENTITIES.stock_movements.schema.parse({ ...base, qty_delta: -3 }).qty_delta, '-3');
  assert.throws(() => ENTITIES.stock_movements.schema.parse({ ...base, qty_delta: '1.2345' }));
});

test('kas: amount harus bilangan bulat positif dan tanggal berformat YYYY-MM-DD', () => {
  const base = { account_id: crypto.randomUUID(), direction: 'out', category_id: crypto.randomUUID(), trx_date: '2026-11-01' };
  assert.doesNotThrow(() => ENTITIES.cash_transactions.schema.parse({ ...base, amount: 1000 }));
  assert.throws(() => ENTITIES.cash_transactions.schema.parse({ ...base, amount: 0 }));
  assert.throws(() => ENTITIES.cash_transactions.schema.parse({ ...base, amount: 10.5 }));
  assert.throws(() => ENTITIES.cash_transactions.schema.parse({ ...base, amount: 1000, trx_date: '01/11/2026' }));
});
