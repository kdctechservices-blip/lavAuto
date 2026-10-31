import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, CheckCircle2, Lock, MessageCircle, RotateCcw, Stethoscope } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime } from "../api"
import { ConsoleWrite } from "../auth"
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_STATUS_LABELS,
  type MemberDiagnostic,
  type SupportMessage,
  type SupportRequest,
} from "../types"
import { remainingLabel } from "./support"

/**
 * Un fil d'assistance.
 *
 * Deux choses s'y font : répondre au client, et comprendre son problème sans
 * se connecter à sa place. Le bouton « Diagnostic » ouvre l'état technique du
 * compte qui a écrit — rôle, droits, abonnement, plafonds — et nomme la cause
 * du blocage quand il y en a une.
 */
export function ConsoleSupportDetail() {
  const { id = "" } = useParams()
  const [request, setRequest] = React.useState<SupportRequest | null>(null)
  const [messages, setMessages] = React.useState<SupportMessage[]>([])
  const [diagnostic, setDiagnostic] = React.useState<MemberDiagnostic | null>(null)
  const [draft, setDraft] = React.useState("")
  const [internal, setInternal] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    const payload = await consoleRequest<{ request: SupportRequest; messages: SupportMessage[] }>(
      `/support/${id}`,
    )
    setRequest(payload.request)
    setMessages(payload.messages)
  }, [id])

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

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
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

  if (!request) {
    return (
      <div className="space-y-4">
        <Link to="/console/assistance" className="inline-flex items-center text-sm text-slate-400">
          <ArrowLeft className="mr-1.5 size-4" aria-hidden />
          Assistance
        </Link>
        <p role="status" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error ?? "Cette demande est introuvable."}
        </p>
      </div>
    )
  }

  const late = request.sla.breached && !request.sla.responded

  return (
    <div className="space-y-6">
      <Link to="/console/assistance" className="inline-flex items-center text-sm text-slate-400">
        <ArrowLeft className="mr-1.5 size-4" aria-hidden />
        Assistance
      </Link>

      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-white">{request.subject}</h1>
        <p className="text-sm text-slate-400">
          <Link to={`/console/stations/${request.organization_id}`} className="hover:underline">
            {request.organization_name}
          </Link>
          {" · "}
          {request.requester_name ?? request.requester_email}
          {request.requester_phone ? ` · ${request.requester_phone}` : ""}
          {" · "}
          {SUPPORT_CATEGORY_LABELS[request.category] ?? request.category}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
            {SUPPORT_STATUS_LABELS[request.status] ?? request.status}
          </span>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
            forfait {request.plan_code ?? "essai"}
          </span>
          <span
            className={`rounded px-2 py-0.5 ${
              late ? "bg-red-500/15 text-red-300" : "bg-slate-800 text-slate-300"
            }`}
          >
            engagement {request.commitment_hours} h ouvrées · {remainingLabel(request)}
          </span>
        </div>
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

      <ul className="space-y-3">
        {messages.map((message) => {
          const fromOperator = Boolean(message.author_operator_email)
          return (
            <li
              key={message.id}
              className={`rounded-xl border px-4 py-3 ${
                message.internal
                  ? "border-amber-500/25 bg-amber-500/5"
                  : fromOperator
                    ? "border-sky-500/25 bg-sky-500/5"
                    : "border-slate-800 bg-slate-900/40"
              }`}
            >
              <p className="mb-1 flex items-center gap-2 text-xs text-slate-400">
                {message.internal && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
                    <Lock className="size-3" aria-hidden />
                    note interne, invisible du client
                  </span>
                )}
                <span>
                  {message.author_operator_email ?? message.author_name ?? "Le client"} ·{" "}
                  {formatDateTime(message.created_at)}
                </span>
              </p>
              <p className="whitespace-pre-wrap text-sm text-slate-100">{message.body}</p>
            </li>
          )
        })}
      </ul>

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <label className="sr-only" htmlFor="reponse">
          Votre message
        </label>
        <ConsoleWrite>
        <textarea
          id="reponse"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={4}
          placeholder={
            internal
              ? "Note interne — le client ne la verra jamais."
              : "Votre réponse au client…"
          }
          className="w-full resize-y rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
        />
        </ConsoleWrite>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ConsoleWrite>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={internal}
              onChange={(event) => setInternal(event.target.checked)}
              className="size-4 rounded border-slate-700 bg-slate-900"
            />
            Note interne
          </label>
          <Button
            type="button"
            size="sm"
            disabled={busy || draft.trim().length < 2}
            onClick={() =>
              run(async () => {
                const result = await consoleRequest<{
                  notification: { in_app: boolean; email_configured: boolean; email_delivered: boolean }
                }>(`/support/${id}/messages`, {
                  method: "POST",
                  body: JSON.stringify({ body: draft.trim(), internal }),
                })
                if (!internal) {
                  setNotice(
                    result.notification.email_delivered
                      ? "Réponse publiée. Le demandeur a été notifié dans l'application et par e-mail."
                      : result.notification.in_app
                        ? "Réponse publiée et notification ajoutée dans l'application. L'e-mail n'a pas été remis."
                        : "Réponse publiée. Aucun destinataire de notification n'est rattaché à cette demande.",
                  )
                }
                setDraft("")
              })
            }
          >
            <MessageCircle className="mr-1.5 size-3.5" aria-hidden />
            {internal ? "Enregistrer la note" : "Répondre au client"}
          </Button>
          {internal && (
            <p className="text-xs text-amber-300/80">
              Une note interne n'arrête pas le compteur d'engagement.
            </p>
          )}
          </ConsoleWrite>

          <div className="ml-auto flex gap-2">
            {request.created_by && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-slate-300"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setDiagnostic(
                      await consoleRequest<MemberDiagnostic>(
                        `/organizations/${request.organization_id}/members/${request.created_by}/diagnostic`,
                      ),
                    )
                  })
                }
              >
                <Stethoscope className="mr-1.5 size-3.5" aria-hidden />
                Diagnostic
              </Button>
            )}
            <ConsoleWrite>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={request.status === "resolved" ? "text-slate-300" : "text-emerald-300"}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await consoleRequest(`/support/${id}/status`, {
                    method: "POST",
                    body: JSON.stringify({
                      status: request.status === "resolved" ? "open" : "resolved",
                    }),
                  })
                })
              }
            >
              {request.status === "resolved" ? (
                <>
                  <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
                  Rouvrir
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-1.5 size-3.5" aria-hidden />
                  Marquer résolu
                </>
              )}
            </Button>
            </ConsoleWrite>
          </div>
        </div>
      </section>

      {diagnostic && <DiagnosticPanel data={diagnostic} />}
    </div>
  )
}

