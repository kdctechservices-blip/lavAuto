"use client"

import * as React from "react"
import { Check, Copy, Hourglass, Send, Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApi } from "@/lib/api"
import type { Plan } from "@/lib/onboarding-api"
import {
  DURATIONS,
  declarePayment,
  formatFcfa,
  openCheckout,
  type CheckoutResponse,
  type PaymentIntent,
} from "@/lib/checkout-api"
import { cn } from "cn"

/**
 * Souscription à un forfait payant.
 *
 * Trois temps, et un seul à la fois à l'écran :
 *
 *   1. **choisir** — forfait et durée, avec le montant total ;
 *   2. **payer** — la référence à citer, le numéro marchand, les canaux ;
 *   3. **déclarer** — la référence rendue par l'opérateur.
 *
 * Le montant n'est jamais animé : c'est un chiffre qu'on vérifie avant de
 * sortir de l'argent, pas un effet.
 */
export function UpgradeRequestCard({ currentPlanCode }: { currentPlanCode?: string | null }) {
  const { data: plans } = useApi<Plan[]>("/api/v1/plans")
  const [refreshKey, setRefreshKey] = React.useState(0)
  const { data: intentData } = useApi<{ intents: PaymentIntent[] }>(
    `/api/v1/subscription/checkout?k=${refreshKey}`,
  )

  const payablePlans = React.useMemo(
    () => (plans ?? []).filter((plan) => plan.price_cents > 0),
    [plans],
  )

  const [selected, setSelected] = React.useState<string | null>(null)
  const [months, setMonths] = React.useState(1)
  const [checkout, setCheckout] = React.useState<CheckoutResponse | null>(null)
  const [transactionRef, setTransactionRef] = React.useState("")
  const [channel, setChannel] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  const activePlan = selected ?? payablePlans[0]?.code ?? null
  const plan = payablePlans.find((p) => p.code === activePlan) ?? null
  const total = plan ? plan.price_cents * months : 0

  // Une demande déjà déclarée reprend la main sur le formulaire : réafficher
  // le choix du forfait laisserait croire que rien n'a été envoyé, et le
  // client paierait une seconde fois.
  const awaiting = (intentData?.intents ?? []).find(
    (intent) => intent.status === "pending" && intent.declared_at !== null,
  )

  async function submitCheckout() {
    if (!activePlan) return
    setBusy(true)
    setError(null)
    try {
      setCheckout(await openCheckout(activePlan, months))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Demande impossible : serveur injoignable.")
    } finally {
      setBusy(false)
    }
  }

  async function submitDeclaration() {
    if (!checkout) return
    setBusy(true)
    setError(null)
    try {
      await declarePayment(checkout.reference, {
        transaction_reference: transactionRef.trim(),
        paid_with: channel ?? undefined,
      })
      setCheckout(null)
      setTransactionRef("")
      setRefreshKey((k) => k + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Déclaration impossible.")
    } finally {
      setBusy(false)
    }
  }

  async function copyReference() {
    if (!checkout) return
    try {
      await navigator.clipboard.writeText(checkout.reference)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Le presse-papiers peut être refusé : la référence reste lisible.
    }
  }

  if (payablePlans.length === 0) return null

  // --- 3. Une déclaration est en attente de vérification --------------------
  if (awaiting) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hourglass className="size-5" aria-hidden="true" /> Paiement en cours de vérification
          </CardTitle>
          <CardDescription>
            Votre paiement a été déclaré. L'activation intervient dès vérification,
            en général sous quelques heures ouvrées.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Référence de la demande</dt>
              <dd className="font-mono font-semibold">{awaiting.reference}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Forfait</dt>
              <dd className="font-medium">
                {awaiting.plan_code} · {awaiting.months} mois
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Montant</dt>
              <dd className="font-medium">{formatFcfa(awaiting.amount_cents)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Votre transaction</dt>
              <dd className="font-mono">{awaiting.declared_reference}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    )
  }

  // --- 2. La référence est émise, le client doit payer ----------------------
  if (checkout) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-5" aria-hidden="true" /> Payer {checkout.plan_name}
          </CardTitle>
          <CardDescription>
            Envoyez le montant exact au numéro ci-dessous, en indiquant la référence
            dans le motif du transfert.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase text-muted-foreground">Montant à envoyer</p>
              <p className="text-2xl font-bold tabular-nums">{formatFcfa(checkout.amount_cents)}</p>
              <p className="text-xs text-muted-foreground">
                {checkout.plan_name} · {checkout.months} mois
              </p>
            </div>
            <div>
              <p className="text-xs uppercase text-muted-foreground">Référence à citer</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-xl font-bold">{checkout.reference}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyReference()}
                  aria-label="Copier la référence"
                >
                  {copied ? (
                    <Check className="size-4 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Sans elle, votre paiement ne peut pas être rattaché à votre station.
              </p>
            </div>
          </div>

          {checkout.instructions?.merchant_number ? (
            <div className="rounded-lg border p-4">
              <p className="text-xs uppercase text-muted-foreground">Numéro à créditer</p>
              <p className="text-lg font-semibold">{checkout.instructions.merchant_number}</p>
              {checkout.instructions.merchant_name && (
                <p className="text-sm text-muted-foreground">
                  {checkout.instructions.merchant_name}
                </p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">
                Canaux acceptés : {checkout.instructions.channels.join(", ")}.
              </p>
            </div>
          ) : (
            <p
              role="alert"
              className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-sm"
            >
              Le numéro d'encaissement n'est pas encore configuré. Contactez l'assistance
              en citant la référence {checkout.reference}.
            </p>
          )}

          <div className="flex flex-col gap-2 border-t pt-4">
            <label className="text-sm font-medium" htmlFor="transaction-ref">
              Une fois payé, saisissez la référence de votre transaction
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="transaction-ref"
                value={transactionRef}
                onChange={(event) => setTransactionRef(event.target.value)}
                placeholder="Ex. OM-77412093"
                className="w-56"
              />
              <div className="flex flex-wrap gap-1.5">
                {(checkout.instructions?.channels ?? []).map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setChannel(name)}
                    aria-pressed={channel === name}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-transform duration-150 hover:-translate-y-px",
                      channel === name ? "border-primary bg-primary/10 font-medium" : "bg-background",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              C'est le numéro que votre opérateur vous renvoie par SMS après le transfert.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="h-11"
              disabled={busy || transactionRef.trim().length < 3}
              onClick={() => void submitDeclaration()}
            >
              {busy ? "Envoi…" : "J'ai payé"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCheckout(null)}>
              Revenir au choix du forfait
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // --- 1. Choix du forfait et de la durée -----------------------------------
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="size-5" aria-hidden="true" /> Activer un forfait
        </CardTitle>
        <CardDescription>
          Choisissez votre forfait et sa durée. Vous recevrez une référence à citer
          lors du paiement par mobile money.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {payablePlans.map((item) => {
            const isActive = activePlan === item.code
            return (
              <button
                key={item.code}
                type="button"
                onClick={() => setSelected(item.code)}
                aria-pressed={isActive}
                className={cn(
                  "rounded-lg border p-3 text-left transition-all duration-150 hover:-translate-y-0.5 hover:shadow-sm",
                  isActive ? "border-primary bg-primary/5" : "bg-background",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{item.name}</span>
                  {item.code === currentPlanCode && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase">
                      Actuel
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                <p className="mt-2 font-medium tabular-nums">
                  {formatFcfa(item.price_cents)} / mois
                </p>
              </button>
            )
          })}
        </div>

        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1.5 text-sm font-medium">Durée</legend>
          {DURATIONS.map((duration) => (
            <button
              key={duration.months}
              type="button"
              onClick={() => setMonths(duration.months)}
              aria-pressed={months === duration.months}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-transform duration-150 hover:-translate-y-px",
                months === duration.months
                  ? "border-primary bg-primary/10 font-medium"
                  : "bg-background",
              )}
            >
              {duration.label}
            </button>
          ))}
        </fieldset>

        {plan && (
          <p className="text-sm">
            Total à payer :{" "}
            <strong className="tabular-nums text-base">{formatFcfa(total)}</strong>{" "}
            <span className="text-muted-foreground">
              pour {months} mois de {plan.name}
            </span>
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button
          type="button"
          className="h-11 self-start"
          disabled={busy || !activePlan}
          onClick={() => void submitCheckout()}
        >
          <Send className="mr-2 size-4" aria-hidden="true" />
          {busy ? "Préparation…" : "Obtenir ma référence de paiement"}
        </Button>
      </CardContent>
    </Card>
  )
}
