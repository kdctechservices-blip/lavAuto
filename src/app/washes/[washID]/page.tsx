"use client"

import type * as React from "react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Ban, BadgeCheck, Lock, RefreshCw, Wallet } from "lucide-react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useApi } from "@/lib/api"
import { formatQuantity } from "@/lib/quantity"
import { useMutation } from "@/lib/use-mutation"
import { createIdempotencyKey } from "@/lib/idempotency"
import { Input } from "@/components/ui/input"
import { PAYMENT_METHODS, paymentMethodLabel as methodLabel } from "@/lib/payments-api"
import { WashReceiptButton } from "@/components/receipt/wash-receipt"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { OperationStatusBadge } from "@/components/washes/operation-status-badge"
import type { OperationStatus } from "@/lib/wash-operation-status"

interface Wash {
  id: string
  reference: string
  site_id: string | null
  vehicle_category_id: string | null
  total_cents: number
  status: string
  operation_status: string
  payment_status: string
  author_id: string
  cancelled_at: string | null
  cancelled_by_id: string | null
  cancellation_reason: string | null
  created_at: string
}

interface WashItem {
  id: string
  service_id: string | null
  service_name_snapshot: string
  price_cents_snapshot: number
  quantity: number
}

interface Worker {
  id: string
  first_name: string
  last_name: string
  role: string
}

interface Payment {
  id: string
  amount_cents: number
  method: string
  status: string
  reference: string | null
  received_at: string
}

interface Consumable {
  id: string
  product_id: string
  product_name: string
  unit: string
  kind: string
  quantity_milli: number
}

interface WashDetail {
  wash: Wash
  items: WashItem[]
  workers: Worker[]
  payments: Payment[]
  /**
   * Absent — et non vide — lorsque le lecteur n'a pas accès au stock ou que
   * son forfait ne l'inclut pas. Une liste vide dirait « ce lavage n'a rien
   * consommé », ce qui est une tout autre affirmation.
   */
  consumables?: Consumable[]
}

interface Site {
  id: string
  name: string
}

interface VehicleCategory {
  id: string
  name: string
}

function formatXof(cents: number): string {
  return `${(cents / 100).toLocaleString("fr-CI", { maximumFractionDigits: 2 })} XOF`
}

const paymentMethodLabel = methodLabel

/** Session de caisse ouverte sur la station du lavage. */
interface CurrentCashSession {
  id: string
  site_id: string
  status: string
}

function parseXofAmount(value: string): number | null {
  const normalized = value.replace(/\s/g, "").replace(",", ".")
  if (!normalized) return null
  const amount = Number(normalized)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.round(amount * 100)
}

function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "En attente de vérification",
    verified: "Vérifié",
    failed: "Échoué",
    refunded: "Remboursé",
  }
  return labels[status] ?? status
}

/** Clés d'occupation : l'annulation et l'encaissement n'occupent pas la même zone. */
const CANCEL_KEY = "annulation"
const PAYMENT_KEY = "encaissement"
const STATUS_KEY = "avancement"