/**
 * L'état technique du compte qui a écrit.
 *
 * Aucun montant n'y figure : cet écran explique des blocages, il n'ouvre pas
 * la comptabilité du client. C'est la limite posée, et elle est tenue côté
 * serveur — le journal d'activité est réduit aux noms d'actions.
 */
function DiagnosticPanel({ data }: { data: MemberDiagnostic }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="border-b border-slate-800 px-5 py-4">
        <h2 className="text-sm font-semibold text-white">
          Diagnostic · {data.member.name ?? data.member.email}
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          {data.member.role_label} · {data.member.active_sessions} session(s) ouverte(s) · forfait{" "}
          {data.subscription.plan_name ?? "aucun"} ({data.subscription.status})
        </p>
      </div>

      <div className="space-y-5 px-5 py-4">
        {data.blockers.length === 0 ? (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            Rien ne bloque ce compte. Le problème est ailleurs que dans les droits ou
            l'abonnement.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Ce qui bloque
            </p>
            {data.blockers.map((blocker) => (
              <p
                key={blocker.cause}
                className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-amber-200"
              >
                {blocker.explanation}
              </p>
            ))}
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Plafonds du forfait
          </p>
          <ul className="grid gap-2 sm:grid-cols-3">
            {data.limits.map((limit) => (
              <li
                key={limit.key}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  limit.reached
                    ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
                    : "border-slate-800 text-slate-300"
                }`}
              >
                <span className="block text-xs text-slate-400">{limit.label}</span>
                {limit.used} / {limit.max ?? "illimité"}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Droits effectifs ({data.permissions.granted.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {data.permissions.granted.map((p) => (
              <span
                key={p.permission}
                title={p.source === "exception" ? "Accordé à cette personne" : "Hérité du rôle"}
                className={`rounded px-1.5 py-0.5 text-xs ${
                  p.source === "exception"
                    ? "bg-sky-500/15 text-sky-300"
                    : "bg-slate-800 text-slate-300"
                }`}
              >
                {p.label}
              </span>
            ))}
          </div>
          {data.permissions.overrides.length > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              En bleu : accordé à la personne par le propriétaire, pas au rôle.
            </p>
          )}
        </div>

        {data.recent_activity.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Dernières actions
            </p>
            <ul className="space-y-1 text-xs text-slate-400">
              {data.recent_activity.slice(0, 8).map((entry, index) => (
                <li key={index} className="flex justify-between gap-3">
                  <span className="truncate text-slate-300">{entry.action}</span>
                  <span className="shrink-0">{formatDateTime(entry.created_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

export default ConsoleSupportDetail
