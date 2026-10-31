import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, LogOut, ShieldOff, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDate, formatDateTime } from "../api"
import { Panel } from "../layout"
import { ConsoleWrite } from "../auth"
import { ROLE_LABELS, type ConsoleAccountDetail } from "../types"

/**
 * Fiche d'une personne.
 *
 * Ce que cet écran rend possible et que la vue par station ne permettait pas :
 * voir d'un coup toutes les stations où quelqu'un travaille. C'est la seule
 * façon de répondre honnêtement à « bloquez ce compte » — il faut savoir qui
 * d'autre en dépend avant de couper.
 */
export function ConsoleAccountDetailPage() {
  const { userId = "" } = useParams()
  const [data, setData] = React.useState<ConsoleAccountDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    const payload = await consoleRequest<ConsoleAccountDetail>(`/accounts/${userId}`)
    setData(payload)
  }, [userId])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        await load()
        if (!cancelled) setError(null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  async function run(fn: () => Promise<string>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setNotice(await fn())
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action impossible.")
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20" role="status" aria-busy="true">
        <LoadingSpinner />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link to="/console/comptes" className="inline-flex items-center text-sm text-slate-400">
          <ArrowLeft className="mr-1.5 size-4" aria-hidden />
          Comptes
        </Link>
        <p role="status" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error ?? "Ce compte est introuvable."}
        </p>
      </div>
    )
  }

  const { account, memberships, sessions, sole_owner_of: soleOwnerOf } = data
  const name = [account.first_name, account.last_name].filter(Boolean).join(" ") || "Sans nom"
  const blocked = account.status !== "active"

  return (
    <div className="space-y-6">
      <Link to="/console/comptes" className="inline-flex items-center text-sm text-slate-400">
        <ArrowLeft className="mr-1.5 size-4" aria-hidden />
        Comptes
      </Link>

      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">
          {name}
          {blocked && (
            <span className="ml-3 rounded bg-red-500/15 px-2 py-0.5 text-xs font-normal text-red-300">
              compte bloqué
            </span>
          )}
        </h1>
        <p className="text-sm text-slate-400">
          {account.email}
          {account.phone ? ` · ${account.phone}` : ""} · inscrit le {formatDate(account.created_at)}
        </p>
      </header>

      {notice && (
        <p role="status" className="rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="status" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {soleOwnerOf.length > 0 && (
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          Seul propriétaire actif de {soleOwnerOf.map((s) => s.name).join(", ")}. Bloquer ce compte
          laisserait {soleOwnerOf.length > 1 ? "ces stations" : "cette station"} sans
          administrateur : nommez d'abord un autre propriétaire.
        </p>
      )}

      <Panel title="Stations" description={`${memberships.length} appartenance(s)`}>
        {memberships.length === 0 ? (
          <p className="py-6 text-sm text-slate-400">
            Ce compte n'appartient à aucune station. Il peut se connecter mais ne verra rien.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {memberships.map((m) => (
              <li key={m.organization_id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    <Link to={`/console/stations/${m.organization_id}`} className="hover:underline">
                      {m.organization_name}
                    </Link>
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {ROLE_LABELS[m.role] ?? m.role}
                    </span>
                    {m.status !== "active" && (
                      <span className="ml-2 text-xs font-normal text-amber-400">
                        retiré{m.disabled_at ? ` le ${formatDate(m.disabled_at)}` : ""}
                      </span>
                    )}
                    {m.deletion_requested_at && (
                      <span className="ml-2 text-xs font-normal text-red-400">
                        station en suppression
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-400">
                    depuis le {formatDate(m.created_at)}
                    {m.permission_overrides > 0 &&
                      ` · ${m.permission_overrides} permission(s) accordée(s) à titre exceptionnel`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Sessions ouvertes"
        description={`${account.active_sessions} appareil(s) connecté(s)`}
      >
        {sessions.length === 0 ? (
          <p className="py-6 text-sm text-slate-400">Aucune session en cours.</p>
        ) : (
          <ul className="divide-y divide-slate-800 text-sm">
            {sessions.map((s, index) => (
              <li key={index} className="flex justify-between py-2 text-slate-300">
                <span>
                  Active depuis le {formatDate(s.created_at)}
                  {s.last_used_at ? ` · vue ${formatDateTime(s.last_used_at)}` : ""}
                </span>
                <span className="text-slate-500">expire le {formatDate(s.expires_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ConsoleWrite>
      <section className="rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-sm font-semibold text-white">Interventions sur le compte</h2>
          <p className="mt-1 text-xs text-slate-400">
            Ces gestes portent sur la personne, partout. Pour la retirer d'une seule station,
            passez par la fiche de cette station.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 px-5 py-4">
          <Button
            type="button"
            variant="ghost"
            className="text-slate-300"
            disabled={busy || account.active_sessions === 0}
            onClick={() => {
              const reason = window.prompt("Motif de la déconnexion de tous les appareils ?")
              if (!reason || reason.trim().length < 5) return
              void run(async () => {
                const payload = await consoleRequest<{ revoked: number }>(
                  `/accounts/${userId}/revoke-sessions`,
                  { method: "POST", body: JSON.stringify({ reason: reason.trim() }) },
                )
                return `${payload.revoked} session(s) fermée(s). La personne peut se reconnecter avec son mot de passe.`
              })
            }}
          >
            <LogOut className="mr-1.5 size-4" aria-hidden />
            Déconnecter partout
          </Button>

          <Button
            type="button"
            variant="ghost"
            className={blocked ? "text-emerald-300" : "text-red-300"}
            disabled={busy || (!blocked && soleOwnerOf.length > 0)}
            onClick={() => {
              const next = blocked ? "active" : "inactive"
              const reason = window.prompt(
                next === "inactive"
                  ? "Motif du blocage ? La personne ne pourra plus se connecter nulle part."
                  : "Motif du déblocage ?",
              )
              if (!reason || reason.trim().length < 5) return
              void run(async () => {
                await consoleRequest(`/accounts/${userId}/status`, {
                  method: "POST",
                  body: JSON.stringify({ status: next, reason: reason.trim() }),
                })
                return next === "inactive"
                  ? "Compte bloqué et sessions fermées."
                  : "Compte débloqué."
              })
            }}
          >
            {blocked ? (
              <ShieldCheck className="mr-1.5 size-4" aria-hidden />
            ) : (
              <ShieldOff className="mr-1.5 size-4" aria-hidden />
            )}
            {blocked ? "Débloquer le compte" : "Bloquer le compte partout"}
          </Button>
        </div>
      </section>
      </ConsoleWrite>
    </div>
  )
}

export default ConsoleAccountDetailPage
