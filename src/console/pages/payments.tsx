import * as React from "react"
import { Link } from "react-router-dom"
import { CheckCircle2, Clock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime, formatFcfa } from "../api"
import { Panel } from "../layout"
import { ConsoleWrite } from "../auth"
import type { ConsolePaymentIntent, ConsoleUpgradeRequest } from "../types"

/**
 * La file d'attente de l'encaissement.
 *
 * Elle est la source de vérité du workflow : le client déclare avoir payé,
 * l'opérateur vérifie sur son téléphone marchand, puis confirme ici. Une
 * déclaration n'est pas un paiement — c'est précisément pourquoi la
 * confirmation reste manuelle.
 */
export function ConsolePayments() {
  const [intents, setIntents] = React.useState<ConsolePaymentIntent[]>([])
  const [requests, setRequests] = React.useState<ConsoleUpgradeRequest[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    const [i, u] = await Promise.all([
      consoleRequest<{ intents: ConsolePaymentIntent[] }>("/payment-intents?declared=true"),
      consoleRequest<{ requests: ConsoleUpgradeRequest[] }>("/upgrade-requests?pending=true"),
    ])
    setIntents(i.intents)
    setRequests(u.requests)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await reload()
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  async function confirm(intent: ConsolePaymentIntent) {
    setBusy(intent.reference)
    setError(null)
    setNotice(null)
    try {
      await consoleRequest(`/payment-intents/${intent.reference}/confirm`, { method: "POST" })
      setNotice(`${intent.organization_name} : forfait ${intent.plan_name} activé pour ${intent.months} mois.`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirmation impossible.")
    } finally {
      setBusy(null)
    }
  }

  async function decline(request: ConsoleUpgradeRequest) {
    const reason = window.prompt("Motif du refus ? (visible par le client)")
    if (!reason || reason.trim().length < 3) return
    setBusy(request.id)
    try {
      await consoleRequest(`/upgrade-requests/${request.id}/decline`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refus impossible.")
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20" role="status" aria-busy="true">
        <LoadingSpinner className="size-7" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {notice && (
        <p role="status" className="rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <Panel
        title="Paiements déclarés"
        description="Vérifiez la référence sur votre téléphone marchand avant de confirmer."
      >
        {intents.length === 0 ? (
          <p className="text-sm text-slate-400">Aucun paiement en attente de vérification.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {intents.map((intent) => (
              <li key={intent.reference} className="flex flex-wrap items-center gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">
                    <Link
                      to={`/console/stations/${intent.organization_id}`}
                      className="hover:underline"
                    >
                      {intent.organization_name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-slate-500">{intent.reference}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {intent.plan_name} · {intent.months} mois · {formatFcfa(intent.amount_cents)}
                    {intent.transaction_reference && (
                      <>
                        {" · "}
                        <span className="font-mono text-slate-300">{intent.transaction_reference}</span>
                      </>
                    )}
                    {intent.paid_with ? ` · ${intent.paid_with}` : ""}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                    <Clock className="size-3" aria-hidden />
                    déclaré {formatDateTime(intent.declared_at)}
                  </p>
                </div>
                <ConsoleWrite>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy === intent.reference}
                    aria-busy={busy === intent.reference}
                    onClick={() => void confirm(intent)}
                  >
                    <CheckCircle2 className="mr-1.5 size-4" aria-hidden />
                    Confirmer
                  </Button>
                </ConsoleWrite>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Demandes d'activation" description="Clients ayant manifesté leur intention de souscrire.">
        {requests.length === 0 ? (
          <p className="text-sm text-slate-400">Aucune demande en attente.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {requests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white">
                    <Link to={`/console/stations/${request.organization_id}`} className="hover:underline">
                      {request.organization_name}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {request.plan_code ?? "forfait non précisé"} · {formatDateTime(request.requested_at)}
                    {request.contact_phone ? ` · ${request.contact_phone}` : ""}
                  </p>
                  {request.note && <p className="mt-1 text-xs italic text-slate-500">« {request.note} »</p>}
                </div>
                <ConsoleWrite>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-slate-300"
                    disabled={busy === request.id}
                    onClick={() => void decline(request)}
                  >
                    Décliner
                  </Button>
                </ConsoleWrite>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

export default ConsolePayments
