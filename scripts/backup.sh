#!/usr/bin/env bash
# Backup harian terenkripsi (age). Jalankan dari folder proyek lewat cron, mis.:
#   0 2 * * * cd /opt/taniflow-api && AGE_RECIPIENT=age1xxxx ./scripts/backup.sh
# Salin hasilnya juga ke penyimpanan di luar server (mis. rclone) agar aman bila VPS rusak.
set -euo pipefail
: "${AGE_RECIPIENT:?isi AGE_RECIPIENT dengan public key age}"
DEST="${BACKUP_DIR:-/var/backups/taniflow}"
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T db pg_dump -U taniflow -Fc taniflow | age -r "$AGE_RECIPIENT" > "$DEST/taniflow-$STAMP.dump.age"
find "$DEST" -name 'taniflow-*.dump.age' -mtime +14 -delete
echo "Backup selesai: $DEST/taniflow-$STAMP.dump.age"
