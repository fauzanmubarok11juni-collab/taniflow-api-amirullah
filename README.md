\HEAD
# TaniFlow API — Tahap M1

Backend Node.js (Fastify + TypeScript) + PostgreSQL untuk aplikasi TaniFlow.
Isi: login/refresh/logout, kelola pengguna, sinkronisasi push/pull, log aktivitas, health check.

## Status verifikasi (baca dulu)

- Tes aturan peran, cakupan data tiap peran, validasi transfer, dan pembatas waktu (`test/rules.test.ts`): **11 dari 11 lulus** (dijalankan di lingkungan penulis).
- Pemeriksaan tipe TypeScript dilakukan dengan paket eksternal diganti stub: tidak ada kesalahan di kode sendiri di luar artefak stub.
- **Belum pernah dijalankan** terhadap PostgreSQL asli, dan `npm install` belum pernah dijalankan (tidak ada akses internet). Versi paket di `package.json` ditulis dari ingatan. `test/entities.test.ts` (butuh zod) belum dijalankan.
- Karena itu: jalankan langkah "Smoke test" di bawah sebelum menyambungkan aplikasi.

## Menjalankan di komputer (pengembangan)

Butuh Node 20+ dan Docker.

```bash
cp .env.example .env            # isi DB_PASSWORD dan JWT_SECRET (>= 32 karakter), samakan password di DATABASE_URL
docker compose up -d db         # PostgreSQL, hanya bisa diakses dari komputer ini
npm install
npm run migrate                 # menerapkan migrations/001 dan 002 (termasuk data awal akun kas & kategori)
$env:OWNER_SECRET="avii.0501"; npm run create-owner -- --username "amirullah" --name "Pak Amirullah"
npm run dev                     # http://localhost:3000/api/v1/health
npm test
```

## Smoke test (curl)

```bash
API=http://localhost:3000/api/v1
DEV=$(cat /proc/sys/kernel/random/uuid)

# 1. Login -> catat access_token
curl -s $API/auth/login -H 'content-type: application/json' \
  -d "{\"username\":\"amirullah\",\"secret\":\"pin-atau-sandi\",\"device_id\":\"$DEV\",\"device_name\":\"curl\"}"
TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzZDU2NDAzYi1mMTJhLTQ1YWQtYjQyNi04NjViN
WJiOTdiN2UiLCJkaWQiOiJkNjhmYjM0MS0yNDZiLTRkNjctODIyOS1iZTFiM2U0OWRmOTkiLCJpYXQiOjE3OTM
3NjE5MzQsImV4cCI6MTc5Mzc2MjgzNH0.0Br7VVSaJJI0fI-kDCohv5UB7g7S-DhDww6Aq_-t5VM
H=(-H "authorization: Bearer $TOKEN" -H "x-device-id: $DEV" -H 'content-type: application/json')

# 2. Tarik data awal (akun kas, kategori, gudang dari seed)
curl -s "$API/sync/pull?since=0" "${H[@]}"

# 3. Kirim satu barang; kirim lagi op yang sama -> status "duplicate"
OP=$(cat /proc/sys/kernel/random/uuid); ID=$(cat /proc/sys/kernel/random/uuid)
curl -s $API/sync/push "${H[@]}" -d "{\"device_id\":\"$DEV\",\"ops\":[{\"op_id\":\"$OP\",\"entity\":\"items\",\"entity_id\":\"$ID\",\"op\":\"upsert\",\"data\":{\"code\":\"UREA\",\"name\":\"Pupuk Urea\",\"category\":\"fertilizer\",\"unit\":\"sak\",\"min_stock\":\"10\"}}]}"

# 4. Log aktivitas (Owner)
curl -s "$API/audit-logs" "${H[@]}"
```

## Deploy ke VPS

```bash
cp .env.example .env            # isi API_DOMAIN (DNS harus sudah mengarah ke VPS), DB_PASSWORD, JWT_SECRET
docker compose up -d --build
docker compose run --rm api node dist/db/migrate.js
docker compose run --rm -e OWNER_SECRET='pin-atau-sandi' api node dist/scripts/create-owner.js --username amirullah --name "Pak Amirullah"
```

