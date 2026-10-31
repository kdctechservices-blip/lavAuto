import * as React from "react"
import { Link } from "react-router-dom"
import { Activity, AlertTriangle, Timer } from "lucide-react"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime } from "../api"
import { Panel, StatCard } from "../layout"
import type { ErrorGroup, MonitoringOverview, MonitoringRoute } from "../types"
import { MonitoringAlerts } from "./monitoring-alerts"

/**
 * La santé du service.
 *
 * Cet écran existe pour une raison précise : jusqu'ici, un incident se
 * découvrait par l'appel d'un client. Une erreur 500 vivait le temps d'une
 * ligne dans un terminal, puis disparaissait. Une route a pu rester cassée
 * une version entière sans que personne ne le sache.
 *
 * L'ordre de lecture est délibéré, du général au particulier :
 *
 *   1. **Le taux d'erreur** — le seul chiffre qui dit si ça va. Il est en
 *      premier et en grand.
 *   2. **La courbe** — depuis quand. Un taux de 2 % constant et un pic de 2 %
 *      survenu il y a dix minutes ne demandent pas la même réaction.
 *   3. **Les pannes regroupées** — quoi réparer, par ordre de fréquence.
 *   4. **Les routes lentes** — ce qui ne casse pas encore.
 *
 * Aucun chiffre n'est animé ici. Ailleurs un compteur qui monte fait plaisir ;
 * sur un écran de diagnostic, on lit une valeur, on ne la regarde pas arriver.
 */

const WINDOWS = [
  { hours: 1, label: "1 h" },
  { hours: 24, label: "24 h" },
  { hours: 24 * 7, label: "7 j" },
]

