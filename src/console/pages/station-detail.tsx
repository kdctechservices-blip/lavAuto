import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, KeyRound, ShieldOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDate, formatDateTime, formatFcfa } from "../api"
import { Panel, StatCard } from "../layout"
import { ConsoleWrite } from "../auth"
import { OrganizationDeletionFlow } from "../components/organization-deletion"
import { ROLE_LABELS, type ConsoleMember, type ConsoleOrganization, type ConsolePlan } from "../types"
import { StatusPill } from "./stations"

export function ConsoleStationDetail() {
  const { id = "" } = useParams()
  const [org, setOrg] = React.useState<ConsoleOrganization | null>(null)
  const [members, setMembers] = React.useState<ConsoleMember[]>([])
  const [plans, setPlans] = React.useState<ConsolePlan[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    // La fiche est enveloppée : { organization, members, subscription_history }.
    // Les membres sont rechargés à part pour leur forme enrichie (dernière
    // connexion, état du compte), que la fiche ne porte pas.
    const [o, m, p] = await Promise.all([
      consoleRequest<{ organization: ConsoleOrganization }>(`/organizations/${id}`),
      consoleRequest<{ members: ConsoleMember[] }>(`/organizations/${id}/members`),
      consoleRequest<{ plans: ConsolePlan[] }>("/plans"),
    ])
    setOrg(o.organization)
    setMembers(m.members)
    setPlans(p.plans)
  }, [id])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await reload()
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  /** Exécute une action puis recharge, en affichant l'issue une seule fois. */
  const run = React.useCallback(
    async (fn: () => Promise<string>) => {
      setError(null)
      setNotice(null)
      try {
        setNotice(await fn())
        await reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action impossible.")
      }
    },
    [reload],
  )

  const handleDeletionChanged = React.useCallback(
    (message: string) => {
      setError(null)
      setNotice(message)
      // La mutation a déjà réussi : une éventuelle erreur de rafraîchissement
      // ne doit pas être présentée comme un échec de la suppression.
      void reload().catch((err) => {
        setError(err instanceof Error ? err.message : "Actualisation impossible.")
      })
    },
    [reload],
  )

  if (loading) {
    return (
      <div className="flex justify-center py-20" role="status" aria-busy="true">
        <LoadingSpinner className="size-7" />
      </div>
    )
  }
  if (!org) {
    return <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">{error ?? "Station introuvable."}</p>
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/console/stations"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 transition-colors duration-150 hover:text-slate-200"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Toutes les stations
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-white">{org.name}</h1>
          <StatusPill row={org} />
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {org.owner_email ?? "sans propriétaire"}
          {org.owner_phone ? ` · ${org.owner_phone}` : ""} · créée le {formatDate(org.created_at)}
        </p>
      </div>

      {notice && (
        <p role="status" className="rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {org.pending_deletion && (
        <ConsoleWrite><OrganizationDeletionFlow organization={org} onChanged={handleDeletionChanged} /></ConsoleWrite>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Forfait" value={org.plan_name ?? "—"} hint={formatFcfa(org.plan_price_cents) + "/mois"} />
        <StatCard
          label="Échéance"
          value={formatDate(org.current_period_end)}
          hint={org.days_remaining !== null ? `${org.days_remaining} j restants` : undefined}
          tone={org.past_due ? "danger" : "default"}
        />
        <StatCard label="Équipe" value={org.member_count} hint={`${org.site_count} site(s)`} />
        <StatCard
          label="Dernier lavage"
          value={org.idle_days === null ? "Jamais" : `il y a ${org.idle_days} j`}
          hint={formatDate(org.last_wash_at)}
          tone={org.dormant ? "warning" : "default"}
        />
      </div>

      {!org.pending_deletion && (
        <ConsoleWrite>
          <div className="grid gap-4 lg:grid-cols-2">
            <ActivateCard plans={plans} id={id} onRun={run} />
            <TrialCard id={id} onRun={run} />
          </div>
        </ConsoleWrite>
      )}

      <Panel title="Comptes de la station" description="Dépanner un client sans jamais se connecter à sa place.">
        {members.length === 0 ? (
          <p className="text-sm text-slate-400">Aucun compte rattaché.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {members.map((member) => (
              <MemberRow key={member.id} member={member} organizationId={id} onRun={run} />
            ))}
          </ul>
        )}
      </Panel>

      {!org.pending_deletion && (
        <ConsoleWrite><OrganizationDeletionFlow organization={org} onChanged={handleDeletionChanged} /></ConsoleWrite>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ActivateCard({
  plans,
  id,
  onRun,
}: {
  plans: ConsolePlan[]
  id: string
  onRun: (fn: () => Promise<string>) => void
}) {
  const [planCode, setPlanCode] = React.useState("pro")
  const [months, setMonths] = React.useState(1)
  const [reference, setReference] = React.useState("")

  return (
    <Panel title="Activer un forfait" description="Après encaissement du mobile money, hors application.">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-slate-300">Forfait</Label>
          <select
            value={planCode}
            onChange={(e) => setPlanCode(e.target.value)}
            className="h-9 w-full rounded-md border border-white/15 bg-slate-900 px-3 text-sm text-white"
          >
            {plans
              .filter((plan) => plan.price_cents > 0)
              .map((plan) => (
                <option key={plan.code} value={plan.code}>
                  {plan.name} — {formatFcfa(plan.price_cents)}/mois
                </option>
              ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-slate-300">Durée (mois)</Label>
            <Input
              type="number"
              min={1}
              max={36}
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="border-white/15 bg-slate-900 text-white"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Référence du paiement</Label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="OM-123456"
              className="border-white/15 bg-slate-900 text-white placeholder:text-slate-600"
            />
          </div>
        </div>
        <Button
          type="button"
          className="w-full"
          onClick={() =>
            onRun(async () => {
              await consoleRequest(`/organizations/${id}/activate`, {
                method: "POST",
                body: JSON.stringify({
                  plan_code: planCode,
                  months,
                  payment_reference: reference.trim() || undefined,
                }),
              })
              return `Forfait ${planCode} activé pour ${months} mois.`
            })
          }
        >
          Activer
        </Button>
      </div>
    </Panel>
  )
}

function TrialCard({ id, onRun }: { id: string; onRun: (fn: () => Promise<string>) => void }) {
  const [days, setDays] = React.useState(7)
  const [reason, setReason] = React.useState("")
  const [suspendReason, setSuspendReason] = React.useState("")

  return (
    <Panel title="Gestes commerciaux" description="Prolonger un essai, ou suspendre un abonnement.">
      <div className="space-y-4">
        <div className="space-y-3">
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <div className="space-y-1.5">
              <Label className="text-slate-300">Jours</Label>
              <Input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="border-white/15 bg-slate-900 text-white"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-slate-300">Motif</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Mise en service retardée"
                className="border-white/15 bg-slate-900 text-white placeholder:text-slate-600"
              />
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={reason.trim().length < 3}
            onClick={() =>
              onRun(async () => {
                await consoleRequest(`/organizations/${id}/extend-trial`, {
                  method: "POST",
                  body: JSON.stringify({ days, reason: reason.trim() }),
                })
                return `Essai prolongé de ${days} jours.`
              })
            }
          >
            Prolonger l'essai
          </Button>
        </div>

        <div className="space-y-3 border-t border-white/10 pt-4">
          <div className="space-y-1.5">
            <Label className="text-slate-300">Motif de suspension</Label>
            <Input
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Impayé depuis 45 jours"
              className="border-white/15 bg-slate-900 text-white placeholder:text-slate-600"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={suspendReason.trim().length < 3}
            onClick={() =>
              onRun(async () => {
                await consoleRequest(`/organizations/${id}/suspend`, {
                  method: "POST",
                  body: JSON.stringify({ reason: suspendReason.trim() }),
                })
                return "Abonnement suspendu : la station passe en lecture seule."
              })
            }
          >
            <ShieldOff className="mr-1.5 size-4" aria-hidden />
            Suspendre l'abonnement
          </Button>
          <p className="text-xs text-slate-500">
            La suspension conserve la lecture et l'export. Les données restent intactes.
          </p>
        </div>
      </div>
    </Panel>
  )
}

function MemberRow({
  member,
  organizationId,
  onRun,
}: {
  member: ConsoleMember
  organizationId: string
  onRun: (fn: () => Promise<string>) => void
}) {
  // Deux états distincts, affichés distinctement. Les fusionner derrière un
  // seul mot « désactivé » laissait croire que les retirer de la station
  // bloquait leur compte — ce n'est pas le cas, et l'inverse non plus.
  const outOfStation = member.membership_status !== "active"
  const accountBlocked = member.user_status !== "active"
  const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          <Link to={`/console/comptes/${member.id}`} className="hover:underline">
            {name}
          </Link>
          <span className="ml-2 text-xs font-normal text-slate-500">
            {ROLE_LABELS[member.role] ?? member.role}
          </span>
          {outOfStation && (
            <span className="ml-2 text-xs font-normal text-amber-400">retiré de la station</span>
          )}
          {accountBlocked && (
            <span className="ml-2 text-xs font-normal text-red-400">compte bloqué partout</span>
          )}
        </p>
        <p className="truncate text-xs text-slate-400">
          {member.email} · vu {member.last_seen_at ? formatDateTime(member.last_seen_at) : "jamais"}
        </p>
      </div>
      <ConsoleWrite>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`role-${member.id}`}>
          Rôle de {name}
        </label>
        <select
          id={`role-${member.id}`}
          value={member.role}
          className="h-8 rounded-md border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200"
          onChange={(event) => {
            const role = event.target.value
            if (role === member.role) return
            const reason = window.prompt(
              `Pourquoi ce changement de rôle vers « ${ROLE_LABELS[role] ?? role} » ?`,
            )
            if (!reason || reason.trim().length < 5) return
            void onRun(async () => {
              const payload = await consoleRequest<{ permission_overrides_cleared: number }>(
                `/organizations/${organizationId}/members/${member.id}/role`,
                { method: "POST", body: JSON.stringify({ role, reason: reason.trim() }) },
              )
              const cleared = payload.permission_overrides_cleared
              return cleared > 0
                ? `Rôle modifié. ${cleared} permission(s) accordée(s) à titre exceptionnel ont été retirées.`
                : "Rôle modifié."
            })
          }}
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-slate-300"
          onClick={() =>
            onRun(async () => {
              const payload = await consoleRequest<{ reset_token: string }>(
                `/organizations/${organizationId}/members/${member.id}/reset-password`,
                { method: "POST" },
              )
              const link = `${window.location.origin}/auth/reset-password?token=${payload.reset_token}`
              try {
                await navigator.clipboard.writeText(link)
                return `Lien de réinitialisation copié (valable 1 h) pour ${member.email}.`
              } catch {
                return `Lien valable 1 h : ${link}`
              }
            })
          }
        >
          <KeyRound className="mr-1.5 size-3.5" aria-hidden />
          Mot de passe
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-slate-300"
          onClick={() => {
            const next = outOfStation ? "active" : "disabled"
            const reason = window.prompt(
              next === "disabled"
                ? "Motif du retrait de cette station ? (le compte reste utilisable ailleurs)"
                : "Motif de la réintégration ?",
            )
            if (!reason || reason.trim().length < 3) return
            void onRun(async () => {
              await consoleRequest(`/organizations/${organizationId}/members/${member.id}/status`, {
                method: "POST",
                body: JSON.stringify({ status: next, reason: reason.trim() }),
              })
              return next === "disabled"
                ? "Retiré de cette station. Le compte reste ouvert."
                : "Réintégré dans la station."
            })
          }}
        >
          {outOfStation ? "Réintégrer" : "Retirer"}
        </Button>
      </div>
      </ConsoleWrite>
    </li>
  )
}

export default ConsoleStationDetail
