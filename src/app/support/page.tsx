"use client"

import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { Clock, LifeBuoy, Lock, MessageCircle, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { apiErrorMessage, apiFetch } from "@/lib/api"

/**
 * Mes demandes d'assistance.
 *
 * WhatsApp reste le canal de discussion — c'est celui que les gérants
 * utilisent réellement, et le lien reste proposé. Cet écran lui donne une
 * mémoire : ce que j'ai demandé, quand, et ce qu'on m'a répondu. Une
 * conversation WhatsApp se perd dans le fil ; une demande ouverte ici reste
 * retrouvable des semaines plus tard.
 *
 * Le délai annoncé n'est pas décoratif : il dépend du forfait et l'éditeur se
 * mesure dessus.
 */

interface Sla {
  breached: boolean
  hours_remaining: number
  responded: boolean
}

interface SupportRequest {
  id: string
  subject: string
  category: string
  status: string
  commitment_hours: number
  response_due_at: string
  first_responded_at: string | null
  created_at: string
  message_count: number
  sla: Sla
}

interface SupportMessage {
  id: string
  author_operator_email: string | null
  author_name: string | null
  body: string
  created_at: string
}

interface SupportConfig {
  whatsapp_number: string
  whatsapp_display: string
  email: string
  commitment: {
    hours: number
    label: string
    plan_code: string | null
    guaranteed: boolean
    business_hours: string
  }
  categories: Array<{ code: string; label: string }>
}

/**
 * `apiFetch` rend une `Response` brute : sans cette enveloppe, un 400 serait
 * traité comme un succès et le message du serveur se perdrait.
 */
async function json<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options)
  if (!response.ok) throw new Error(await apiErrorMessage(response))
  return (await response.json()) as T
}

