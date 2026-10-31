/**
 * Cœur d'une écriture côté client.
 *
 * Le même bloc de vingt lignes était recopié vingt-huit fois dans seize
 * fichiers : poser l'indicateur d'occupation, effacer les messages, appeler
 * l'API, vérifier `response.ok`, extraire le message d'erreur, afficher un
 * succès, rattraper l'exception, relâcher l'indicateur. Recopier, c'est
 * accepter que chaque copie dérive — et plusieurs avaient déjà dérivé.
 *
 * La logique vit ici, **sans React**, pour être vérifiable sans navigateur.
 * `use-mutation.ts` n'en est que l'habillage en état de composant.
 *
 * Deux pièges du dépôt sont traités une fois pour toutes :
 *   • `apiFetch` rend une `Response` brute — un 400 passe pour un succès tant
 *     qu'on n'a pas regardé `ok` ;
 *   • le corps d'une réponse ne se lit **qu'une seule fois**, donc on ne peut
 *     pas demander le message d'erreur puis le JSON. Ici il est lu une fois,
 *     et c'est de cette lecture unique que sortent la donnée ou le message.
 */

export type MutationMethod = "POST" | "PATCH" | "PUT" | "DELETE"

export interface MutationRequest {
  /** Chemin d'API, par exemple `/api/v1/services/123`. */
  url: string
  /** Verbe HTTP. `POST` par défaut : c'est le cas le plus fréquent. */
  method?: MutationMethod
  /** Corps envoyé. Sérialisé en JSON ici, pour qu'aucun appelant ne l'oublie. */
  body?: unknown
  /** Message affiché si tout s'est bien passé. */
  success?: string
  /** Message affiché si le serveur n'explique pas lui-même l'échec. */
  failure?: string
  /**
   * Ligne concernée, quand l'action appartient à une ligne de tableau. Permet
   * de n'occuper que celle-là plutôt que la page entière.
   */
  busyKey?: string
  /** Question à poser avant d'agir. Rien n'est envoyé si la réponse est non. */
  confirm?: string
  /**
   * En-têtes supplémentaires. Sert surtout à `Idempotency-Key` : la même clé
   * rejouée ne doit créer qu'une écriture, convention tenue par le serveur
   * sur tout ce qui touche à l'argent.
   */
  headers?: Record<string, string>
  /**
   * Autorise cette écriture à être conservée puis renvoyée si le réseau
   * manque au moment du clic.
   *
   * Volontairement **explicite** : une opération ne part en différé que si
   * son appelant l'a prévu. Mettre tout le monde en file par défaut
   * enverrait un jour en différé une action qui n'y survivrait pas, et
   * personne ne saurait pourquoi.
   *
   * `label` est ce que le caissier lira dans sa liste d'attente — « Lavage
   * 2 500 F », pas « POST /api/v1/washes ».
   */
  offline?: { label: string }
}

export interface MutationOutcome<T = unknown> {
  ok: boolean
  /** Corps de la réponse, quand le serveur en renvoie un. */
  data: T | null
  error: string | null
  success: string | null
  /** L'utilisateur a refusé la confirmation : rien n'a été envoyé. */
  cancelled: boolean
  /**
   * L'opération est enregistrée sur l'appareil et partira au retour du
   * réseau. `ok` vaut alors `true` : du point de vue du caissier, la vente
   * est prise en compte — ce qui est exact, elle ne sera pas perdue.
   */
  queued?: boolean
}

/** Message de repli, quand ni le serveur ni l'appelant n'en proposent. */
export const DEFAULT_FAILURE = "L'opération a échoué. Réessayez."

export interface MutationDeps {
  fetch: (url: string, options: RequestInit) => Promise<Response>
  /**
   * Demande de confirmation. Rendre `true` quand il n'y a rien à demander.
   * Peut être asynchrone : le dialogue de confirmation de l'application rend
   * une promesse, et une écriture ne part qu'une fois la réponse connue.
   */
  confirm: (question: string) => boolean | Promise<boolean>
  /**
   * Met l'opération de côté pour un envoi différé. Rend `true` si elle a bien
   * été conservée. Absente en test ou quand le stockage est indisponible.
   */
  enqueue?: (request: MutationRequest) => Promise<boolean>
}

/**
 * Lit le corps **une seule fois** et en tire soit la donnée, soit le message.
 *
 * Un corps vide est légitime : un `204` n'a rien à dire. Un corps qui n'est
 * pas du JSON l'est aussi — on le rend alors tel quel, tronqué, plutôt que de
 * masquer une panne derrière un « API 500 » sans contenu.
 */
export async function readBody<T>(
  response: Response,
): Promise<{ data: T | null; message: string | null }> {
  let raw: string
  try {
    raw = await response.text()
  } catch {
    return { data: null, message: null }
  }
  if (!raw) return { data: null, message: null }

  try {
    const parsed = JSON.parse(raw) as
      | { error?: { message?: string }; message?: string }
      | T
    const asError = parsed as { error?: { message?: string }; message?: string }
    const message = asError?.error?.message ?? asError?.message ?? null
    return { data: parsed as T, message: typeof message === "string" ? message : null }
  } catch {
    // Pas du JSON : du texte brut, borné pour ne pas déverser une page HTML.
    return { data: null, message: raw.slice(0, 500) }
  }
}

/**
 * Exécute une écriture et rend un résultat exploitable.
 *
 * Ne lève jamais : une panne réseau est un résultat comme un autre, et obliger
 * chaque appelant à l'entourer d'un `try` est précisément ce qu'on supprime.
 */
export async function performMutation<T = unknown>(
  request: MutationRequest,
  deps: MutationDeps,
): Promise<MutationOutcome<T>> {
  const failure = request.failure ?? DEFAULT_FAILURE

  if (request.confirm && !(await deps.confirm(request.confirm))) {
    return { ok: false, data: null, error: null, success: null, cancelled: true }
  }

  let response: Response
  try {
    response = await deps.fetch(request.url, {
      method: request.method ?? "POST",
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })
  } catch (err) {
    // Réseau coupé. Si l'appelant a prévu le cas, l'opération est conservée
    // sur l'appareil et repartira seule : le caissier continue d'encaisser.
    if (request.offline && deps.enqueue && (await deps.enqueue(request))) {
      return {
        ok: true,
        data: null,
        error: null,
        success:
          "Enregistré sur cet appareil. L'envoi se fera automatiquement au retour du réseau.",
        cancelled: false,
        queued: true,
      }
    }
    // Sinon on le dit, sans jargon.
    return {
      ok: false,
      data: null,
      error: err instanceof Error && err.message ? err.message : failure,
      success: null,
      cancelled: false,
    }
  }

  const { data, message } = await readBody<T>(response)

  if (!response.ok) {
    return {
      ok: false,
      data: null,
      error: message ?? `${failure} (${response.status})`,
      success: null,
      cancelled: false,
    }
  }

  return {
    ok: true,
    data,
    error: null,
    success: request.success ?? null,
    cancelled: false,
  }
}
