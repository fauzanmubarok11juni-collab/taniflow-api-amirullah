import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissions } from '../src/shared/permissions';
import type { Role } from '../src/shared/permissions';
import { Denied, authorizeWrite, checkTransferPairs, clampCreatedAt } from '../src/modules/sync/rules';
import type { PushOp } from '../src/modules/sync/rules';
import { pullScope } from '../src/modules/sync/scope';

const as = (role: Role) => ({ id: 'u1', role });
const cash = (o: Record<string, unknown> = {}) => ({ kind: 'normal', direction: 'out', amount: 1000, ...o });
const catOut = { category: { direction: 'out', field_allowed: true } };

test('Mandor boleh mencatat pengeluaran kategori lapangan', () => {
  assert.doesNotThrow(() => authorizeWrite(permissions, as('mandor'), 'cash_transactions', 'create', cash(), null, catOut));
});

test('Mandor ditolak: kategori non-lapangan, pemasukan, transfer, pemasok', () => {
  const notField = { category: { direction: 'out', field_allowed: false } };
  assert.throws(() => authorizeWrite(permissions, as('mandor'), 'cash_transactions', 'create', cash(), null, notField), Denied);
  const catIn = { category: { direction: 'in', field_allowed: true } };
  assert.throws(() => authorizeWrite(permissions, as('mandor'), 'cash_transactions', 'create', cash({ direction: 'in' }), null, catIn), Denied);
  assert.throws(() => authorizeWrite(permissions, as('mandor'), 'cash_transactions', 'create', cash({ kind: 'transfer' }), null), Denied);
  assert.throws(() => authorizeWrite(permissions, as('mandor'), 'suppliers', 'create', { name: 'X' }, null), Denied);
});

test('Admin boleh membuat kas tetapi tidak boleh mengubah atau menghapus', () => {
  assert.doesNotThrow(() => authorizeWrite(permissions, as('admin'), 'cash_transactions', 'create', cash(), null, catOut));
  const row = { kind: 'normal' };
  assert.throws(() => authorizeWrite(permissions, as('admin'), 'cash_transactions', 'update', cash(), row, catOut), Denied);
  assert.throws(() => authorizeWrite(permissions, as('admin'), 'cash_transactions', 'delete', {}, row), Denied);
});

test('Owner boleh menghapus transfer; Admin boleh membuatnya', () => {
  assert.doesNotThrow(() => authorizeWrite(permissions, as('owner'), 'cash_transactions', 'delete', {}, { kind: 'transfer' }));
  assert.doesNotThrow(() => authorizeWrite(permissions, as('admin'), 'cash_transactions', 'create', cash({ kind: 'transfer' }), null));
});

test('Kategori harus sesuai arah transaksi', () => {
  assert.throws(
    () => authorizeWrite(permissions, as('owner'), 'cash_transactions', 'create', cash({ direction: 'in' }), null, catOut),
    Denied,
  );
});

test('Stok: jenis pergerakan dibatasi per peran', () => {
  const mv = (move_type: string) => ({ move_type, qty_delta: '1' });
  const ok = (role: Role, t: string) => authorizeWrite(permissions, as(role), 'stock_movements', 'create', mv(t), null);
  assert.doesNotThrow(() => ok('admin', 'purchase_in'));
  assert.doesNotThrow(() => ok('admin', 'sale_out'));
  assert.throws(() => ok('admin', 'usage_out'), Denied);
  assert.throws(() => ok('admin', 'adjustment'), Denied); // opname bukan hak Admin
  assert.doesNotThrow(() => ok('gudang', 'adjustment'));
  assert.doesNotThrow(() => ok('mandor', 'usage_out'));
  assert.throws(() => ok('mandor', 'purchase_in'), Denied);
});

test('Hanya Owner yang boleh mengubah atau menghapus stok dan master barang', () => {
  assert.throws(() => authorizeWrite(permissions, as('gudang'), 'stock_movements', 'update', { move_type: 'usage_out' }, { move_type: 'usage_out' }), Denied);
  assert.throws(() => authorizeWrite(permissions, as('admin'), 'items', 'create', { code: 'X' }, null), Denied);
  assert.doesNotThrow(() => authorizeWrite(permissions, as('owner'), 'items', 'create', { code: 'X' }, null));
});

test('pullScope: data yang turun ke HP dibatasi per peran', () => {
  const s = (role: Role, e: string) => pullScope(permissions, role, e);
  assert.equal(s('gudang', 'cash_transactions'), null);
  assert.equal(s('gudang', 'accounts'), null);
  assert.deepEqual(s('mandor', 'cash_transactions'), { filter: 'own', omit: [] });
  assert.deepEqual(s('mandor', 'trx_categories'), { filter: 'field_allowed', omit: [] });
  assert.deepEqual(s('mandor', 'accounts')?.omit, ['opening_balance', 'bank_name', 'account_number']);
  assert.equal(s('mandor', 'suppliers'), null);
  assert.deepEqual(s('admin', 'cash_transactions'), { filter: 'none', omit: [] });
  assert.deepEqual(s('owner', 'accounts'), { filter: 'none', omit: [] });
  assert.equal(s('owner', 'tidak_ada'), null);
});

const leg = (op_id: string, o: Record<string, unknown>): PushOp => ({
  op_id,
  entity: 'cash_transactions',
  entity_id: op_id,
  op: 'upsert',
  data: { kind: 'transfer', transfer_group_id: 'g1', amount: 5000, ...o },
});

test('Transfer: pasangan yang benar lolos', () => {
  const bad = checkTransferPairs([leg('a', { direction: 'out', account_id: 'k' }), leg('b', { direction: 'in', account_id: 'b' })]);
  assert.equal(bad.size, 0);
});

test('Transfer: satu sisi, jumlah beda, arah sama, atau akun sama ditolak', () => {
  assert.equal(checkTransferPairs([leg('a', { direction: 'out', account_id: 'k' })]).size, 1);
  assert.equal(checkTransferPairs([leg('a', { direction: 'out', account_id: 'k' }), leg('b', { direction: 'in', account_id: 'b', amount: 1 })]).size, 2);
  assert.equal(checkTransferPairs([leg('a', { direction: 'out', account_id: 'k' }), leg('b', { direction: 'out', account_id: 'b' })]).size, 2);
  assert.equal(checkTransferPairs([leg('a', { direction: 'out', account_id: 'k' }), leg('b', { direction: 'in', account_id: 'k' })]).size, 2);
});

test('clampCreatedAt membatasi waktu yang terlalu maju', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  assert.equal(clampCreatedAt(undefined, now).getTime(), now.getTime());
  assert.equal(clampCreatedAt('2026-11-01T08:00:00Z', now).toISOString(), '2026-11-01T08:00:00.000Z');
  assert.equal(clampCreatedAt('2027-01-01T00:00:00Z', now).toISOString(), '2026-11-01T10:05:00.000Z');
  assert.equal(clampCreatedAt('bukan-tanggal', now).getTime(), now.getTime());
});
