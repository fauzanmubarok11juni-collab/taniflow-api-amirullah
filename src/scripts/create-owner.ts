import { pool } from '../db/pool';
import { hashSecret } from '../shared/crypto';

// Pemakaian: OWNER_SECRET='pin-atau-sandi' npm run create-owner -- --username amirullah --name "Pak Amirullah"
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const username = arg('username')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const secret = process.env.OWNER_SECRET ?? arg('secret');
  if (!username || !name || !secret) {
    console.error('Pemakaian: OWNER_SECRET=... npm run create-owner -- --username <user> --name "<Nama Lengkap>"');
    process.exit(1);
  }
  if (secret.length < 6) {
    console.error('PIN/kata sandi minimal 6 karakter.');
    process.exit(1);
  }
  const owners = await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND deleted_at IS NULL");
  if (owners.rows[0].n >= 2) {
    console.error('Sudah ada 2 akun Owner (batas maksimum).');
    process.exit(1);
  }
  await pool.query("INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, $2, 'owner', $3)", [
    username,
    name,
    await hashSecret(secret),
  ]);
  console.log(`Owner "${username}" dibuat.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
