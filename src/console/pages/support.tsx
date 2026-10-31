import * as React from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, LifeBuoy } from "lucide-react"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime } from "../api"
import { StatCard } from "../layout"
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_STATUS_LABELS,
  type SupportRequest,
} from "../types"

/**
 * La file d'assistance.
 *
 * Triée par échéance d'engagement, pas par date d'arrivée : c'est là que
 * « assistance prioritaire » cesse d'être un argument commercial pour devenir
 * un ordre de traitement. Un Business arrivé à midi passe devant un Starter
 * arrivé le matin, sans aucune règle de tri particulière — l'échéance suffit.
 */

const FILTERS = [
  { value: "", label: "À traiter" },
  { value: "open", label: "En attente" },
  { value: "answered", label: "Répondu" },
  { value: "resolved", label: "Résolu" },
]

/** Le délai restant, dit en français plutôt qu'en nombre flottant. */
export function remainingLabel(request: SupportRequest): string {
  if (request.sla.responded) return "répondu"
  const hours = request.sla.hours_remaining
  if (hours < 0) {
    const late = Math.abs(hours)
    return late >= 10 ? `${Math.round(late / 10)} j de retard` : `${late.toFixed(1)} h de retard`
  }
  if (hours < 1) return `${Math.round(hours * 60)} min`
  return hours >= 10 ? `${Math.round(hours / 10)} j` : `${hours.toFixed(1)} h`
}

export function ConsoleSupport() {
  const [status, setStatus] = React.useState("")
  const [rows, setRows] = React.useState<SupportRequest[]>([])
  const [totals, setTotals] = React.useState({ open: 0, answered: 0, breached: 0 })
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const qs = status ? `?status=${status}` : ""
        const payload = await consoleRequest<{
          requests: SupportRequest[]
          totals: { open: number; answered: number; breached: number }
        }>(`/support${qs}`)
        if (!cancelled) {
          setRows(payload.requests)
          setTotals(payload.totals)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status])

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">Assistance</h1>
        <p className="text-sm text-slate-400">
          Classées par échéance d'engagement. Du lundi au vendredi, 8 h – 18 h.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="En attente de réponse" value={totals.open} />
        <StatCard label="Répondu, en cours" value={totals.answered} />
        <StatCard
          label="Engagement dépassé"
          value={totals.breached}
          hint={totals.breached > 0 ? "à traiter en premier" : "aucun retard"}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
              status === f.value
                ? "bg-slate-100 text-slate-900"
                : "bg-slate-900 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="status" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-20" role="status" aria-busy="true">
          <LoadingSpinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-12 text-center text-sm text-slate-400">
          <LifeBuoy className="mx-auto mb-3 size-6 text-slate-600" aria-hidden />
          Aucune demande dans cette vue.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((request) => {
            const late = request.sla.breached && !request.sla.responded
            return (
              <li key={request.id}>
                <Link
                  to={`/console/assistance/${request.id}`}
                  className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                    late
                      ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10"
                      : "border-slate-800 bg-slate-900/40 hover:bg-slate-900"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {request.subject}
                      {late && (
                        <AlertTriangle
                          className="ml-2 inline size-3.5 text-red-400"
                          aria-label="engagement dépassé"
                        />
                      )}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {request.organization_name} · {request.requester_name ?? request.requester_email}
                      {" · "}
                      {SUPPORT_CATEGORY_LABELS[request.category] ?? request.category}
                      {" · "}
                      {formatDateTime(request.created_at)}
                    </p>
                  </div>
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                    {request.plan_code ?? "essai"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {SUPPORT_STATUS_LABELS[request.status] ?? request.status}
                  </span>
                  <span
                    className={`w-24 text-right text-xs tabular-nums ${
                      late ? "text-red-300" : "text-slate-300"
                    }`}
                  >
                    {remainingLabel(request)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default ConsoleSupport
