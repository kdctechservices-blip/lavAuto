/**
 * Où la base PostgreSQL embarquée (PGlite) range-t-elle ses données ?
 *
 * Ce module ne contient que la **décision**, pas l'ouverture de la base :
 * il est donc testable sans démarrer PostgreSQL, comme `action-blocking.ts`
 * ou `mutation.ts`.
 *
 * Le problème qu'il corrige : `new PGlite()` sans argument garde tout en
 * mémoire. Le serveur démarrait, fonctionnait, et perdait l'intégralité des
 * lavages, des encaissements et des sessions de caisse au premier
 * redémarrage — sans le moindre avertissement. Une base silencieusement
 * volatile est pire qu'une base absente : on lui confie de l'argent.
 *
 * Trois cas, dans cet ordre de priorité :
 *
 * 1. **Tests** — toujours en mémoire, quelle que soit la configuration.
 *    Deux fichiers de tests qui partageraient un dossier sur disque se
 *    contamineraient l'un l'autre. Ce cas n'est volontairement **pas**
 *    surchargeable : une variable d'environnement traînante ne doit pas
 *    pouvoir rendre la suite instable.
 *
 * 2. **`:memory:` demandé explicitement** — pour une démonstration jetable
 *    que l'on veut repartir vierge à chaque lancement. Le choix est alors
 *    assumé par écrit, plus subi.
 *
 * 3. **Tout le reste** — sur disque. C'est le défaut, parce que c'est ce
 *    qu'attend quiconque enregistre une recette.
 */

/** Valeur conventionnelle demandant explicitement une base volatile. */
export const MEMORY_SENTINEL = ":memory:"

/** Dossier utilisé quand rien n'est configuré. */
export const DEFAULT_DATA_DIR = ".data/pglite"

export interface PgliteLocationInput {
  /** `NODE_ENV` effectif. */
  nodeEnv: string
  /** Valeur brute de `PGLITE_DATA_DIR` ; chaîne vide si non renseignée. */
  dataDir?: string
}

export interface PgliteLocation {
  /** `memory` : rien n'est conservé. `disk` : les données survivent. */
  mode: "memory" | "disk"
  /** Chemin à passer à PGlite, ou `null` en mode mémoire. */
  dataDir: string | null
  /**
   * Vrai quand les données seront perdues au prochain arrêt. Redondant avec
   * `mode`, mais nommé du point de vue de celui qui lit un journal de
   * démarrage à 2 h du matin.
   */
  ephemeral: boolean
  /** Explication en clair, destinée aux journaux de démarrage. */
  reason: string
}

/**
 * Décide de l'emplacement de la base embarquée.
 *
 * Fonction pure : aucun accès au système de fichiers, aucune lecture de
 * `process.env`. Tout ce dont elle a besoin lui est passé.
 */
export function resolvePgliteLocation(input: PgliteLocationInput): PgliteLocation {
  const requested = (input.dataDir ?? "").trim()

  if (input.nodeEnv === "test") {
    return {
      mode: "memory",
      dataDir: null,
      ephemeral: true,
      reason: "Mode test : base en mémoire pour isoler les fichiers de tests les uns des autres.",
    }
  }

  if (requested === MEMORY_SENTINEL) {
    return {
      mode: "memory",
      dataDir: null,
      ephemeral: true,
      reason: `Base en mémoire demandée explicitement (PGLITE_DATA_DIR=${MEMORY_SENTINEL}). Les données seront perdues à l'arrêt.`,
    }
  }

  const dataDir = requested === "" ? DEFAULT_DATA_DIR : requested
  return {
    mode: "disk",
    dataDir,
    ephemeral: false,
    reason: `Base persistée dans « ${dataDir} ». Les données survivent au redémarrage.`,
  }
}

/**
 * Message à afficher au démarrage.
 *
 * Séparé de la décision pour pouvoir être vérifié : on veut la garantie
 * qu'une base volatile ne passe jamais inaperçue hors des tests.
 */
export function describePgliteLocation(location: PgliteLocation, nodeEnv: string): string {
  if (location.mode === "disk") return `[db] ${location.reason}`
  if (nodeEnv === "test") return `[db] ${location.reason}`
  return `[db] ATTENTION — ${location.reason}`
}
