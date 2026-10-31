import * as React from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDate, formatFcfa } from "../api"
import { STATUS_LABELS, type ConsoleOrganization } from "../types"

const FILTERS = [
  { value: "", label: "Toutes" },
  { value: "active", label: "Payantes" },
  { value: "trialing", label: "En essai" },
  { value: "expired", label: "Essais échus" },
  { value: "past_due", label: "Impayées" },
  { value: "cancelled", label: "Résiliées" },
]

export function ConsoleStations() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const notice = (location.state as { notice?: string } | null)?.notice
  const [rows, setRows] = React.useState<ConsoleOrganization[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState(params.get("q") ?? "")

  const status = params.get("status") ?? ""
  const query = params.get("q") ?? ""

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const qs = new URLSearchParams({ limit: "200" })
        if (query) qs.set("q", query)
        if (status) qs.set("status", status)
        const payload = await consoleRequest<{ organizations: ConsoleOrganization[] }>(
          `/organizations?${qs.toString()}`,
        )
        if (!cancelled) setRows(payload.organizations)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [query, status])

  // Recherche différée : relancer la requête à chaque frappe ferait clignoter
  // la liste et multiplierait les appels pour rien.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params)
      if (search) next.set("q", search)
      else next.delete("q")
      if (next.toString() !== params.toString()) setParams(next, { replace: true })
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  function setStatus(value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set("status", value)
    else next.delete("status")
    setParams(next, { replace: true })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nom de station ou e-mail du propriétaire"
            aria-label="Rechercher une station"
            className="border-white/15 bg-white/5 pl-9 text-white placeholder:text-slate-500"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatus(filter.value)}
              className={[
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                status === filter.value
                  ? "bg-white/15 text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
              ].join(" ")}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300"
        >
          {notice}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-16" role="status" aria-busy="true">
          <LoadingSpinner className="size-7" />
        </div>
      ) : error ? (
        <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-400">
          Aucune station ne correspond.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">Station</th>
                <th className="px-4 py-2.5 font-medium">Forfait</th>
                <th className="px-4 py-2.5 font-medium">État</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Échéance</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Équipe</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((row) => (
                <tr key={row.id} className="transition-colors duration-150 hover:bg-white/5">
                  <td className="px-4 py-3">
                    <Link to={`/console/stations/${row.id}`} className="block">
                      <span className="block font-medium text-white">{row.name}</span>
                      <span className="block truncate text-xs text-slate-400">
                        {row.owner_email ?? "sans propriétaire"}
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {row.plan_name ?? "—"}
                    {row.plan_price_cents > 0 && (
                      <span className="block text-xs text-slate-500">{formatFcfa(row.plan_price_cents)}/mois</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill row={row} />
                  </td>
                  <td className="hidden px-4 py-3 text-slate-400 md:table-cell">
                    {formatDate(row.current_period_end)}
                  </td>
                  <td className="hidden px-4 py-3 text-right tabular-nums text-slate-400 sm:table-cell">
                    {row.member_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function StatusPill({ row }: { row: ConsoleOrganization }) {
  if (row.pending_deletion) {
    return <Pill className="bg-red-500/15 text-red-300">Suppression en cours</Pill>
  }
  if (row.past_due) {
    return <Pill className="bg-red-500/15 text-red-300">Impayé · {row.days_past_due} j</Pill>
  }
  const styles: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-300",
    trialing: "bg-sky-500/15 text-sky-300",
    expired: "bg-amber-500/15 text-amber-300",
    cancelled: "bg-slate-500/20 text-slate-300",
    none: "bg-slate-500/20 text-slate-400",
  }
  return <Pill className={styles[row.status] ?? styles.none}>{STATUS_LABELS[row.status]}</Pill>
}

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${className ?? ""}`}>
      {children}
    </span>
  )
}

export default ConsoleStations
