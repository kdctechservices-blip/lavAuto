/**
 * Quelle base de données le serveur doit-il ouvrir ?
 *
 * La décision était prise en ligne, au milieu de `initDatabaseSchema`, mêlée
 * aux connexions et aux migrations : impossible à vérifier sans démarrer
 * PostgreSQL. Elle est ici, pure, pour une raison précise — c'est elle qui
 * empêche la suite de tests d'écrire dans la base réelle.
 *
 * Le scénario qui a motivé ce module : un développeur a `DATABASE_URL` dans
 * son `.env` (production, préproduction, ou simplement sa base locale qu'il
 * tient à garder). Il lance `npm test`. Les tests créent des stations, des
 * lavages, des encaissements — et les écrivent **chez lui**. Pire, ils
 * modifient le schéma et peuvent désactiver des comptes d'opérateur.
 *
 * Règle : en mode test, `DATABASE_URL` est ignorée. Toujours. La suite tourne
 * sur une base embarquée en mémoire, jetée avec le processus.
 */

export type DatabaseTarget = "embedded" | "external"

export interface DatabaseTargetInput {
  /** `NODE_ENV` effectif. */
  nodeEnv: string
  /** Valeur brute de `DATABASE_URL` ; chaîne vide si non renseignée. */
  databaseUrl?: string
}

export interface DatabaseTargetDecision {
  target: DatabaseTarget
  /** Vrai quand `DATABASE_URL` a été volontairement ignorée (mode test). */
  ignoredDatabaseUrl: boolean
}

/**
 * Choisit la base à ouvrir.
 *
 * - `test` → base embarquée, même si `DATABASE_URL` est renseignée ;
 * - `DATABASE_URL` renseignée → base externe ;
 * - sinon → base embarquée (développement), refusée en production ailleurs
 *   par `embeddedFallbackAllowed`.
 */
export function chooseDatabaseTarget(input: DatabaseTargetInput): DatabaseTargetDecision {
  const url = (input.databaseUrl ?? "").trim()
  if (input.nodeEnv === "test") {
    return { target: "embedded", ignoredDatabaseUrl: url !== "" }
  }
  return { target: url === "" ? "embedded" : "external", ignoredDatabaseUrl: false }
}

// ---------------------------------------------------------------------------
// Profil de la connexion : pooler ou connexion directe ?
// ---------------------------------------------------------------------------

/**
 * Nature du point d'entrée PostgreSQL.
 *
 * La distinction n'est pas cosmétique. La garde multi-station
 * (`server/db-rls.ts`) pose le rôle applicatif et l'organisation courante au
 * niveau **session** (`SET ROLE`, `set_config(..., false)`), parce que les
 * services ouvrent eux-mêmes des transactions. Un pooler en mode
 * **transaction** rend la connexion au serveur entre deux requêtes : le rôle
 * et la variable disparaissent, la requête suivante s'exécute hors portée —
 * et, pire, une requête d'une autre station peut hériter du contexte
 * précédent. Le mode session ou une connexion directe conservent l'état.
 */
export type ConnectionMode =
  | "local"
  | "direct"
  | "session-pooler"
  | "transaction-pooler"

export interface ConnectionProfile {
  mode: ConnectionMode
  /** Vrai si l'état de session (rôle, `app.current_org`) survit d'une requête à l'autre. */
  sessionStateSurvives: boolean
  /** Message à journaliser au démarrage, ou `null` si la configuration est saine. */
  warning: string | null
}

function parseHostPort(databaseUrl: string): { host: string; port: number | null } {
  try {
    const parsed = new URL(databaseUrl)
    const port = parsed.port ? Number(parsed.port) : null
    return { host: parsed.hostname.toLowerCase(), port: Number.isFinite(port) ? port : null }
  } catch {
    return { host: "", port: null }
  }
}

/**
 * Classe l'URL de connexion.
 *
 * Les motifs reconnus sont ceux des hébergeurs réellement utilisés par le
 * produit : Neon (`-pooler.` = PgBouncer en mode transaction) et Supabase
 * (`pooler.supabase.com:6543` en transaction, `:5432` en session). Tout le
 * reste est traité comme une connexion directe, ce qui est le cas par défaut
 * d'un PostgreSQL classique.
 */
export function describeConnection(databaseUrl: string): ConnectionProfile {
  const { host, port } = parseHostPort(databaseUrl)
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return { mode: "local", sessionStateSurvives: true, warning: null }
  }

  const isSupabasePooler = host === "pooler.supabase.com" || host.endsWith(".pooler.supabase.com")

  if (isSupabasePooler) {
    if (port === 6543) {
      return {
        mode: "transaction-pooler",
        sessionStateSurvives: false,
        warning:
          "DATABASE_URL vise le pooler Supabase en mode TRANSACTION (port 6543). " +
          "L'état de session (SET ROLE, app.current_org) n'y survit pas : l'isolation " +
          "multi-station devient aléatoire. Utilisez le pooler en mode session (port 5432) " +
          "ou la connexion directe.",
      }
    }
    return { mode: "session-pooler", sessionStateSurvives: true, warning: null }
  }

  // Neon : la variante « -pooler » est un PgBouncer en mode transaction.
  if (/-pooler\./.test(host) && host.endsWith("neon.tech")) {
    return {
      mode: "transaction-pooler",
      sessionStateSurvives: false,
      warning:
        "DATABASE_URL vise le pooler Neon (-pooler., mode transaction). " +
        "L'état de session (SET ROLE, app.current_org) n'y survit pas : l'isolation " +
        "multi-station devient aléatoire. Retirez « -pooler » de l'hôte pour utiliser " +
        "la connexion directe.",
    }
  }

  if (port === 6543) {
    return {
      mode: "transaction-pooler",
      sessionStateSurvives: false,
      warning:
        "DATABASE_URL utilise le port 6543, convention des poolers en mode transaction. " +
        "L'état de session (SET ROLE, app.current_org) n'y survit pas.",
    }
  }

  return { mode: "direct", sessionStateSurvives: true, warning: null }
}

/**
 * Configuration TLS du pool `pg`.
 *
 * Trois cas, et le troisième est celui qui a motivé cette fonction :
 *
 * 1. **Local** — pas de TLS, un PostgreSQL de développement n'en a pas ;
 * 2. **Autorité publique** — vérification stricte, sans réglage (Neon, RDS…) ;
 * 3. **Autorité privée** — Supabase signe ses connexions avec sa propre AC
 *    (`prod-ca-2021.crt`). Sans la fournir, `rejectUnauthorized: true` échoue
 *    sur « self-signed certificate in certificate chain ». On refuse
 *    explicitement de désactiver la vérification : la base transporte des
 *    montants encaissés, pas des brouillons.
 */
export function buildSslConfig(
  databaseUrl: string,
  caCertificate?: string | null,
): false | { rejectUnauthorized: boolean; ca?: string } {
  const { host } = parseHostPort(databaseUrl)
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return false
  }
  const ca = (caCertificate ?? "").trim()
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true }
}
