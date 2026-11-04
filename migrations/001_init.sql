-- =====================================================================
-- TaniFlow — Skema Backend (PostgreSQL 15+ / Supabase)
-- Usaha Tani Pak Amirullah
--
-- PRINSIP OFFLINE-FIRST
--  1. PK = UUID yang dibuat di HP  -> aman diinput saat offline, tidak bentrok.
--  2. Soft delete (deleted_at)     -> penghapusan ikut tersinkron ke HP lain.
--  3. server_version               -> penanda urutan perubahan dari server.
--     HP menarik "semua perubahan dengan versi > X". Lebih andal daripada
--     timestamp (jam HP bisa salah/beda-beda).
--  4. Saldo kas & stok TIDAK disimpan, tapi dihitung dari buku besar
--     (cash_transactions & stock_movements) -> tidak pernah "selisih".
--  5. Konflik = last-write-wins (urutan tiba di server); nilai yang tertimpa
--     dicatat di audit_logs agar owner bisa menelusuri.
--  6. Uang = bigint rupiah utuh (tanpa sen). Jumlah barang = numeric(14,3).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SEQUENCE sync_version_seq;

CREATE TYPE user_role       AS ENUM ('owner','admin','gudang','mandor');
CREATE TYPE account_type    AS ENUM ('cash','bank');
CREATE TYPE flow_dir        AS ENUM ('in','out');
CREATE TYPE trx_kind        AS ENUM ('normal','transfer');
CREATE TYPE ownership_type  AS ENUM ('owned','rented');
CREATE TYPE land_status     AS ENUM ('empty','planted','ready_harvest','harvested');
CREATE TYPE item_category   AS ENUM ('seed','fertilizer','pesticide','medicine','harvest','tool');
CREATE TYPE stock_move_type AS ENUM ('purchase_in','harvest_in','usage_out','sale_out','adjustment');
CREATE TYPE activity_type   AS ENUM ('planting','fertilizing','spraying','harvesting','other');

-- Kolom sinkronisasi (dipakai ulang di setiap tabel bisnis):
--   created_by, device_id, created_at, updated_at, deleted_at, server_version

-- ---------------------------------------------------------------------
-- A. PENGGUNA & PERANGKAT
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  email         text UNIQUE,
  full_name     text NOT NULL,
  phone_wa      text,                       -- format 62812xxxx (untuk notifikasi WA)
  role          user_role NOT NULL,         -- maksimal 2 owner: dijaga di API
  password_hash text NOT NULL,              -- argon2id
  pin_hash      text,                       -- PIN 6 digit, argon2id
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

CREATE TABLE devices (
  id                  text PRIMARY KEY,     -- ID unik instalasi app
  user_id             uuid NOT NULL REFERENCES users(id),
  name                text,                 -- mis. "Redmi Note 12 - Mandor Budi"
  platform            text DEFAULT 'android',
  fcm_token           text,
  last_seen_at        timestamptz,
  last_synced_version bigint NOT NULL DEFAULT 0
);