export default function WashDetailPage() {
  const cancelCapability = useAccess("wash:cancel", "washes.cancel")
  // Faire avancer l'avancement d'un lavage est un geste de terrain : c'est
  // la personne qui tient le poste — comptoir ou supervision — qui le pose.
  const statusCapability = useAccess("wash:status")
  const { washID } = useParams<{ washID: string }>()
  const [refreshKey, setRefreshKey] = useState(0)
  const path = washID ? `/api/v1/washes/${encodeURIComponent(washID)}?refresh=${refreshKey}` : ""
  const { data: detail, loading, error } = useApi<WashDetail>(path)
  const { data: sites } = useApi<Site[]>("/api/v1/sites")
  const { data: categories } = useApi<VehicleCategory[]>("/api/v1/vehicle-categories")
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState("")
  // Un contrôleur unique : l'annulation et les encaissements se distinguent
  // par leur clé d'occupation, pas par quatre états séparés.
  const mutation = useMutation()
  const saving = mutation.busyKey === CANCEL_KEY
  const managePayments = useAccess("payment:create", "payments.manage")
  // Remettre au client la preuve de ce qu'il a paye appartient a qui voit
  // les encaissements : le serveur exige la meme permission.
  const readPayments = useAccess("payment:read")
  // Confirmer une réception écrit aussitôt ; ouvrir le formulaire
  // d'encaissement et la zone d'annulation n'écrivent rien.
  const confirmReceipt = actionGate({
    loading: managePayments.loading,
    allowed: managePayments.allowed,
    reason: managePayments.reason,
    writesImmediately: true,
  })
  const paymentForm = actionGate({
    loading: managePayments.loading,
    allowed: managePayments.allowed,
    reason: managePayments.reason,
  })
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<string>("cash")
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentReference, setPaymentReference] = useState("")
  const paymentBusy = mutation.busyKey === PAYMENT_KEY
  const paymentSuccess = mutation.success
  const { data: cashSession } = useApi<CurrentCashSession | null>(
    paymentMethod === "cash" && detail?.wash?.site_id
      ? `/api/v1/cash-sessions/current?site_id=${encodeURIComponent(detail.wash.site_id)}&refresh=${refreshKey}`
      : "",
  )

  /**
   * Fait avancer l'avancement du lavage d'un cran.
   *
   * Meme geste que dans l'historique : la pastille passe a l'etat suivant.
   * Le serveur est seul juge — la fiche se recharge apres l'ecriture, la
   * pastille affiche ce qu'il a reellement accepte.
   */
  async function advanceStatus(next: OperationStatus) {
    if (!washID) return
    const outcome = await mutation.run({
      url: `/api/v1/washes/${encodeURIComponent(washID)}/status`,
      method: "PATCH",
      body: { status: next },
      failure: "Impossible de changer l’avancement de ce lavage.",
      busyKey: STATUS_KEY,
    })
    if (!outcome.ok) return
    setRefreshKey((key) => key + 1)
  }

  async function cancelWash() {
    if (!washID || !reason.trim()) {
      mutation.fail("Indiquez le motif de l’annulation.")
      return
    }
    const outcome = await mutation.run({
      url: `/api/v1/washes/${encodeURIComponent(washID)}/cancel`,
      method: "POST",
      body: { reason: reason.trim() },
      failure: "Impossible d’annuler ce lavage.",
      busyKey: CANCEL_KEY,
    })
    if (!outcome.ok) return
    setCancelOpen(false)
    setReason("")
    setRefreshKey((key) => key + 1)
  }

  const paidCents = (detail?.payments ?? [])
    .filter((payment) => payment.status !== "refunded")
    .reduce((sum, payment) => sum + payment.amount_cents, 0)
  const remainingCents = Math.max(0, (detail?.wash?.total_cents ?? 0) - paidCents)

  /** Encaisse un complément (ou la totalité) du solde restant. */
  async function recordPayment() {
    if (!washID) return
    const amountCents = parseXofAmount(paymentAmount)
    if (amountCents == null) {
      mutation.fail("Saisissez un montant valide.")
      return
    }
    if (amountCents > remainingCents) {
      mutation.fail("Le montant dépasse le solde restant.")
      return
    }
    if (paymentMethod === "cash" && !cashSession?.id) {
      mutation.fail("Ouvrez une session de caisse pour encaisser des espèces.")
      return
    }
    const outcome = await mutation.run({
      url: `/api/v1/washes/${encodeURIComponent(washID)}/payments`,
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        method: paymentMethod,
        amount_cents: amountCents,
        reference: paymentReference.trim() || undefined,
        cash_session_id: paymentMethod === "cash" ? cashSession?.id : undefined,
      },
      success: "Encaissement enregistré.",
      failure: "Encaissement impossible : serveur injoignable.",
      busyKey: PAYMENT_KEY,
    })
    if (!outcome.ok) return
    setPaymentOpen(false)
    setPaymentAmount("")
    setPaymentReference("")
    setRefreshKey((key) => key + 1)
  }

  /** Confirme la réception d'un paiement mobile money. */
  async function confirmPayment(paymentId: string) {
    const outcome = await mutation.run({
      url: `/api/v1/payments/${paymentId}/verify`,
      method: "POST",
      body: {},
      success: "Paiement confirmé.",
      failure: "Confirmation impossible : serveur injoignable.",
      busyKey: PAYMENT_KEY,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  const wash = detail?.wash
  const hasVerifiedPayment = detail?.payments.some((payment) => payment.status === "verified") ?? false
  // Un paiement vérifié bloque l'annulation, mais ce n'est pas un refus de
  // droit : le dire évite de faire croire à une permission manquante.
  const cancelGate = actionGate({
    loading: cancelCapability.loading,
    allowed: cancelCapability.allowed,
    reason: cancelCapability.reason,
    blockedBy: hasVerifiedPayment
      ? "Au moins un paiement est vérifié : remboursez-le avant d'annuler le lavage."
      : null,
  })
  const siteName = sites?.find((site) => site.id === wash?.site_id)?.name ?? "—"
  const vehicleCategoryName = categories?.find((category) => category.id === wash?.vehicle_category_id)?.name ?? "—"

  return (
    <BaseLayout title="Détail du lavage" description="Détail et historique d’un lavage." hideHeading>
      <div className="space-y-6 p-4">
        <div>
          <Button render={<Link to="/washes" viewTransition />} variant="ghost" className="group -ml-2 mb-3">
            <ArrowLeft className="mr-2 size-4 transition-transform duration-150 group-hover:-translate-x-0.5" /> Retour aux lavages
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">
            {wash ? (
              <>
                Lavage{" "}
                {/* Cible de la transition depuis la ligne du tableau. */}
                <span style={{ viewTransitionName: "wash-reference" }}>{wash.reference}</span>
              </>
            ) : (
              "Détail du lavage"
            )}
          </h1>
          <p className="text-sm text-muted-foreground">Consultez les prestations, employés et paiements associés.</p>
        </div>

        {loading && (
          <div className="space-y-4" role="status" aria-busy="true" aria-label="Chargement du lavage">
            <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3, 4, 5].map((field) => (
                <div key={field} className="row-in space-y-2" style={{ "--row": field } as React.CSSProperties}>
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-5 w-32" />
                </div>
              ))}
            </div>
            <TableSkeleton rows={3} cols={4} label="Chargement des prestations" />
          </div>
        )}
        {error && <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}

        {!loading && !error && detail && (
          <>
            <section className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Référence</p>
                <p className="font-semibold">{wash?.reference}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Station</p>
                <p className="font-semibold">{siteName}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Catégorie</p>
                <p className="font-semibold">{vehicleCategoryName}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Date d’enregistrement</p>
                <p className="font-semibold">{wash ? new Date(wash.created_at).toLocaleString("fr-CI") : "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avancement</p>
                <OperationStatusBadge
                  status={wash?.operation_status}
                  cancelled={wash?.status === "cancelled"}
                  canAdvance={statusCapability.allowed}
                  busy={mutation.busyKey === STATUS_KEY}
                  onAdvance={(next) => void advanceStatus(next)}
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Statut du paiement</p>
                <p className="font-semibold">{wash?.payment_status === "paid" ? "Payé" : wash?.payment_status === "partial" ? "Partiel" : wash?.payment_status === "refunded" ? "Remboursé" : "Non payé"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-lg font-bold">{formatXof(wash?.total_cents ?? 0)}</p>
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border bg-card">
              <div className="border-b p-4">
                <h2 className="font-semibold">Prestations enregistrées</h2>
                <p className="text-sm text-muted-foreground">Nom et prix figés au moment de la vente.</p>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prestation</TableHead>
                      <TableHead className="text-right">Prix unitaire</TableHead>
                      <TableHead className="text-right">Quantité</TableHead>
                      <TableHead className="text-right">Sous-total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.items.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Aucune ligne de prestation.</TableCell></TableRow>
                    )}
                    {detail.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">{item.service_name_snapshot}</TableCell>
                        <TableCell className="text-right">{formatXof(item.price_cents_snapshot)}</TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">{formatXof(item.price_cents_snapshot * item.quantity)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            {detail.consumables && (
              <section className="overflow-hidden rounded-lg border bg-card">
                <div className="border-b p-4">
                  <h2 className="font-semibold">Sorti du stock</h2>
                  <p className="text-sm text-muted-foreground">
                    Déduit automatiquement à l’enregistrement. Sans effet sur le prix facturé.
                  </p>
                </div>
                {detail.consumables.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    Ce lavage n’a rien sorti du stock. Déclarez les consommables de la prestation
                    dans le catalogue pour que la déduction soit automatique.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {detail.consumables.map((ligne) => (
                      <li key={ligne.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <span className="font-medium">{ligne.product_name}</span>
                        <span
                          className={
                            ligne.kind === "reversal"
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-muted-foreground"
                          }
                        >
                          {ligne.kind === "reversal" ? "rendu au stock : " : ""}
                          {formatQuantity(Math.abs(ligne.quantity_milli), ligne.unit)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-lg border bg-card p-4">
                <h2 className="font-semibold">Employés affectés</h2>
                {detail.workers.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">Aucun employé affecté à ce lavage.</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {detail.workers.map((worker) => (
                      <li key={worker.id} className="flex justify-between rounded-md bg-muted/40 px-3 py-2">
                        <span>{worker.first_name} {worker.last_name}</span>
                        <span className="text-muted-foreground">{worker.role.replaceAll("_", " ")}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold">Paiements</h2>
                  <span className="text-sm text-muted-foreground">
                    {formatXof(paidCents)} / {formatXof(wash?.total_cents ?? 0)}
                  </span>
                </div>

                {/* Un lavage annulé ne donne aucun reçu : le papier prouverait
                    un paiement pour une prestation qui n'a pas eu lieu. */}
                {washID && readPayments.allowed && wash?.status !== "cancelled" && (
                  <div className="mt-3">
                    <WashReceiptButton washId={washID} />
                  </div>
                )}

                {detail.payments.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">Aucun paiement enregistré.</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {detail.payments.map((payment) => (
                      <li key={payment.id} className="rounded-md bg-muted/40 px-3 py-2">
                        <div className="flex justify-between gap-3">
                          <span className="font-medium">{paymentMethodLabel(payment.method)}</span>
                          <span>{formatXof(payment.amount_cents)}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                          <span>{paymentStatusLabel(payment.status)}</span>
                          <time>{new Date(payment.received_at).toLocaleString("fr-CI")}</time>
                        </div>
                        {payment.status === "pending" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-2 h-8"
                            disabled={paymentBusy || confirmReceipt.disabled}
                            aria-busy={confirmReceipt.busy}
                            title={confirmReceipt.reason ?? undefined}
                            onClick={() => void confirmPayment(payment.id)}
                          >
                            <BadgeCheck className="mr-1.5 size-3.5" /> Confirmer la réception
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {/* Solde restant : encaissement en plusieurs fois ------------- */}
                {wash?.status !== "cancelled" && remainingCents > 0 && (
                  <div className="mt-4 border-t pt-3">
                    <p className="text-sm">
                      Solde restant : <strong>{formatXof(remainingCents)}</strong>
                    </p>
                    {paymentOpen ? (
                      <div className="mt-3 space-y-3">
                        <label className="flex flex-col gap-1 text-sm font-medium">
                          Moyen de paiement
                          <select
                            className="h-11 rounded-md border border-input bg-background px-3 text-sm"
                            value={paymentMethod}
                            onChange={(event) => setPaymentMethod(event.target.value)}
                          >
                            {PAYMENT_METHODS.map((method) => (
                              <option key={method} value={method}>
                                {paymentMethodLabel(method)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-sm font-medium">
                          Montant reçu (XOF)
                          <div className="flex gap-2">
                            <Input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              step="any"
                              className="h-11"
                              value={paymentAmount}
                              onChange={(event) => setPaymentAmount(event.target.value)}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              className="h-11 whitespace-nowrap"
                              onClick={() => setPaymentAmount(String(remainingCents / 100))}
                            >
                              Solde entier
                            </Button>
                          </div>
                        </label>
                        {paymentMethod !== "cash" && (
                          <label className="flex flex-col gap-1 text-sm font-medium">
                            Référence de la transaction <span className="font-normal text-muted-foreground">(facultatif)</span>
                            <Input
                              className="h-11"
                              value={paymentReference}
                              onChange={(event) => setPaymentReference(event.target.value)}
                              placeholder="Ex. OM-2026-10-20-00123"
                            />
                          </label>
                        )}
                        {paymentMethod === "cash" && !cashSession?.id && (
                          <p role="alert" className="text-sm text-destructive">
                            Aucune session de caisse ouverte sur cette station : ouvrez la caisse pour encaisser des espèces.
                          </p>
                        )}
                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                          <Button type="button" variant="ghost" onClick={() => setPaymentOpen(false)}>
                            Annuler
                          </Button>
                          <Button type="button" disabled={paymentBusy} onClick={() => void recordPayment()}>
                            {paymentBusy ? <RefreshCw className="mr-2 size-4 animate-spin" /> : <Wallet className="mr-2 size-4" />}
                            Enregistrer l’encaissement
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        className="mt-2 h-11"
                        disabled={paymentForm.disabled}
                        aria-busy={paymentForm.busy}
                        title={paymentForm.reason ?? undefined}
                        onClick={() => {
                          mutation.reset()
                          mutation.reset()
                          setPaymentAmount(String(remainingCents / 100))
                          setPaymentOpen(true)
                        }}
                      >
                        {managePayments.allowed ? <Wallet className="mr-2 size-4" /> : <Lock className="mr-2 size-4" />}
                        Encaisser le solde
                      </Button>
                    )}
                  </div>
                )}

                {paymentSuccess && (
                  <p role="status" className="mt-3 rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                    {paymentSuccess}
                  </p>
                )}
                {mutation.error && !cancelOpen && (
                  <p role="alert" className="mt-3 text-sm text-destructive">
                    {mutation.error}
                  </p>
                )}
              </div>
            </section>

            {wash?.status === "cancelled" && (
              <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <h2 className="font-semibold text-destructive">Lavage annulé</h2>
                <p className="mt-1 text-sm">Motif : {wash.cancellation_reason || "—"}</p>
                {wash.cancelled_at && <p className="mt-1 text-xs text-muted-foreground">Annulé le {new Date(wash.cancelled_at).toLocaleString("fr-CI")}</p>}
              </section>
            )}

            {wash?.status !== "cancelled" && (
              <section className="rounded-lg border p-4">
                <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
                  <div>
                    <h2 className="font-semibold">Annulation</h2>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                      L’annulation conserve le détail pour l’audit. Les paiements vérifiés doivent être remboursés avant de pouvoir annuler le lavage.
                    </p>
                    {hasVerifiedPayment && (
                      <p className="mt-2 text-sm text-destructive">Au moins un paiement est vérifié; l’annulation est bloquée jusqu’au remboursement.</p>
                    )}
                  </div>
                  <div className="flex flex-col items-start gap-1.5">
                    <Button
                      variant="destructive"
                      disabled={cancelGate.disabled}
                      aria-busy={cancelGate.busy}
                      title={cancelGate.reason ?? undefined}
                      onClick={() => {
                        mutation.reset()
                        setCancelOpen((open) => !open)
                      }}
                    >
                      {cancelGate.denied ? (
                        <Lock className="mr-2 size-4" />
                      ) : (
                        <Ban className="mr-2 size-4" />
                      )}{" "}
                      Annuler le lavage
                    </Button>
                    <BlockedReason reason={cancelGate.reason} className="max-w-72" />
                  </div>
                </div>
                {cancelOpen && (
                  <div className="mt-4 space-y-3 border-t pt-4">
                    <label className="flex flex-col gap-1.5 text-sm font-medium">
                      Motif de l’annulation
                      <Textarea
                        value={reason}
                        maxLength={500}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="Ex. erreur de saisie, véhicule non pris en charge…"
                      />
                    </label>
                    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setCancelOpen(false)}>Garder le lavage</Button>
                      <Button variant="destructive" disabled={saving || !reason.trim()} onClick={cancelWash}>
                        {saving && <RefreshCw className="mr-2 size-4 animate-spin" />}
                        Confirmer l’annulation
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </BaseLayout>
  )
}
