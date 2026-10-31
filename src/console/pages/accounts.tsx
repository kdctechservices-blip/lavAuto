import * as React from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDate, formatDateTime } from "../api"
import type { ConsoleAccount } from "../types"

/**
 * Recherche de comptes.
 *
 * Le reste de la console est organisé par station. Cet écran existe parce que
 * le support reçoit l'appel d'une personne : « je n'arrive plus à me
 * connecter », sans nom de station et souvent sans savoir quel rôle elle
 * occupe. Chercher par adresse, par nom ou par numéro était jusqu'ici
 * impossible sans connaître d'abord la station.
 */
export function ConsoleAccounts() {
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = React.useState<ConsoleAccount[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState(params.get("q") ?? "")

  const query = params.get("q") ?? ""

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const qs = new URLSearchParams({ limit: "100" })
        if (query) qs.set("q", query)
        const payload = await consoleRequest<{ accounts: ConsoleAccount[] }>(
          `/accounts?${qs.toString()}`,
        )
        if (!cancelled) {
          setRows(payload.accounts)
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
  }, [query])

  // Recherche différée, comme sur la liste des stations.
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

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">Comptes</h1>
        <p className="text-sm text-slate-400">
          Retrouver une personne dans tout le parc, indépendamment de sa station.
        </p>
      </header>

      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Adresse e-mail, nom ou numéro de téléphone"
          className="border-slate-800 bg-slate-900 pl-9 text-slate-100"
          aria-label="Rechercher un compte"
        />
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
        <p className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-10 text-center text-sm text-slate-400">
          {query ? "Aucun compte ne correspond." : "Aucun compte enregistré."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Personne</th>
                <th className="px-4 py-3 font-medium">Stations</th>
                <th className="px-4 py-3 font-medium">Sessions</th>
                <th className="px-4 py-3 font-medium">Dernière activité</th>
                <th className="px-4 py-3 font-medium">Inscrit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((row) => {
                const name =
                  [row.first_name, row.last_name].filter(Boolean).join(" ") || "Sans nom"
                return (
                  <tr key={row.id} className="transition-colors hover:bg-slate-900/40">
                    <td className="px-4 py-3">
                      <Link
                        to={`/console/comptes/${row.id}`}
                        className="font-medium text-white hover:underline"
                      >
                        {name}
                      </Link>
                      {row.status !== "active" && (
                        <span className="ml-2 rounded px-1.5 py-0.5 text-xs text-red-300">
                          bloqué
                        </span>
                      )}
                      <p className="text-xs text-slate-400">{row.email}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{row.memberships}</td>
                    <td className="px-4 py-3 text-slate-300">{row.active_sessions}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {row.last_seen_at ? formatDateTime(row.last_seen_at) : "jamais"}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{formatDate(row.created_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default ConsoleAccounts
