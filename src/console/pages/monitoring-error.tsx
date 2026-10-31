import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { AlertTriangle, ArrowLeft, ShieldCheck } from "lucide-react"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime } from "../api"
import { Panel } from "../layout"
import type { ErrorEvent } from "../types"
import { durationLabel } from "./monitoring"

/**
 * Le détail d'un incident.
 *
 * C'est le seul écran de la console qui montre ce qu'un utilisateur a
 * réellement saisi. Deux conséquences, affichées à l'opérateur et non
 * seulement écrites dans le code :
 *
 *   - les identifiants de connexion ont été retirés avant l'enregistrement,
 *     donc il n'y a rien à craindre ici ;
 *   - l'ouverture de cette page est inscrite au journal de la plateforme,
 *     comme toute lecture de données client par l'éditeur.
 *
 * Dire les deux sur la page est volontaire. Un garde-fou invisible finit par
 * être oublié, puis contourné de bonne foi.
 */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-100">{children}</dd>
    </div>
  )
}

export function ConsoleMonitoringError() {
  const { id } = useParams<{ id: string }>()
  const [event, setEvent] = React.useState<ErrorEvent | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!id) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const payload = await consoleRequest<{ event: ErrorEvent }>(`/monitoring/errors/${id}`)
        if (!cancelled) {
          setEvent(payload.event)
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
  }, [id])

  return (
    <div className="space-y-5" aria-busy={loading} role="status">
      <Link
        to="/console/surveillance"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition-opacity duration-150 hover:opacity-80"
      >
        <ArrowLeft className="h-4 w-4" /> Surveillance
      </Link>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !event ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner />
        </div>
      ) : event ? (
        <>
          <div>
            <p className="font-mono text-xs text-slate-500">
              {event.method} {event.route}
            </p>
            <h1 className="mt-1 text-lg font-semibold text-white">{event.message}</h1>
          </div>

          <Panel title="Contexte">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Survenu le">{formatDateTime(event.occurred_at)}</Field>
              <Field label="Statut">
                <span className={event.status >= 500 ? "text-red-300" : "text-amber-300"}>
                  {event.status} · {event.code}
                </span>
              </Field>
              <Field label="Durée">{durationLabel(event.duration_ms)}</Field>
              <Field label="Chemin appelé">
                <span className="break-all font-mono text-xs">{event.path}</span>
              </Field>
              <Field label="Station">
                {event.organization_id ? (
                  <Link
                    to={`/console/stations/${event.organization_id}`}
                    className="text-sky-300 transition-opacity duration-150 hover:opacity-80"
                  >
                    {event.organization_name ?? "Station"}
                  </Link>
                ) : (
                  <span className="text-slate-500">hors station</span>
                )}
              </Field>
              <Field label="Qui">
                {event.user_email ?? event.operator_email ?? (
                  <span className="text-slate-500">non identifié</span>
                )}
              </Field>
            </dl>
          </Panel>

          <Panel
            title="Corps de la requête"
            description="Ce que la personne a réellement envoyé — c'est ce qui permet de reproduire le bug."
          >
            {event.request_body ? (
              <pre className="overflow-x-auto rounded-lg bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-300">
                {JSON.stringify(event.request_body, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-slate-400">Aucun corps (requête de lecture).</p>
            )}
            <p className="mt-3 flex items-start gap-2 text-xs text-slate-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              <span>
                Les mots de passe et jetons sont remplacés par « [masqué] » avant enregistrement : ils
                n'existent nulle part dans cette base. En revanche, montants et noms de clients sont
                conservés tels quels, et votre consultation de cette page est inscrite au journal de la
                plateforme.
              </span>
            </p>
          </Panel>

          {event.stack && (
            <Panel title="Pile d'appel" description="Côté serveur. Jamais renvoyée au client.">
              <pre className="overflow-x-auto rounded-lg bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-400">
                {event.stack}
              </pre>
            </Panel>
          )}
        </>
      ) : null}
    </div>
  )
}

export default ConsoleMonitoringError
