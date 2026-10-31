import * as React from "react"
import { CloudOff, RefreshCw, Trash2, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { confirmAction } from "@/lib/confirm"
import type { QueuedMutation } from "@/lib/offline-queue"
import { discardQueued, retryQueued, subscribeToQueue, syncNow } from "@/lib/offline-sync"

/**
 * Ce que le caissier voit quand le réseau manque.
 *
 * Le principe qui gouverne cet écran : **ne jamais laisser croire qu'une
 * vente est perdue, ni qu'elle est arrivée alors qu'elle attend.** Entre les
 * deux mensonges, le second est le pire — un gérant qui croit sa recette
 * transmise ne la cherchera pas.
 *
 * Trois états, trois messages distincts :
 *
 *   • hors réseau, rien en attente → un simple bandeau d'information ;
 *   • des ventes en attente → leur nombre, et ce qui va leur arriver ;
 *   • des ventes refusées → elles sont nommées, avec la raison du serveur et
 *     deux boutons. Une ligne refusée ne disparaît jamais toute seule.
 *
 * Aucune animation de montant ici : les sommes affichées appartiennent à des
 * ventes réelles, et un chiffre qui bouge pendant qu'on le lit n'inspire
 * aucune confiance.
 */
export function OfflineIndicator() {
  const [online, setOnline] = React.useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  )
  const [items, setItems] = React.useState<QueuedMutation[]>([])
  const [syncing, setSyncing] = React.useState(false)

  React.useEffect(() => subscribeToQueue(setItems), [])

  React.useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener("online", goOnline)
    window.addEventListener("offline", goOffline)
    return () => {
      window.removeEventListener("online", goOnline)
      window.removeEventListener("offline", goOffline)
    }
  }, [])

  const pending = items.filter((item) => item.status === "pending")
  const failed = items.filter((item) => item.status === "failed")

  if (online && pending.length === 0 && failed.length === 0) return null

  async function sendNow() {
    setSyncing(true)
    try {
      await syncNow()
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 space-y-3 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30"
    >
      {!online && (
        <p className="flex items-center gap-2 font-medium">
          <CloudOff className="size-4 shrink-0" aria-hidden="true" />
          Pas de réseau. Vous pouvez continuer à enregistrer vos lavages.
        </p>
      )}

      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {pending.length === 1
              ? "1 enregistrement attend d’être envoyé."
              : `${pending.length} enregistrements attendent d’être envoyés.`}
          </span>
          {online && (
            <Button size="sm" variant="outline" onClick={sendNow} disabled={syncing} aria-busy={syncing}>
              <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
              {syncing ? "Envoi…" : "Envoyer maintenant"}
            </Button>
          )}
        </div>
      )}

      {failed.length > 0 && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
          <p className="flex items-center gap-2 font-medium text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {failed.length === 1
              ? "1 enregistrement a été refusé."
              : `${failed.length} enregistrements ont été refusés.`}
          </p>
          <ul className="space-y-2">
            {failed.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{entry.label}</span>
                <span className="text-muted-foreground">— {entry.lastError}</span>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => void retryQueued(entry.id)}>
                    Réessayer
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: "Abandonner cette opération ?",
                          description: `« ${entry.label} » sera retirée définitivement de cet appareil.`,
                          details:
                            "Le serveur ne l'a jamais reçue : elle ne pourra pas être retrouvée.",
                          confirmLabel: "Abandonner",
                        })
                      ) {
                        void discardQueued(entry.id)
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Abandonner</span>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
