/**
 * File d'attente des enregistrements faits hors connexion.
 *
 * Le problème, concrètement : une station de lavage à Yopougon perd le
 * réseau. Le caissier a trois voitures devant lui. Soit il note sur un bout
 * de papier — et on revient au cahier que ce produit remplace —, soit
 * l'application accepte l'enregistrement et se charge de l'envoyer plus tard.
 *
 * Ce fichier contient la logique seule, sans navigateur ni base : c'est ce
 * qui permet de la tester. Le stockage réel (IndexedDB) et l'envoi réel
 * (`fetch`) sont injectés.
 *
 * ---------------------------------------------------------------------------
 * Les règles, et ce qu'elles évitent
 * ---------------------------------------------------------------------------
 *
 *   1. **La clé d'idempotence est tirée à l'enregistrement, jamais à
 *      l'envoi.** C'est la règle qui empêche de facturer deux fois : si
 *      l'envoi part, que le réseau coupe avant la réponse, et qu'on réessaie,
 *      le serveur reconnaît la clé et ne crée pas un second lavage.
 *
 *   2. **Premier entré, premier sorti, et un seul à la fois.** Deux envois en
 *      parallèle arriveraient dans le désordre ; l'ordre des opérations de
 *      caisse ne se discute pas.
 *
 *   3. **Une panne réseau arrête le défilement.** Sans cela, revenir en ligne
 *      une seconde ferait échouer trente envois d'affilée et épuiserait les
 *      tentatives alors que le problème n'a rien à voir avec leur contenu.
 *
 *   4. **Un refus du serveur ne bloque pas la file.** Une opération que le
 *      serveur rejette définitivement — caisse fermée entre-temps,
 *      prestation supprimée — est mise de côté et montrée au gérant. Les
 *      suivantes partent quand même. Une seule ligne fautive ne doit pas
 *      retenir la recette de la journée.
 *
 *   5. **Un enregistrement appartient à qui l'a fait.** Si le caissier du
 *      matin a laissé des lignes en attente et que celui du soir se
 *      connecte, elles ne partent pas sous le compte du second : le journal
 *      attribuerait l'encaissement à la mauvaise personne.
 */

/** Opérations autorisées à partir en différé.
 *
 * Liste volontairement courte. Pour y figurer, une route doit remplir deux
 * conditions :
 *
 *   • être protégée par une clé d'idempotence côté serveur ;
 *   • être **autonome** — ne dépendre d'aucun identifiant qu'une autre
 *     opération de la file viendrait tout juste de créer.
 *
 * C'est pourquoi l'ouverture d'une session de caisse n'y est pas : un lavage
 * en espèces enregistré ensuite désignerait une session qui n'existe pas
 * encore côté serveur, et serait rejeté à l'arrivée. La caisse s'ouvre en
 * ligne, le matin ; les ventes de la journée, elles, peuvent attendre.
 */
export const QUEUEABLE_ROUTES = ["/api/v1/washes", "/api/v1/expenses"] as const

export function isQueueable(url: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false
  // On compare le chemin seul : une chaîne de requête ne change pas la nature
  // de l'opération, et `?v=3` ne doit pas faire échouer la comparaison.
  const path = url.split("?")[0]
  return QUEUEABLE_ROUTES.some((route) => path === route)
}

export type QueuedStatus = "pending" | "failed"

export interface QueuedMutation {
  id: string
  url: string
  body: unknown
  /** Tirée une fois, à l'enregistrement. Rejouée telle quelle à chaque envoi. */
  idempotencyKey: string
  /** Identifiant du compte qui a saisi l'opération. */
  ownerKey: string
  /** Ce que le caissier lit dans la liste d'attente : « Lavage 2 500 F ». */
  label: string
  createdAt: number
  attempts: number
  status: QueuedStatus
  lastError: string | null
}

export interface QueueStorage {
  list(): Promise<QueuedMutation[]>
  put(item: QueuedMutation): Promise<void>
  remove(id: string): Promise<void>
}