Caddy mengurus sertifikat HTTPS otomatis. Backup harian: `scripts/backup.sh` (pg_dump + enkripsi age + retensi 14 hari);
pasang lewat cron dan salin hasilnya ke penyimpanan di luar VPS. Uji pemulihan minimal sekali.

## Endpoint (prefix /api/v1)

| Metode | Path | Akses | Catatan |
|---|---|---|---|
| GET | /health | publik | |
| POST | /auth/login | publik | batas 10/menit per IP; 5 salah PIN = akun terkunci 15 menit |
| POST | /auth/refresh | refresh token | token dirotasi; pemakaian ulang token lama mencabut sesi perangkat |
| POST | /auth/logout | login | cabut sesi perangkat ini |
| POST | /auth/change-secret | login | sesi perangkat lain dicabut |
| POST | /sync/push | login | maks. 200 op; tiap op transaksi sendiri; idempoten lewat `op_id` |
| GET | /sync/pull?since=&limit= | login | data difilter per peran |
| GET, POST | /users | Owner | maks. 2 Owner |
| PATCH | /users/:id | Owner | tidak bisa menonaktifkan/menurunkan Owner terakhir |
| POST | /users/:id/reset-secret | Owner | mencabut semua sesinya |
| GET | /audit-logs | Owner | filter entitas, pengguna, tanggal; paginasi cursor |

Semua header `Authorization` + `X-Device-Id` (harus sama dengan `device_id` saat login).
Kesalahan berbentuk `{ "error": { "code", "message", "field" } }`.

Entitas yang diterima `/sync/push`: accounts, trx_categories, lands, suppliers, warehouses, items,
cash_transactions, stock_movements. Tahap 2 (musim tanam, aktivitas lahan, opname, foto nota) belum.

## Keputusan rancangan yang perlu diketahui

- **Satu rahasia per pengguna.** PIN dan kata sandi diperlakukan sama (kolom `password_hash`, argon2id).
  Kolom `pin_hash` di skema dibiarkan kosong.
- **Penulisan diserialkan** dengan satu kunci database. Ini menjamin urutan `server_version` sama dengan urutan commit
  sehingga pull tidak melewatkan data. Cukup untuk beberapa pengguna; akan jadi hambatan bila penggunanya ratusan.
- **Peran dibaca dari database di setiap permintaan**, jadi perubahan peran atau penonaktifan oleh Owner berlaku seketika
  (token yang sudah beredar tidak bisa dipakai lagi).
- **Konflik:** last-write-wins. Ditandai `conflict_overwritten` dan dicatat di `audit_logs` hanya bila penulis terakhirnya
  perangkat lain (supaya edit berulang dari HP yang sama tidak dianggap konflik).
- **Mandor** menerima daftar akun kas hanya berisi nama dan jenis (tanpa saldo awal dan nomor rekening) karena ia perlu
  memilih akun saat mencatat pengeluaran, tetapi tidak boleh melihat saldo.
- **Transfer kas** hanya bisa dibuat (dua baris sekaligus) atau dihapus (kedua sisi). Mengubah transfer = hapus lalu buat ulang.
- `permissions.json` harus identik dengan `assets/permissions.json` di aplikasi Flutter.
- Migrasi 002 menambah kolom penguncian akun dan membuat trigger tabel `users` tidak menaikkan versi saat login.

## Yang belum ada

- Sisi aplikasi untuk sinkronisasi (mesin push/pull, interceptor Dio untuk refresh token otomatis): tahap M4 di Flutter.
  Kontrak yang dipakai sama dengan dokumen Rancangan API.
- Dua permintaan refresh bersamaan dari satu HP bisa saling mencabut (aplikasi harus memakai satu antrian refresh).
- Foto nota, notifikasi, laporan sisi server, backup/restore lewat API: Tahap 2.




<!-- $dev = [guid]::NewGuid().ToString()
$body = @{ username='amirullah'; secret='avii.0501'; device_id=$dev; device_name='tes' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/auth/login -ContentType 'application/json' -Body $body -->
\
# taniflow-amirullah
\336278645dc42db876ba6ae4b52ea8b5ff1427e4
