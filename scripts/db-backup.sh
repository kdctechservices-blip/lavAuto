#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Sauvegarde de la base PostgreSQL de WashPilot CI.
#
#   ./scripts/db-backup.sh               # vers ./backups
#   BACKUP_DIR=/mnt/sauvegardes ./scripts/db-backup.sh
#
# À planifier une fois par jour, par exemple à 2 h du matin :
#   0 2 * * * cd /opt/washpilot && ./scripts/db-backup.sh >> /var/log/washpilot-backup.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date +%Y-%m-%d_%H%M)"

# DATABASE_URL peut venir de l'environnement ou du fichier .env
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- | tr -d '"'"'"'')"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Erreur : DATABASE_URL n'est pas défini (variable d'environnement ou .env)." >&2
  echo "En mode démonstration (base en mémoire), utilisez plutôt l'export JSON :" >&2
  echo "  Paramètres > Données et sauvegarde > Télécharger la sauvegarde" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "Erreur : pg_dump est introuvable. Installez le client PostgreSQL (postgresql-client)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TARGET="$BACKUP_DIR/washpilot-$STAMP.dump"

echo "[sauvegarde] Écriture de $TARGET…"
# Format « custom » : compressé et restaurable table par table avec pg_restore.
pg_dump --format=custom --no-owner --no-privileges --file "$TARGET" "$DATABASE_URL"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "[sauvegarde] Terminé ($SIZE)."

# Purge des sauvegardes trop anciennes.
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -name 'washpilot-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete |
    sed 's/^/[sauvegarde] Purge : /'
fi

echo "[sauvegarde] Pensez à copier $TARGET hors du serveur (stockage externe)."