export interface DrainResult {
  /** Envoyés et acceptés par le serveur. */
  sent: number
  /** Refusés définitivement : ils restent visibles, à traiter à la main. */
  failed: number
  /** Toujours en attente, le réseau ayant lâché en cours de route. */
  remaining: number
  /** Vrai si le défilement s'est arrêté faute de réseau. */
  stoppedOffline: boolean
}

/**
 * Une erreur de réseau se reconnaît à ceci : `fetch` **lève** au lieu de
 * répondre. Un serveur qui répond 500 n'est pas hors ligne — il est en
 * panne, ce qui est une autre histoire et se retente aussi, mais plus tard.
 */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError")
}

/**
 * Le serveur a-t-il tranché définitivement ?
 *
 * 4xx = « cette opération est invalide », la rejouer ne changera rien. Deux
 * exceptions qui méritent une nouvelle tentative :
 *   • 408 (délai dépassé) et 429 (trop de requêtes) sont temporaires ;
 *   • 401 l'est aussi — la session a pu expirer pendant la coupure, et
 *     l'opération redeviendra valide après reconnexion. La jeter ferait
 *     perdre une recette pour une raison qui n'a rien à voir avec elle.
 */
export function isPermanentRejection(status: number): boolean {
  if (status === 408 || status === 429 || status === 401) return false
  return status >= 400 && status < 500
}

export interface DrainDeps {
  storage: QueueStorage
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Compte actuellement connecté. Les lignes d'un autre compte sont ignorées. */
  ownerKey: string
}

/**
 * Vide la file, dans l'ordre, une opération à la fois.
 *
 * Ne lève jamais : appelée au retour du réseau, souvent sans personne devant
 * l'écran. Son résultat sert à informer, pas à faire échouer quoi que ce soit.
 */
export async function drainQueue(deps: DrainDeps): Promise<DrainResult> {
  const all = await deps.storage.list()
  const pending = all
    .filter((item) => item.status === "pending" && item.ownerKey === deps.ownerKey)
    .sort((a, b) => a.createdAt - b.createdAt)

  const result: DrainResult = { sent: 0, failed: 0, remaining: 0, stoppedOffline: false }

  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]

    let response: Response
    try {
      response = await deps.fetch(item.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // La même clé qu'à la saisie : c'est elle qui interdit le doublon.
          "Idempotency-Key": item.idempotencyKey,
        },
        body: JSON.stringify(item.body),
      })
    } catch (error) {
      if (isNetworkError(error)) {
        // Toujours hors ligne : on s'arrête là et on garde le reste intact.
        result.stoppedOffline = true
        result.remaining = pending.length - index
        return result
      }
      await deps.storage.put({
        ...item,
        attempts: item.attempts + 1,
        lastError: error instanceof Error ? error.message : "Envoi impossible.",
      })
      result.remaining += 1
      continue
    }

    if (response.ok) {
      await deps.storage.remove(item.id)
      result.sent += 1
      continue
    }

    if (isPermanentRejection(response.status)) {
      await deps.storage.put({
        ...item,
        status: "failed",
        attempts: item.attempts + 1,
        lastError: await describeRejection(response),
      })
      result.failed += 1
      continue
    }

    // 5xx ou refus temporaire : le serveur est mal en point. On garde la ligne
    // et on arrête — marteler un serveur en difficulté ne l'aide pas.
    await deps.storage.put({
      ...item,
      attempts: item.attempts + 1,
      lastError: `Le serveur n'a pas répondu correctement (${response.status}).`,
    })
    result.remaining = pending.length - index
    return result
  }

  return result
}

/** Extrait un message lisible du refus, sans jamais lever. */
async function describeRejection(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } }
    if (payload?.error?.message) return payload.error.message
  } catch {
    /* Corps absent ou illisible : le statut suffira. */
  }
  return `Refusé par le serveur (${response.status}).`
}

/** Construit une entrée de file. Isolée pour être testable sans navigateur. */
export function buildQueuedMutation(input: {
  url: string
  body: unknown
  label: string
  ownerKey: string
  id: string
  idempotencyKey: string
  now: number
}): QueuedMutation {
  return {
    id: input.id,
    url: input.url,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    ownerKey: input.ownerKey,
    label: input.label,
    createdAt: input.now,
    attempts: 0,
    status: "pending",
    lastError: null,
  }
}
