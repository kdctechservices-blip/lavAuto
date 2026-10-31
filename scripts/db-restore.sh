#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restauration d'une sauvegarde WashPilot CI.
#
#   ./scripts/db-restore.sh backups/washpilot-2026-10-20_0200.dump
#
# ATTENTION : la restauration écrase les données existantes de la base cible.
# Restaurez d'abord sur une base de test, vérifiez, puis seulement en production.
# ---------------------------------------------------------------------------
set -euo pipefail

DUMP_FILE="${1:-}"

if [[ -z "$DUMP_FILE" ]]; then
  echo "Usage : ./scripts/db-restore.sh <fichier.dump>" >&2
  exit 1
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "Erreur : fichier introuvable : $DUMP_FILE" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- | tr -d '"'"'"'')"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Erreur : DATABASE_URL n'est pas défini." >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "Erreur : pg_restore est introuvable. Installez le client PostgreSQL." >&2
  exit 1
fi

echo "Base cible : ${DATABASE_URL%%\?*}"
echo "Sauvegarde : $DUMP_FILE"
if [[ "${FORCE:-}" != "true" ]]; then
  read -r -p "Cette opération écrase les données existantes. Confirmer ? (oui/non) " answer
  [[ "$answer" == "oui" ]] || { echo "Annulé."; exit 1; }
fi

echo "[restauration] En cours…"
# --clean --if-exists : on repart d'un schéma propre sans erreur si des objets manquent.
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$DUMP_FILE"

echo "[restauration] Terminée. Vérifiez : connexion, tableau de bord, dernier lavage, caisse ouverte."