const STATUS_LABELS: Record<string, string> = {
  open: "En attente de réponse",
  answered: "Réponse reçue",
  resolved: "Résolu",
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString("fr-CI", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function SupportPage() {
  const [searchParams] = useSearchParams()
  const autoOpened = React.useRef(false)
  const [config, setConfig] = React.useState<SupportConfig | null>(null)
  const [requests, setRequests] = React.useState<SupportRequest[]>([])
  const [openId, setOpenId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<SupportMessage[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const [subject, setSubject] = React.useState("")
  const [category, setCategory] = React.useState("technique")
  const [description, setDescription] = React.useState("")
  const [reply, setReply] = React.useState("")

  const loadList = React.useCallback(async () => {
    const payload = await json<{ requests: SupportRequest[] }>("/api/v1/support/requests")
    setRequests(payload.requests)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const [c] = await Promise.all([
          json<SupportConfig>("/api/v1/support/config"),
          loadList(),
        ])
        if (!cancelled) {
          setConfig(c)
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
  }, [loadList])

  async function openThread(id: string) {
    setOpenId(id)
    setReply("")
    const payload = await json<{ messages: SupportMessage[] }>(
      `/api/v1/support/requests/${id}`,
    )
    setMessages(payload.messages)
  }

  React.useEffect(() => {
    const requested = searchParams.get("request")
    if (!requested || loading || autoOpened.current) return
    autoOpened.current = true
    void openThread(requested).catch((err) => {
      setError(err instanceof Error ? err.message : "Impossible d'ouvrir cette demande.")
    })
  }, [loading, searchParams])

  async function run(fn: () => Promise<string>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setNotice(await fn())
      await loadList()
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

  const whatsappUrl = config?.whatsapp_number
    ? `https://wa.me/${config.whatsapp_number}?text=${encodeURIComponent(
        "Bonjour WashPilot CI, j'ai besoin d'aide.",
      )}`
    : null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <LifeBuoy className="size-5" aria-hidden />
          Assistance
        </h1>
        {config && (
          <p className="text-sm text-muted-foreground">
            {config.commitment.guaranteed ? (
              <>
                Votre forfait vous garantit une première réponse sous{" "}
                <strong>{config.commitment.label}</strong>.
              </>
            ) : (
              <>
                Pendant l'essai, nous répondons sous {config.commitment.label} environ — sans
                engagement.
              </>
            )}{" "}
            {config.commitment.business_hours}.
          </p>
        )}
      </header>

      {notice && (
        <p role="status" className="rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </p>
      )}
      {error && (
        <p role="status" className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="rounded-xl border p-4">
        <h2 className="mb-3 text-sm font-semibold">Décrire un problème</h2>
        <div className="space-y-3">
          <div>
            <Label htmlFor="sujet">Sujet</Label>
            <Input
              id="sujet"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="En une phrase : qu'est-ce qui ne va pas ?"
              maxLength={140}
            />
          </div>
          <div>
            <Label htmlFor="categorie">Type de demande</Label>
            <select
              id="categorie"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {(config?.categories ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="description">Ce qui s'est passé</Label>
            <textarea
              id="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder="Ce que vous faisiez, ce que vous attendiez, ce qui est arrivé à la place."
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={busy || subject.trim().length < 5 || description.trim().length < 15}
              onClick={() =>
                run(async () => {
                  await json("/api/v1/support/requests", {
                    method: "POST",
                    body: JSON.stringify({
                      subject: subject.trim(),
                      category,
                      body: description.trim(),
                    }),
                  })
                  setSubject("")
                  setDescription("")
                  return "Demande enregistrée. Vous recevrez la réponse ici."
                })
              }
            >
              <Send className="mr-1.5 size-4" aria-hidden />
              Envoyer la demande
            </Button>
            {whatsappUrl && (
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-md bg-[#25D366] px-4 text-sm font-semibold text-white"
              >
                <MessageCircle className="size-4" aria-hidden />
                Urgent : WhatsApp
              </a>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Mes demandes</h2>
        {requests.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            Aucune demande pour le moment.
          </p>
        ) : (
          <ul className="space-y-2">
            {requests.map((request) => (
              <li key={request.id} className="rounded-xl border">
                <button
                  type="button"
                  onClick={() => (openId === request.id ? setOpenId(null) : void openThread(request.id))}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
                  aria-expanded={openId === request.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{request.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatWhen(request.created_at)} · {request.message_count} message(s)
                    </p>
                  </div>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">
                    {STATUS_LABELS[request.status] ?? request.status}
                  </span>
                  {request.status === "open" && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" aria-hidden />
                      réponse attendue {formatWhen(request.response_due_at)}
                    </span>
                  )}
                </button>

                {openId === request.id && (
                  <div className="space-y-3 border-t px-4 py-3">
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={`rounded-lg px-3 py-2 text-sm ${
                          message.author_operator_email
                            ? "bg-primary/5"
                            : "bg-muted"
                        }`}
                      >
                        <p className="mb-1 text-xs text-muted-foreground">
                          {message.author_operator_email ? "WashPilot CI" : message.author_name ?? "Vous"}
                          {" · "}
                          {formatWhen(message.created_at)}
                        </p>
                        <p className="whitespace-pre-wrap">{message.body}</p>
                      </div>
                    ))}

                    <div className="flex gap-2">
                      <Input
                        value={reply}
                        onChange={(event) => setReply(event.target.value)}
                        placeholder="Ajouter une précision…"
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || reply.trim().length < 2}
                        onClick={() =>
                          run(async () => {
                            await json(`/api/v1/support/requests/${request.id}/messages`, {
                              method: "POST",
                              body: JSON.stringify({ body: reply.trim() }),
                            })
                            setReply("")
                            await openThread(request.id)
                            return "Message envoyé."
                          })
                        }
                      >
                        Envoyer
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
        Vos demandes sont visibles par vous et par les responsables de votre station. Notre
        équipe n'accède jamais à votre application à votre place.
      </p>
    </div>
  )
}
