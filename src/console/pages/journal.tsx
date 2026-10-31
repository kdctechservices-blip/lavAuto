import * as React from "react"
import { Link } from "react-router-dom"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime } from "../api"
import { Panel } from "../layout"
import { ACTION_LABELS, type ConsoleAuditEntry } from "../types"

/**
 * Le journal de l'éditeur.
 *
 * Répond à « qu'avons-nous fait », là où le journal d'une station répond à
 * « que s'est-il passé ici ». Les deux sont alimentés à chaque intervention :
 * le client doit voir chez lui qu'on a touché à son abonnement, sans quoi
 * l'administration serait une porte dérobée.
 *
 * Il survit à la purge d'une organisation — c'est alors la seule trace
 * qu'elle a existé, et qu'on l'a effacée.
 */
export function ConsoleJournal() {
  const [entries, setEntries] = React.useState<ConsoleAuditEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const payload = await consoleRequest<{ entries: ConsoleAuditEntry[] }>("/audit?limit=200")
        if (!cancelled) setEntries(payload.entries)
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
    <Panel title="Journal des interventions" description="Les 200 dernières actions de l'équipe sur le parc.">
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">Aucune intervention enregistrée.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
              <span className="w-36 shrink-0 text-xs tabular-nums text-slate-500">
                {formatDateTime(entry.created_at)}
              </span>
              <span className="text-sm text-white">{ACTION_LABELS[entry.action] ?? entry.action}</span>
              <span className="text-sm text-slate-400">
                {entry.organization_id ? (
                  <Link to={`/console/stations/${entry.organization_id}`} className="hover:underline">
                    {entry.organization_name}
                  </Link>
                ) : (
                  // Sans identifiant : l'organisation a été purgée depuis.
                  <span className="italic">{entry.organization_name ?? "—"}</span>
                )}
              </span>
              <span className="ml-auto text-xs text-slate-500">{entry.operator_email}</span>
              {typeof entry.metadata?.reason === "string" && (
                <p className="w-full text-xs italic text-slate-500">« {entry.metadata.reason} »</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export default ConsoleJournal