CREATE TABLE refresh_tokens (               -- sesi login; hanya hash yang disimpan
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  device_id  text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,            -- 30 hari, dirotasi tiap dipakai
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE app_settings (                 -- pengaturan server (online-only, tidak disinkron)
  key        text PRIMARY KEY,                -- mis. notif.daily_summary_time
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- B. MASTER DATA
-- ---------------------------------------------------------------------
CREATE TABLE accounts (                     -- Master Akun Kas
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,            -- "Kas Tunai", "Bank BRI"
  type            account_type NOT NULL,
  bank_name       text,
  account_number  text,
  opening_balance bigint NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id), device_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  server_version  bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

CREATE TABLE trx_categories (               -- Master Kategori Transaksi
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  direction      flow_dir NOT NULL,         -- in = pemasukan, out = pengeluaran
  is_system      boolean NOT NULL DEFAULT false,
  field_allowed  boolean NOT NULL DEFAULT false,  -- boleh dipilih Mandor (pengeluaran lapangan)
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id), device_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

CREATE TABLE lands (                        -- Master Lahan
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  location       text,
  area_ha        numeric(10,2),
  ownership      ownership_type NOT NULL,   -- milik / sewa (wajib dibedakan)
  landlord_name  text,                      -- pemilik lahan jika sewa
  landlord_phone text,
  rent_cost      bigint,                    -- biaya sewa per periode
  rent_start     date,
  rent_end       date,
  status         land_status NOT NULL DEFAULT 'empty',
  notes          text,
  created_by     uuid REFERENCES users(id), device_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq'),
  CHECK (ownership = 'owned' OR landlord_name IS NOT NULL)
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, phone text, address text,
  created_by uuid REFERENCES users(id), device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

CREATE TABLE warehouses (                   -- Gudang (seed: 1 gudang utama)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, notes text,
  created_by uuid REFERENCES users(id), device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

CREATE TABLE items (                        -- Master Barang
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  name           text NOT NULL,
  category       item_category NOT NULL,
  unit           text NOT NULL,             -- kg, liter, sak, unit
  buy_price      bigint NOT NULL DEFAULT 0,
  sell_price     bigint NOT NULL DEFAULT 0,
  min_stock      numeric(14,3) NOT NULL DEFAULT 0,
  notes          text,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id), device_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);
CREATE UNIQUE INDEX uq_items_code ON items (code) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- C. MUSIM TANAM & AKTIVITAS LAHAN   (Tahap 2, tabel disiapkan sekarang)
-- ---------------------------------------------------------------------
CREATE TABLE seasons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  land_id             uuid NOT NULL REFERENCES lands(id),
  commodity           text NOT NULL,        -- padi, bawang, semangka, ...
  start_date          date NOT NULL,        -- tanggal mulai tanam
  est_harvest_date    date,
  actual_harvest_date date,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
  notes               text,
  created_by          uuid REFERENCES users(id), device_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  server_version      bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

CREATE TABLE land_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  land_id uuid NOT NULL REFERENCES lands(id),
  season_id uuid REFERENCES seasons(id),
  type activity_type NOT NULL,
  activity_date date NOT NULL,
  notes text,
  created_by uuid REFERENCES users(id), device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

-- ---------------------------------------------------------------------
-- D. TRANSAKSI KAS (buku besar)
-- ---------------------------------------------------------------------
-- Transfer tunai<->bank = 2 baris (out di akun asal, in di akun tujuan) dengan
-- transfer_group_id sama dan kind='transfer'. Baris transfer TIDAK dihitung
-- sebagai pemasukan/pengeluaran di dashboard & laporan.
CREATE TABLE cash_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id),
  direction         flow_dir NOT NULL,
  kind              trx_kind NOT NULL DEFAULT 'normal',
  category_id       uuid REFERENCES trx_categories(id),
  land_id           uuid REFERENCES lands(id),
  season_id         uuid REFERENCES seasons(id),
  amount            bigint NOT NULL CHECK (amount > 0),
  trx_date          date NOT NULL,
  description       text,
  receipt_path      text,                   -- foto nota (Tahap 2), path di storage privat
  transfer_group_id uuid,
  created_by        uuid NOT NULL REFERENCES users(id),
  device_id         text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  server_version    bigint NOT NULL DEFAULT nextval('sync_version_seq'),
  CHECK (
    (kind = 'normal'   AND category_id IS NOT NULL) OR
    (kind = 'transfer' AND category_id IS NULL AND transfer_group_id IS NOT NULL)
  )
);
CREATE INDEX idx_cash_acc_date ON cash_transactions (account_id, trx_date);
CREATE INDEX idx_cash_date     ON cash_transactions (trx_date);
CREATE INDEX idx_cash_land     ON cash_transactions (land_id) WHERE land_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- E. STOK BARANG (buku besar)
-- ---------------------------------------------------------------------
CREATE TABLE stock_opnames (                -- Tahap 2
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  opname_date date NOT NULL, notes text,
  created_by uuid REFERENCES users(id), device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT nextval('sync_version_seq')
);

-- qty_delta bertanda: + masuk, - keluar. Stok = SUM(qty_delta).
CREATE TABLE stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             uuid NOT NULL REFERENCES items(id),
  warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  move_type           stock_move_type NOT NULL,
  qty_delta           numeric(14,3) NOT NULL CHECK (qty_delta <> 0),
  unit_price          bigint,
  supplier_id         uuid REFERENCES suppliers(id),
  land_id             uuid REFERENCES lands(id),          -- lahan tujuan / asal panen
  season_id           uuid REFERENCES seasons(id),
  cash_transaction_id uuid REFERENCES cash_transactions(id), -- bila pembelian/penjualan tercatat di kas
  opname_id           uuid REFERENCES stock_opnames(id),
  system_qty          numeric(14,3),                      -- khusus opname: stok sistem
  physical_qty        numeric(14,3),                      -- khusus opname: stok fisik
  move_date           date NOT NULL,
  notes               text,
  created_by          uuid NOT NULL REFERENCES users(id),
  device_id           text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  server_version      bigint NOT NULL DEFAULT nextval('sync_version_seq'),
  CHECK (
    (move_type IN ('purchase_in','harvest_in') AND qty_delta > 0) OR
    (move_type IN ('usage_out','sale_out')     AND qty_delta < 0) OR
    move_type = 'adjustment'
  )
);
CREATE INDEX idx_stock_item ON stock_movements (item_id, warehouse_id);
CREATE INDEX idx_stock_date ON stock_movements (move_date);

