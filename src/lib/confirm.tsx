"use client"

import * as React from "react"
import { TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Confirmation des actions destructives — et **seulement** d'elles.
 *
 * `window.confirm` posait trois problèmes : il est laid et non stylable, il
 * bloque le fil principal, et surtout il n'était pas réservé aux gestes
 * irréversibles. L'utilisateur finissait par cliquer « OK » par réflexe.
 *
 * Ici la question est un vrai dialogue : le focus part sur « Annuler » (jamais
 * sur le bouton rouge), la touche Échap annule, et l'action précise est
 * rappelée en toutes lettres. Le reste des écritures — créer, modifier,
 * affecter — ne demande plus rien : elles sont réversibles, et un toast suffit
 * à confirmer qu'elles ont eu lieu.
 */

export interface ConfirmOptions {
  /** Titre court : « Annuler ce lavage ? ». */
  title?: string
  /** Ce qui va se passer, en une phrase. */
  description: string
  /** Conséquence irréversible éventuelle (« Le paiement déjà reçu doit être remboursé. ») */
  details?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmHandler = (options: ConfirmOptions) => Promise<boolean>

let handler: ConfirmHandler | null = null

/** Réservé au fournisseur : enregistre la fonction qui ouvre le dialogue. */
export function setConfirmHandler(next: ConfirmHandler | null) {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/**
 * Demande une confirmation. Utilisable depuis un composant **ou** depuis du
 * code non-React (`useMutation`, file hors ligne). Sans fournisseur monté —
 * test, page publique — on retombe proprement sur `window.confirm`.
 */
export async function confirmAction(options: ConfirmOptions | string): Promise<boolean> {
  const normalized: ConfirmOptions =
    typeof options === "string"
      ? { description: options, destructive: true, title: "Confirmer cette action ?" }
      : options
  if (handler) return handler(normalized)
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(
      [normalized.title, normalized.description, normalized.details]
        .filter(Boolean)
        .join("\n\n"),
    )
  }
  return false
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<{
    options: ConfirmOptions
    resolve: (value: boolean) => void
  } | null>(null)

  React.useEffect(() => {
    return setConfirmHandler(
      (options) =>
        new Promise<boolean>((resolve) => {
          setRequest({ options, resolve })
        }),
    )
  }, [])

  const settle = React.useCallback(
    (value: boolean) => {
      setRequest((current) => {
        current?.resolve(value)
        return null
      })
    },
    [],
  )

  const options = request?.options
  const destructive = options?.destructive ?? true
  const title = options?.title ?? (destructive ? "Confirmer cette action ?" : "Confirmer")

  return (
    <>
      {children}
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) settle(false)
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-describedby="confirm-description"
          className="sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={
                  destructive
                    ? "flex size-8 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                    : "flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary"
                }
              >
                <TriangleAlert className="size-4" />
              </span>
              {title}
            </DialogTitle>
            <DialogDescription id="confirm-description">
              {options?.description}
            </DialogDescription>
            {options?.details && (
              <p className="rounded-md bg-muted/60 p-2.5 text-xs text-muted-foreground">
                {options.details}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus={destructive}
              onClick={() => settle(false)}
              className="min-h-11 sm:min-h-8"
            >
              {options?.cancelLabel ?? "Annuler"}
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              autoFocus={!destructive}
              onClick={() => settle(true)}
              className="min-h-11 sm:min-h-8"
            >
              {options?.confirmLabel ?? (destructive ? "Continuer" : "Confirmer")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Version hook, pour les composants qui préfèrent la lisibilité. */
export function useConfirm() {
  return React.useCallback(
    (options: ConfirmOptions | string) => confirmAction(options),
    [],
  )
}
