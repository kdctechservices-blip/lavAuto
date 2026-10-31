/**
 * Efface les comptes de station et leurs données.
 *
 * Ce que la commande supprime :
 *   • toutes les organisations (stations) et leurs utilisateurs, membres,
 *     sessions, jetons de réinitialisation ;
 *   • tout ce qui appartient à ces stations : sites, prestations, équipe,
 *     lavages, encaissements, caisse, stock, achats, abonnements, assistance,
 *     notifications, journal d'audit client ;
 *   • les comptes d'opérateurs de console **désactivés** (personne ne peut
 *     s'en servir, ils n'existent que comme reliquats).
 *
 * Ce que la commande conserve :
 *   • les opérateurs de console actifs — sinon le back-office se fermerait ;
 *   • la configuration de la plateforme : forfaits, catalogue de prestations,
 *     catégories de véhicules et de prestations ;
 *   • le journal de la console (`platform_audit_logs`) : la trace des actions
 *     de l'éditeur doit survivre à l'effacement des stations ;
 *   • la télémétrie technique (requêtes, erreurs), sans lien avec un compte.
 *
 * Arrêter le serveur avant de lancer la commande quand la base est la base
 * embarquée (PGlite) : un seul processus peut l'ouvrir à la fois.
 *
 * Usage :
 *   npm run db:purge-stations                 # liste ce qui serait supprimé
 *   npm run db:purge-stations -- --yes        # exécute
 *   npm run db:purge-stations -- --yes --force-production   # en production
 */
import "dotenv/config"

import { closeDatabase, getPool, initDatabaseSchema } from "../server/db.ts"
import { env } from "../server/env.ts"

/**
 * Tables qui ne contiennent aucun compte de station et qui doivent survivre :
 * configuration de la plateforme, comptes de la console, journaux de
 * l'éditeur, télémétrie.
 */
const KEEP_TABLES = new Set([
  "plans",
  "service_catalog",
  "service_categories",
  "vehicle_categories",
  "platform_operators",
  "platform_operator_sessions",
  "platform_audit_logs",
  "request_metrics",
  "error_events",
])

/**
 * Tables vides au premier déploiement mais rattachées à une station : elles
 * sont vidées comme les autres. La liste n'est pas écrite à la main — la
 * commande découvre les tables réelles pour ne pas oublier celles ajoutées
 * depuis (une table oubliée laisserait des lignes orphelines pointant vers des
 * organisations disparues).
 */

interface CountRow {
  n: number
}

async function count(pool: NonNullable<ReturnType<typeof getPool>>, table: string): Promise<number> {
  const q = await pool.query<CountRow>(`SELECT count(*)::int AS n FROM "${table}"`)
  return q.rows[0]?.n ?? 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const confirmed = args.includes("--yes")
  const forceProduction = args.includes("--force-production")

  if (env.NODE_ENV === "production" && !forceProduction) {
    console.error(
      "Refus : NODE_ENV=production. Cette commande efface toutes les stations.\n" +
        "Ajoutez --force-production si c'est réellement l'intention.",
    )
    process.exitCode = 1
    return
  }

  await initDatabaseSchema()
  const pool = getPool()
  if (!pool) {
    console.error("Base de données indisponible : vérifiez DATABASE_URL ou PGLITE_DATA_DIR.")
    process.exitCode = 1
    return
  }

  const all = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
  )
  const targets: string[] = []
  for (const { table_name } of all.rows) {
    if (KEEP_TABLES.has(table_name)) continue
    if ((await count(pool, table_name)) > 0) targets.push(table_name)
  }

  if (targets.length === 0) {
    console.info("[purge] Rien à supprimer : aucun compte de station en base.")
    return
  }

  // Aperçu avant toute écriture : l'ordre de grandeur doit être lisible dans
  // le terminal, pas seulement dans un rapport d'erreurs.
  console.info(`[purge] ${targets.length} table(s) concernée(s) :`)
  for (const table of targets) {
    console.info(`  ${String(await count(pool, table)).padStart(7)}  ${table}`)
  }

  if (!confirmed) {
    console.info("[purge] Simulation seule. Relancez avec --yes pour supprimer définitivement.")
    return
  }

  // Un seul TRUNCATE ... CASCADE : les contraintes de clé étrangère sont
  // résolues par PostgreSQL, sans ordre de suppression à maintenir à la main.
  const list = targets.map((table) => `"${table}"`).join(", ")
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)

  // Les comptes de console désactivés ne servent plus à personne : ils sont
  // des reliquats d'anciens opérateurs, pas un accès de secours.
  const disabled = await pool.query<{ email: string }>(
    "DELETE FROM platform_operators WHERE status <> 'active' RETURNING email",
  )
  const remainingOperators = await count(pool, "platform_operators")

  console.info("[purge] Terminé.")
  for (const table of targets) {
    const left = await count(pool, table)
    if (left !== 0) console.warn(`[purge] ATTENTION : ${left} ligne(s) restante(s) dans ${table}.`)
  }
  if (disabled.rowCount) {
    console.info(`[purge] ${disabled.rowCount} opérateur(s) de console désactivé(s) supprimé(s).`)
  }
  console.info(`[purge] ${remainingOperators} opérateur(s) de console actif(s) conservé(s).`)
  console.info("[purge] Forfaits, catalogue et catégories conservés.")
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error("Échec :", message)
    if (/lock|already|EACCES|EPERM/i.test(message)) {
      console.error("La base est peut-être encore ouverte : arrêtez le serveur puis relancez.")
    }
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDatabase().catch(() => {})
  })