/** Durée dite en français : 1 240 ms se lit mieux en « 1,2 s ». */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`
}

/** Le ton d'un taux d'erreur. Les seuils sont des choix, pas des lois. */
export function rateTone(rate: number): "success" | "warning" | "danger" {
  if (rate >= 1) return "danger"
  if (rate >= 0.1) return "warning"
  return "success"
}

/**
 * Histogramme du trafic.
 *
 * Pas de bibliothèque de graphiques : des div dont la hauteur est
 * proportionnelle au volume suffisent, et c'est une dépendance de moins.
 * Les barres en erreur sont empilées sur les barres saines pour qu'un pic
 * rouge se repère sans lire la légende.
 */
function TrafficChart({ series }: { series: MonitoringOverview["series"] }) {
  if (series.length === 0) {
    return <p className="text-sm text-slate-400">Aucun trafic enregistré sur la période.</p>
  }
  const peak = Math.max(...series.map((b) => b.requests), 1)

  return (
    <div>
      <div className="flex h-32 items-end gap-px" role="img" aria-label="Trafic par tranche de cinq minutes">
        {series.map((bucket) => {
          const height = Math.max((bucket.requests / peak) * 100, 2)
          const errorShare = bucket.requests > 0 ? (bucket.errors / bucket.requests) * 100 : 0
          return (
            <div
              key={bucket.bucket_start}
              className="group relative flex-1 bg-white/5"
              style={{ height: `${height}%` }}
              title={`${formatDateTime(bucket.bucket_start)} · ${bucket.requests} requêtes · ${bucket.errors} erreurs · ${durationLabel(bucket.avg_duration_ms)} en moyenne`}
            >
              <div className="absolute inset-x-0 bottom-0 bg-sky-500/60" style={{ height: "100%" }} />
              {bucket.errors > 0 && (
                <div
                  className="absolute inset-x-0 top-0 bg-red-500"
                  style={{ height: `${Math.max(errorShare, 8)}%` }}
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>{formatDateTime(series[0].bucket_start)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-500/60" /> requêtes
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-red-500" /> erreurs
          </span>
        </span>
        <span>{formatDateTime(series[series.length - 1].bucket_start)}</span>
      </div>
    </div>
  )
}

function RouteList({
  routes,
  mode,
}: {
  routes: MonitoringRoute[]
  mode: "failing" | "slow"
}) {
  if (routes.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        {mode === "failing" ? "Aucune route en échec sur la période." : "Aucune route mesurée."}
      </p>
    )
  }
  return (
    <ul className="divide-y divide-white/5">
      {routes.map((route) => (
        <li key={`${route.method} ${route.route}`} className="flex items-center gap-3 py-2">
          <span className="w-14 shrink-0 text-xs font-semibold text-slate-400">{route.method}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">{route.route}</span>
          {mode === "failing" ? (
            <>
              <span className="w-20 text-right text-xs tabular-nums text-slate-400">
                {route.requests} appels
              </span>
              <span className="w-20 text-right text-sm font-semibold tabular-nums text-red-300">
                {route.errors} éch.
              </span>
            </>
          ) : (
            <>
              <span className="w-20 text-right text-xs tabular-nums text-slate-400">
                {route.requests} appels
              </span>
              <span className="w-20 text-right text-sm font-semibold tabular-nums text-amber-300">
                {durationLabel(route.avg_duration_ms ?? 0)}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

function ErrorGroupList({ groups }: { groups: ErrorGroup[] }) {
  if (groups.length === 0) {
    return <p className="text-sm text-slate-400">Aucune panne sur la période. C'est la bonne nouvelle.</p>
  }
  return (
    <ul className="divide-y divide-white/5">
      {groups.map((group) => (
        <li key={`${group.method}${group.route}${group.code}${group.message}`}>
          <Link
            to={`/console/surveillance/${group.latest_id}`}
            className="flex items-start gap-3 py-3 transition-opacity duration-150 hover:opacity-80"
          >
            <span className="mt-0.5 flex h-6 w-10 shrink-0 items-center justify-center rounded bg-red-500/15 text-xs font-semibold text-red-300 tabular-nums">
              {group.occurrences}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-100">{group.message}</span>
              <span className="mt-0.5 block truncate font-mono text-xs text-slate-500">
                {group.method} {group.route}
              </span>
            </span>
            <span className="shrink-0 text-right text-xs text-slate-500">
              <span className="block">{formatDateTime(group.last_seen)}</span>
              {group.organizations > 0 && (
                <span className="block">
                  {group.organizations} station{group.organizations > 1 ? "s" : ""}
                </span>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function ConsoleMonitoring() {
  const [hours, setHours] = React.useState(24)
  const [data, setData] = React.useState<MonitoringOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const payload = await consoleRequest<MonitoringOverview>(`/monitoring?hours=${hours}`)
        if (!cancelled) {
          setData(payload)
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
  }, [hours])

  return (
    <div className="space-y-5" aria-busy={loading} role="status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">Surveillance</h1>
          <p className="mt-0.5 text-sm text-slate-400">
            L'état du service, mesuré sur tout le trafic.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              type="button"
              onClick={() => setHours(w.hours)}
              className={`rounded px-3 py-1 text-xs font-medium transition-opacity duration-150 ${
                hours === w.hours ? "bg-white/15 text-white" : "text-slate-400 hover:opacity-80"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner />
        </div>
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Taux d'erreur"
              value={`${data.totals.error_rate.toLocaleString("fr-FR")} %`}
              hint={`${data.totals.server_errors} panne${data.totals.server_errors > 1 ? "s" : ""} sur ${data.totals.requests.toLocaleString("fr-FR")} requêtes`}
              tone={rateTone(data.totals.error_rate)}
            />
            <StatCard
              label="Trafic"
              value={data.totals.requests.toLocaleString("fr-FR")}
              hint={`dont ${data.totals.client_errors.toLocaleString("fr-FR")} refus (4xx)`}
            />
            <StatCard
              label="Latence moyenne"
              value={durationLabel(data.totals.avg_duration_ms)}
              hint={`pointe à ${durationLabel(data.totals.max_duration_ms)}`}
            />
            <StatCard
              label="Requêtes lentes"
              value={data.totals.slow.toLocaleString("fr-FR")}
              hint={`au-delà de ${durationLabel(data.thresholds.slow_request_ms)}`}
              tone={data.totals.slow > 0 ? "warning" : "default"}
            />
          </div>

          <MonitoringAlerts />

          <Panel
            title="Trafic et erreurs"
            description="Par tranches de cinq minutes. Un pic rouge se repère sans lire la légende."
          >
            <TrafficChart series={data.series} />
          </Panel>

          <Panel
            title="Pannes à réparer"
            description="Regroupées par route et par message : vingt fois la même panne est un problème, pas vingt."
          >
            <ErrorGroupList groups={data.error_groups} />
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Routes en échec"
              description="Ce qui casse, par nombre d'échecs."
            >
              <RouteList routes={data.failing_routes} mode="failing" />
            </Panel>
            <Panel
              title="Routes les plus lentes"
              description="Ce qui ne casse pas encore. Cinq appels minimum pour éviter les faux signaux."
            >
              <RouteList routes={data.slowest_routes} mode="slow" />
            </Panel>
          </div>

          <p className="flex items-start gap-2 text-xs text-slate-500">
            <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Les compteurs sont conservés {data.thresholds.metrics_retention_days} jours, le détail des
              incidents {data.thresholds.error_retention_days} jours. Les corps de requête enregistrés ne
              contiennent jamais de mot de passe, et les ouvrir laisse une trace au journal.
            </span>
          </p>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Timer className="h-4 w-4" /> Aucune mesure disponible.
        </p>
      )}
    </div>
  )
}

export default ConsoleMonitoring
