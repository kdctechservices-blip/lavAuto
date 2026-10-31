import * as React from "react"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, formatDateTime } from "../api"
import { Panel } from "../layout"
import { ConsoleWrite } from "../auth"

/**
 * Les tarifs, modifiables depuis la console.
 *
 * Les prix de WashPilot sont des hypothèses commerciales : tant qu'ils
 * n'étaient modifiables qu'en base de données, ils n'étaient pas vraiment
 * modifiables. Cette page les ramène à ce qu'ils sont — une décision, pas
 * une constante.
 *
 * Deux précautions tenues ici plutôt que laissées au serveur seul :
 *
 *   • le montant s'écrit en francs, comme on en parle, jamais en centimes ;
 *   • l'écran rappelle que le changement ne touche aucun abonnement en
 *     cours. Un opérateur qui l'ignore hésiterait à corriger un prix de peur
 *     de refacturer ses clients.
 */

interface ConsolePlan {
  code: string
  name: string
  price_cents: number
  price_overridden_at: string | null
}

const HINTS: Record<string, string> = {
  starter: "Lavages, catalogue, recettes, dépenses simples, rapport quotidien.",
  pro: "Starter + équipes, caisse, marges, exports, traçabilité, stock.",
  business: "Pro + multi-sites, vue consolidée, permissions avancées.",
}

export function ConsolePlans() {
  const [plans, setPlans] = React.useState<ConsolePlan[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [price, setPrice] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)

  const [refreshKey, setRefreshKey] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const payload = await consoleRequest<{ plans: ConsolePlan[] }>("/plans")
        if (cancelled) return
        setPlans(payload.plans)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  function startEditing(plan: ConsolePlan) {
    setEditing(plan.code)
    setPrice(String(Math.round(plan.price_cents / 100)))
    setReason("")
    setFormError(null)
    setNotice(null)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!editing) return
    setSaving(true)
    setFormError(null)
    try {
      const result = await consoleRequest<{ price_xof: number; previous_price_xof: number }>(
        `/plans/${editing}`,
        {
          method: "PATCH",
          body: JSON.stringify({ price_xof: Number(price), reason }),
        },
      )
      setNotice(
        `Tarif passé de ${result.previous_price_xof.toLocaleString("fr-FR")} F à ` +
          `${result.price_xof.toLocaleString("fr-FR")} F. Les abonnements en cours ne changent pas.`,
      )
      setEditing(null)
      setRefreshKey((key) => key + 1)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Modification impossible.")
    } finally {
      setSaving(false)
    }
  }

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
    <Panel
      title="Tarifs des forfaits"
      description="Le prix affiché sur le site public et facturé aux nouvelles souscriptions."
    >
      {notice && (
        <p role="status" className="mb-4 rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {notice}
        </p>
      )}

      <p className="mb-5 rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        Changer un tarif n'affecte <strong>aucun abonnement en cours</strong> ni aucun paiement déjà
        annoncé à un client : ceux-là gardent le montant affiché au moment du clic. Le nouveau prix
        s'applique aux souscriptions suivantes, et au site public immédiatement.
      </p>

      <ul className="divide-y divide-white/5">
        {plans.map((plan) => (
          <li key={plan.code} className="py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-white">{plan.name}</span>
              <span className="text-lg tabular-nums text-white">
                {Math.round(plan.price_cents / 100).toLocaleString("fr-FR")} F
              </span>
              <span className="text-xs text-slate-500">par mois</span>
              {plan.price_overridden_at && (
                <span className="text-xs text-amber-300/80">
                  tarif personnalisé le {formatDateTime(plan.price_overridden_at)}
                </span>
              )}
              <ConsoleWrite>
                <button
                  type="button"
                  onClick={() => startEditing(plan)}
                  className="ml-auto rounded-md border border-white/10 px-3 py-1 text-xs text-slate-200 transition-opacity hover:opacity-80"
                >
                  Modifier
                </button>
              </ConsoleWrite>
            </div>
            <p className="mt-1 text-xs text-slate-500">{HINTS[plan.code]}</p>

            {editing === plan.code && (
              <ConsoleWrite>
              <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg bg-white/5 p-4">
                <div>
                  <label htmlFor={`price-${plan.code}`} className="block text-xs text-slate-400">
                    Nouveau prix mensuel, en francs
                  </label>
                  <input
                    id={`price-${plan.code}`}
                    type="number"
                    min={5}
                    step={5}
                    required
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    className="mt-1 w-40 rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm tabular-nums text-white"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Multiple de 5 francs : les opérateurs mobile money refusent les autres montants.
                  </p>
                </div>
                <div>
                  <label htmlFor={`reason-${plan.code}`} className="block text-xs text-slate-400">
                    Motif du changement
                  </label>
                  <input
                    id={`reason-${plan.code}`}
                    type="text"
                    required
                    minLength={3}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Ex. alignement sur la concurrence d'Abidjan"
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                </div>
                {formError && <p className="text-sm text-red-300">{formError}</p>}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={saving}
                    aria-busy={saving}
                    className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                  >
                    {saving ? "Enregistrement…" : "Enregistrer le tarif"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="rounded-md border border-white/10 px-4 py-2 text-sm text-slate-300"
                  >
                    Annuler
                  </button>
                </div>
              </form>
              </ConsoleWrite>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export default ConsolePlans