-- ---------------------------------------------------------------------
-- F. AUDIT & IDEMPOTENSI SINKRONISASI
-- ---------------------------------------------------------------------
-- Tidak disinkron ke HP; owner melihatnya lewat API (online).
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  entity       text NOT NULL,                -- nama tabel
  entity_id    uuid NOT NULL,
  action       text NOT NULL CHECK (action IN ('create','update','delete','restore','conflict_overwritten')),
  old_data     jsonb,
  new_data     jsonb,
  user_id      uuid REFERENCES users(id),
  device_id    text,
  client_op_id uuid,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX idx_audit_at     ON audit_logs (at DESC);

-- Mencegah operasi antrian yang terkirim 2x (mis. sinyal putus sesudah terkirim)
-- menghasilkan data ganda: server cek client_op_id dulu sebelum menerapkan.
CREATE TABLE sync_ops (
  client_op_id uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  device_id    text NOT NULL,
  entity       text NOT NULL,
  entity_id    uuid NOT NULL,
  op           text NOT NULL CHECK (op IN ('upsert','delete')),
  applied_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- G. TRIGGER: updated_at + server_version otomatis di setiap perubahan
-- ---------------------------------------------------------------------
CREATE FUNCTION touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at     := now();
  NEW.server_version := nextval('sync_version_seq');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','accounts','trx_categories','lands','suppliers','warehouses','items',
    'seasons','land_activities','cash_transactions','stock_opnames','stock_movements'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_touch BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION touch_row()', t);
    EXECUTE format('CREATE INDEX idx_%s_sv ON %I (server_version)', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- H. VIEW: saldo, stok, laba-rugi per lahan
-- ---------------------------------------------------------------------
CREATE VIEW v_account_balance AS
SELECT a.id AS account_id, a.name, a.type,
       a.opening_balance
         + COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount ELSE -t.amount END), 0) AS balance
FROM accounts a
LEFT JOIN cash_transactions t ON t.account_id = a.id AND t.deleted_at IS NULL
WHERE a.deleted_at IS NULL
GROUP BY a.id;

CREATE VIEW v_item_stock AS
SELECT i.id AS item_id, i.code, i.name, i.category, i.unit, i.min_stock,
       COALESCE(SUM(m.qty_delta), 0) AS stock,
       (i.min_stock > 0 AND COALESCE(SUM(m.qty_delta), 0) < i.min_stock) AS is_critical
FROM items i
LEFT JOIN stock_movements m ON m.item_id = i.id AND m.deleted_at IS NULL
WHERE i.deleted_at IS NULL
GROUP BY i.id;

-- Laba rugi sederhana per lahan (hanya transaksi normal, bukan transfer)
CREATE VIEW v_land_pnl AS
SELECT land_id,
       SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END) AS income,
       SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END) AS expense,
       SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) AS profit
FROM cash_transactions
WHERE kind = 'normal' AND deleted_at IS NULL AND land_id IS NOT NULL
GROUP BY land_id;

-- ---------------------------------------------------------------------
-- I. DATA AWAL (seed)
-- ---------------------------------------------------------------------
INSERT INTO accounts (name, type) VALUES ('Kas Tunai','cash'), ('Bank','bank');
INSERT INTO warehouses (name) VALUES ('Gudang Utama');

INSERT INTO trx_categories (name, direction, is_system, field_allowed) VALUES
  ('Penjualan Panen','in',true,false), ('Modal','in',true,false), ('Penjualan Alat','in',true,false),
  ('Bibit','out',true,false), ('Pupuk','out',true,false), ('Pestisida','out',true,false),
  ('Gaji','out',true,false), ('Transport','out',true,true), ('Sewa Alat','out',true,true),
  ('Sewa Lahan','out',true,false), ('Operasional','out',true,true);
