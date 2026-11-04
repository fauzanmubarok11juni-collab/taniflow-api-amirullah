import { buildApp } from './app';
import { config } from './config';
import { pool } from './db/pool';

async function main() {
  const app = await buildApp();
  const stop = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
