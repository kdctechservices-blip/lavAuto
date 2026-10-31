import { useCallback, useRef, useState } from "react"
import { apiFetch } from "@/lib/api"
import { confirmAction } from "@/lib/confirm"
import { enqueueMutation } from "@/lib/offline-sync"
import { toastError, toastSuccess } from "@/lib/toast"
import {
  performMutation,
  type MutationOutcome,
  type MutationRequest,
} from "@/lib/mutation"

/**
 * Une écriture, ses messages et son indicateur d'occupation.
 *
 * Remplace le bloc `setBusy` / `try` / `apiFetch` / `apiErrorMessage` /
 * `catch` / `finally` recopié dans toutes les pages. La décision vit dans
 * `mutation.ts`, vérifiée sans navigateur ; ce fichier n'en est que la forme
 * React.
 *
 *     const save = useMutation()
 *     await save.run({
 *       url: `/api/v1/services/${id}`,
 *       method: "PATCH",
 *       body: { is_active: false },
 *       success: "Prestation désactivée.",
 *       confirm: "Désactiver cette prestation ?",
 *       busyKey: id,
 *     })
 *
 * `run` ne lève jamais : il rend un résultat. L'appelant décide quoi en faire
 * — rafraîchir la liste, fermer une boîte de dialogue — en regardant `ok`.
 */
export interface MutationController {
  /** Message d'échec en cours, à afficher. */
  error: string | null
  /** Message de succès en cours, à afficher. */
  success: string | null
  /**
   * Ligne en cours de traitement. Vaut `""` pour une action de page, et
   * `null` quand rien n'est en cours.
   */
  busyKey: string | null
  /** Une écriture est-elle en vol ? */
  pending: boolean
  run: <T = unknown>(request: MutationRequest) => Promise<MutationOutcome<T>>
  /** Efface les deux messages, sans toucher à l'occupation. */
  reset: () => void
  /** Impose un message d'échec local (validation côté formulaire). */
  fail: (message: string) => void
  /** Impose un message de succès local. */
  succeed: (message: string) => void
}

export function useMutation(): MutationController {
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // Deux clics rapides sur deux lignes différentes : sans ce compteur, la
  // première réponse revenue relâcherait l'indicateur de la seconde.
  const inFlight = useRef(0)

  const run = useCallback(
    async <T,>(request: MutationRequest): Promise<MutationOutcome<T>> => {
      setError(null)
      setSuccess(null)
      setBusyKey(request.busyKey ?? "")
      inFlight.current += 1

      const outcome = await performMutation<T>(request, {
        fetch: apiFetch,
        // Le dialogue de confirmation de l'application, et non `window.confirm` :
        // il est accessible, il nomme l'action, et il ne s'ouvre que pour les
        // gestes que l'appelant a marqués comme irréversibles.
        confirm: (question) =>
          confirmAction({
            description: question,
            destructive: true,
            confirmLabel: "Continuer",
            cancelLabel: "Annuler",
          }),
        // Seules les écritures qui l'ont demandé explicitement atterrissent
        // dans la file ; voir le champ `offline` de MutationRequest.
        enqueue: enqueueMutation,
      })

      inFlight.current -= 1
      if (inFlight.current === 0) setBusyKey(null)

      // Une confirmation refusée n'est ni un succès ni une erreur : l'écran
      // doit rester exactement comme avant le clic.
      if (!outcome.cancelled) {
        if (outcome.error) {
          setError(outcome.error)
          // Le message reste aussi à l'écran, près de l'action ; le toast sert
          // à le voir même si la ligne a défilé ou si l'utilisateur a changé
          // d'onglet entre-temps.
          toastError("L’opération n’a pas abouti", outcome.error)
        }
        if (outcome.success) {
          setSuccess(outcome.success)
          toastSuccess(outcome.success)
        }
      }
      return outcome
    },
    [],
  )

  const reset = useCallback(() => {
    setError(null)
    setSuccess(null)
  }, [])

  const fail = useCallback((message: string) => {
    setSuccess(null)
    setError(message)
  }, [])

  const succeed = useCallback((message: string) => {
    setError(null)
    setSuccess(message)
  }, [])

  return {
    error,
    success,
    busyKey,
    pending: busyKey !== null,
    run,
    reset,
    fail,
    succeed,
  }
}
