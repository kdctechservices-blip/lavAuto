import * as React from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, ArrowRight, DoorOpen, Moon, Trash2 } from "lucide-react"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDate, formatFcfa } from "../api"
import { Panel, StatCard } from "../layout"
import type { ConsoleOrganization } from "../types"

/** Forme renvoyée par GET /console/metrics (voir server/admin.ts). */
interface Metrics {
  total: number
  trialing: number
  active: number
  expired: number
  cancelled: number
  past_due: number
  pending_requests: number
  mrr_cents: number
}

/** Une station qui a annoncé son départ (voir server/closure.ts). */
interface ClosureRequest {
  id: string
  organization_id: string
  organization_name: string
  reason: string
  requested_by_email: string
  created_at: string
}

export function ConsoleOverview() {
  const [metrics, setMetrics] = React.useState<Metrics | null>(null)
  const [organizations, setOrganizations] = React.useState<ConsoleOrganization[]>([])
  const [closures, setClosures] = React.useState<ClosureRequest[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [m, o, c] = await Promise.all([
          consoleRequest<Metrics>("/metrics"),
          consoleRequest<{ organizations: ConsoleOrganization[] }>("/organizations?limit=200"),
          consoleRequest<{ requests: ClosureRequest[] }>("/closure-requests"),
        ])
        if (cancelled) return
        setMetrics(m)
        setOrganizations(o.organizations)
        setClosures(c.requests)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Trois listes qui appellent une action, calculées côté client : la liste
  // complète tient en une requête, et un second aller-retour par filtre
  // n'apporterait rien à cette échelle.
  const pastDue = organizations.filter((o) => o.past_due)
  const expiringSoon = organizations
    .filter((o) => !o.past_due && o.status === "active" && (o.days_remaining ?? 99) <= 7)
    .sort((a, b) => (a.days_remaining ?? 0) - (b.days_remaining ?? 0))
  const dormant = organizations.filter((o) => o.dormant && !o.pending_deletion && o.status !== "expired")
  const pendingDeletion = organizations.filter((o) => o.pending_deletion)

  if (loading) {
    return (
      <div className="flex justify-center py-20" role="status" aria-busy="true">
        <LoadingSpinner className="size-7" />
      </div>
    )
  }
  if (error) {
    return <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Revenu mensuel"
          value={formatFcfa(metrics?.mrr_cents ?? 0)}
          hint="Somme des forfaits actifs"
          tone="success"
        />
        <StatCard label="Stations" value={metrics?.total ?? 0} hint={`${metrics?.active ?? 0} payantes`} />
        <StatCard label="En essai" value={metrics?.trialing ?? 0} hint={`${metrics?.expired ?? 0} essais échus`} />
        <StatCard
          label="Impayés"
          value={pastDue.length}
          hint="Échéance dépassée"
          tone={pastDue.length ? "danger" : "default"}
        />
      </div>

      {closures.length > 0 && (
        <Panel
          title="Départs annoncés"
          description="Ces gérants ont demandé à clôturer leur compte. Rien n'est coupé : c'est à vous de répondre."
        >
          <ul className="divide-y divide-white/5">
            {closures.map((request) => (
              <li key={request.id} className="flex items-start gap-3 px-2 py-3">
                <DoorOpen className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/console/stations/${request.organization_id}`}
                    className="text-sm font-medium text-white hover:underline"
                  >
                    {request.organization_name}
                  </Link>
                  <p className="text-xs text-slate-400">
                    {request.requested_by_email} · {formatDate(request.created_at)}
                  </p>
                  <p className="mt-1 text-sm italic text-slate-300">« {request.reason} »</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {pastDue.length > 0 && (
        <Panel
          title="Échéances dépassées"
          description="Ces stations restent actives : rien n'est coupé automatiquement."
        >
          <OrganizationList
            rows={pastDue}
            icon={AlertTriangle}
            tone="text-red-300"
            detail={(o) => `${o.days_past_due} j de retard · ${o.plan_name ?? "—"}`}
          />
        </Panel>
      )}

      {expiringSoon.length > 0 && (
        <Panel title="À renouveler bientôt" description="Moins de 7 jours avant l'échéance.">
          <OrganizationList
            rows={expiringSoon}
            tone="text-amber-300"
            detail={(o) => `${o.days_remaining} j · échéance ${formatDate(o.current_period_end)}`}
          />
        </Panel>
      )}

      {pendingDeletion.length > 0 && (
        <Panel title="Suppressions programmées" description="Encore annulables jusqu'à l'échéance.">
          <OrganizationList
            rows={pendingDeletion}
            icon={Trash2}
            tone="text-red-300"
            detail={(o) => `Effacement le ${formatDate(o.deletion_scheduled_for)}`}
          />
        </Panel>
      )}

      <Panel
        title="Stations dormantes"
        description="Aucun lavage enregistré depuis 14 jours ou plus — le signal le plus précoce d'un client qui décroche."
      >
        {dormant.length === 0 ? (
          <p className="text-sm text-slate-400">Aucune station dormante.</p>
        ) : (
          <OrganizationList
            rows={dormant}
            icon={Moon}
            tone="text-slate-300"
            detail={(o) =>
              o.idle_days === null ? "Jamais aucun lavage" : `${o.idle_days} j sans lavage`
            }
          />
        )}
      </Panel>
    </div>
  )
}

function OrganizationList({
  rows,
  detail,
  icon: Icon,
  tone,
}: {
  rows: ConsoleOrganization[]
  detail: (row: ConsoleOrganization) => string
  icon?: React.ComponentType<{ className?: string }>
  tone?: string
}) {
  return (
    <ul className="divide-y divide-white/5">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            to={`/console/stations/${row.id}`}
            className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors duration-150 hover:bg-white/5"
          >
            {Icon && <Icon className={`size-4 shrink-0 ${tone ?? ""}`} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-white">{row.name}</span>
              <span className="block truncate text-xs text-slate-400">
                {row.owner_email ?? "sans propriétaire"} · {detail(row)}
              </span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-slate-600" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default ConsoleOverview
