"use client"

import * as React from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { motion } from "framer-motion"
import { TRANSITION } from "@/lib/motion"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import { createIdempotencyKey } from "@/lib/idempotency"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AnimatedNumber } from "@/components/ui/animated-number"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { ArrowDownToLine, ArrowUpFromLine, Lock, Plus, WalletCards } from "lucide-react"
import { currentUtilityMonth, type UtilitiesOverview } from "@/lib/utilities"
import {
  ClosingUtilityReadings,
  type ClosingUtilitySubmission,
} from "@/components/closing-utility-readings"

interface Site {
  id: string
  name: string
  city: string | null
}

interface CashSession {
  id: string
  site_id: string
  opening_amount_cents: number
  theoretical_balance_cents: number
  counted_amount_cents: number | null
  discrepancy_cents: number | null
  status: string
  opened_at: string
  closed_at: string | null
}

interface CashMovement {
  id: string
  type: string
  amount_cents: number
  source: string
  created_at: string
}

function xofToCents(value: string, requirePositive = false): number | null {
  if (!value.trim()) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  const cents = Math.round(amount * 100)
  if (!Number.isSafeInteger(cents) || (requirePositive && cents <= 0)) return null
  return cents
}

/** Clé d'occupation des formulaires de caisse. */
const FORM_KEY = "formulaire"

export default function CashDrawerPage() {
  const manageCash = useAccess("cash_session:manage", "cash.manage")
  const { data: sites, loading: sitesLoading, error: sitesError } = useApi<Site[]>("/api/v1/sites")
  const [selectedSiteId, setSelectedSiteId] = React.useState("")
  const siteId = selectedSiteId || sites?.[0]?.id || ""
  const [openDialog, setOpenDialog] = React.useState(false)
  const [openingAmount, setOpeningAmount] = React.useState("0")
  const openingRequestKeys = React.useRef(new Map<string, string>())
  const [movementDialogOpen, setMovementDialogOpen] = React.useState(false)
  const [movementType, setMovementType] = React.useState<"entry" | "exit">("entry")
  const [movementAmount, setMovementAmount] = React.useState("")
  const [movementDescription, setMovementDescription] = React.useState("")
  const movementRequestKeys = React.useRef(new Map<string, string>())
  const [closeDialogOpen, setCloseDialogOpen] = React.useState(false)
  const [countedAmount, setCountedAmount] = React.useState("")
  const [discrepancyReason, setDiscrepancyReason] = React.useState("")
  const [closingUtilitySubmission, setClosingUtilitySubmission] = React.useState<ClosingUtilitySubmission>({ readings: [], canClose: false })
  const [refreshKey, setRefreshKey] = React.useState(0)
  // Un contrôleur unique pour les trois écritures de caisse.
  const mutation = useMutation()
  const saving = mutation.busyKey === FORM_KEY
  const sessionPath = siteId
    ? `/api/v1/cash-sessions/current?site_id=${encodeURIComponent(siteId)}&refresh=${refreshKey}`
    : ""
  const { data: session, loading, error } = useApi<CashSession | null>(sessionPath)

  // Les quatre actions de caisse ouvrent toutes une boîte de dialogue : rien
  // n'est écrit avant validation, donc l'attente des droits ne les grise pas.
  // L'ouverture a ses propres prérequis, qui ne sont pas des refus de droit.
  const openSession = actionGate({
    loading: manageCash.loading,
    allowed: manageCash.allowed,
    reason: manageCash.reason,
    blockedBy: sitesLoading || loading
      ? null
      : !siteId
        ? "Choisissez une station pour ouvrir une session."
        : session
          ? "Une session est déjà ouverte sur cette station. Clôturez-la avant d'en ouvrir une autre."
          : null,
  })
  const cashAction = actionGate({
    loading: manageCash.loading,
    allowed: manageCash.allowed,
    reason: manageCash.reason,
  })
  const movementPath = session
    ? `/api/v1/cash-sessions/${encodeURIComponent(session.id)}/movements?refresh=${refreshKey}`
    : ""
  const { data: movements } = useApi<CashMovement[]>(movementPath)
  const utilitiesPath = siteId
    ? `/api/v1/utilities?month=${currentUtilityMonth()}&site_id=${encodeURIComponent(siteId)}&refresh=${refreshKey}`
    : ""
  const { data: utilityOverview, loading: utilitiesLoading, error: utilitiesError } = useApi<UtilitiesOverview>(utilitiesPath)
  const utilityMeters = React.useMemo(
    () => utilityOverview?.meters.filter((meter) => meter.is_active) ?? [],
    [utilityOverview],
  )

  async function openCashSession() {
    const amountCents = xofToCents(openingAmount)
    if (!siteId || amountCents == null) {
      mutation.fail("Sélectionnez une station et saisissez un montant valide.")
      return
    }

    const body = { site_id: siteId, opening_amount_cents: amountCents }
    const fingerprint = JSON.stringify(body)
    let requestKey = openingRequestKeys.current.get(fingerprint)
    if (!requestKey) {
      requestKey = createIdempotencyKey()
      openingRequestKeys.current.set(fingerprint, requestKey)
    }

    const outcome = await mutation.run({
      url: "/api/v1/cash-sessions/open",
      method: "POST",
      headers: { "Idempotency-Key": requestKey },
      body,
      failure: "Impossible d’ouvrir la caisse.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setOpenDialog(false)
    setOpeningAmount("0")
    openingRequestKeys.current.clear()
    setRefreshKey((key) => key + 1)
  }

  async function addMovement() {
    if (!session) return
    const amountCents = xofToCents(movementAmount, true)
    if (amountCents == null) {
      mutation.fail("Saisissez un montant positif valide.")
      return
    }

    const body = {
      type: movementType,
      amount_cents: amountCents,
      description: movementDescription.trim() || null,
    }
    const fingerprint = JSON.stringify({ cash_session_id: session.id, ...body })
    let requestKey = movementRequestKeys.current.get(fingerprint)
    if (!requestKey) {
      requestKey = createIdempotencyKey()
      movementRequestKeys.current.set(fingerprint, requestKey)
    }

    const outcome = await mutation.run({
      url: `/api/v1/cash-sessions/${encodeURIComponent(session.id)}/movements`,
      method: "POST",
      headers: { "Idempotency-Key": requestKey },
      body,
      failure: "Impossible d’enregistrer le mouvement.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setMovementDialogOpen(false)
    setMovementAmount("")
    setMovementDescription("")
    movementRequestKeys.current.clear()
    setRefreshKey((key) => key + 1)
  }

  async function closeCashSession() {
    if (!session) return
    const countedAmountCents = xofToCents(countedAmount)
    if (countedAmountCents == null) {
      mutation.fail("Saisissez le montant réellement compté.")
      return
    }
    const hasDiscrepancy = countedAmountCents !== session.theoretical_balance_cents
    if (hasDiscrepancy && !discrepancyReason.trim()) {
      mutation.fail("Justifiez l’écart avant de clôturer la session.")
      return
    }

    if (utilitiesLoading || utilitiesError) {
      mutation.fail("Les compteurs n'ont pas pu être vérifiés. Rechargez-les avant de clôturer la caisse.")
      return
    }
    if (!closingUtilitySubmission.canClose) {
      mutation.fail("Calculez l'aperçu des compteurs et ajoutez les commentaires demandés avant de clôturer.")
      return
    }

    const outcome = await mutation.run({
      url: `/api/v1/cash-sessions/${encodeURIComponent(session.id)}/close`,
      method: "POST",
      body: {
        counted_amount_cents: countedAmountCents,
        discrepancy_reason: discrepancyReason.trim() || null,
        utility_readings: closingUtilitySubmission.readings,
      },
      failure: "Impossible de clôturer la caisse.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setCloseDialogOpen(false)
    setCountedAmount("")
    setDiscrepancyReason("")
    setClosingUtilitySubmission({ readings: [], canClose: false })
    setRefreshKey((key) => key + 1)
  }

  const parsedCountedAmount = xofToCents(countedAmount)
  const countHasDiscrepancy =
    session != null && parsedCountedAmount != null &&
    parsedCountedAmount !== session.theoretical_balance_cents
  return (
    <BaseLayout title="Caisse" description="Ouverture, clôture et suivi de la caisse." hideHeading>
      <div className="p-4">
        <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Caisse</h1>
            <p className="text-muted-foreground">
              Gérez vos sessions de caisse et vos mouvements d’argent.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex min-w-56 flex-col gap-1 text-sm font-medium">
              Site
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={siteId}
                onChange={(event) => setSelectedSiteId(event.target.value)}
                disabled={sitesLoading || !sites?.length}
              >
                {sites?.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}{site.city ? ` — ${site.city}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <Button
              onClick={() => {
                mutation.reset()
                setOpenDialog(true)
              }}
              disabled={openSession.disabled || loading || sitesLoading}
              aria-busy={openSession.busy || loading || sitesLoading}
              title={openSession.reason ?? undefined}
            >
              {openSession.denied ? (
                <Lock className="mr-2 size-4" />
              ) : (
                <Plus className="mr-2 size-4" />
              )}
              {session ? "Session ouverte" : "Nouvelle session"}
            </Button>
            <BlockedReason reason={openSession.reason} className="max-w-72" />
          </div>
        </div>

        {sitesError && <div className="text-destructive">{sitesError}</div>}
        {!sitesLoading && sites?.length === 0 && (
          <div className="rounded border bg-muted p-4 text-sm text-muted-foreground">
            Aucun site n’est associé à cette organisation. Terminez l’onboarding pour créer le premier site.
          </div>
        )}
        {loading && (
          <div className="grid gap-4 md:grid-cols-3" role="status" aria-busy="true" aria-label="Chargement de la caisse">
            {[0, 1, 2].map((card) => (
              <div
                key={card}
                className="row-in rounded border bg-card p-4"
                style={{ "--row": card } as React.CSSProperties}
              >
                <Skeleton className="h-3 w-28" />
                <Skeleton className="mt-3 h-7 w-36" />
              </div>
            ))}
          </div>
        )}
        {error && <div className="text-destructive">{error}</div>}

        {!loading && !error && siteId && !session && (
          <div className="rounded border bg-muted p-4">
            <p className="text-sm text-muted-foreground">
              Aucune session ouverte pour ce site. Ouvrez une session pour commencer le suivi.
            </p>
          </div>
        )}

        {!loading && !error && session && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="row-in rounded border bg-card p-4" style={{ "--row": 0 } as React.CSSProperties}>
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  {/* Pastille qui respire : la caisse est ouverte, visible en vision périphérique. */}
                  <span className="pulse-soft size-2 rounded-full bg-emerald-500" aria-hidden="true" />
                  Solde théorique
                </p>
                {/* Lecture seule : le compteur peut être animé sans gêner un comptage. */}
                <p className="text-2xl font-bold">
                  <AnimatedNumber
                    value={session.theoretical_balance_cents}
                    format={(cents) => `${(cents / 100).toLocaleString("fr-CI")} XOF`}
                  />
                </p>
              </div>
              <div className="row-in rounded border bg-card p-4" style={{ "--row": 1 } as React.CSSProperties}>
                <p className="text-sm text-muted-foreground">Montant compté</p>
                {/* Jamais animé : c'est le chiffre que le gérant vérifie. */}
                <p className="text-2xl font-bold tabular-nums">
                  {session.counted_amount_cents != null
                    ? `${(session.counted_amount_cents / 100).toLocaleString("fr-CI")} XOF`
                    : "—"}
                </p>
              </div>
              <div
                className={`row-in rounded border bg-card p-4 transition-colors ${
                  session.discrepancy_cents ? "shake-x border-destructive/40 bg-destructive/5" : ""
                }`}
                style={{ "--row": 2 } as React.CSSProperties}
              >
                <p className="text-sm text-muted-foreground">Écart de caisse</p>
                <p
                  className={`text-2xl font-bold tabular-nums transition-colors ${
                    session.discrepancy_cents
                      ? "text-destructive"
                      : session.counted_amount_cents != null
                        ? "text-emerald-600 dark:text-emerald-400"
                        : ""
                  }`}
                >
                  {session.discrepancy_cents != null
                    ? `${(session.discrepancy_cents / 100).toLocaleString("fr-CI")} XOF`
                    : "—"}
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-4">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <h2 className="text-lg font-bold">Mouvements de caisse</h2>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={cashAction.disabled}
                    aria-busy={cashAction.busy}
                    title={cashAction.reason ?? undefined}
                    onClick={() => {
                      setMovementType("entry")
                      mutation.reset()
                      setMovementDialogOpen(true)
                    }}
                  >
                    <ArrowDownToLine className="mr-2 size-4" /> Entrée
                  </Button>
                  <Button
                    variant="outline"
                    disabled={cashAction.disabled}
                    aria-busy={cashAction.busy}
                    title={cashAction.reason ?? undefined}
                    onClick={() => {
                      setMovementType("exit")
                      mutation.reset()
                      setMovementDialogOpen(true)
                    }}
                  >
                    <ArrowUpFromLine className="mr-2 size-4" /> Sortie
                  </Button>
                  <Button
                    disabled={cashAction.disabled}
                    aria-busy={cashAction.busy}
                    title={cashAction.reason ?? undefined}
                    onClick={() => {
                      setCountedAmount("")
                      setDiscrepancyReason("")
                      setClosingUtilitySubmission({ readings: [], canClose: false })
                      mutation.reset()
                      setCloseDialogOpen(true)
                    }}
                  >
                    <WalletCards className="mr-2 size-4" /> Clôturer
                  </Button>
                </div>
                <BlockedReason reason={cashAction.reason} />
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Montant (XOF)</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(movements?.length ?? 0) === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-0">
                          <EmptyState
                            icon={WalletCards}
                            title="Aucun mouvement enregistré"
                            description="Les encaissements de lavages et les sorties de caisse s'afficheront ici au fil de la journée."
                          />
                        </TableCell>
                      </TableRow>
                    )}
                    {movements?.map((movement, index) => (
                      <TableRow
                        key={movement.id}
                        className="row-in"
                        style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                      >
                        <TableCell>{new Date(movement.created_at).toLocaleDateString("fr-CI")}</TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                              movement.type === "entry"
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                            }`}
                          >
                            {movement.type === "entry" ? "Entrée" : "Sortie"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(movement.amount_cents / 100).toLocaleString("fr-CI")}
                        </TableCell>
                        <TableCell>{movement.source}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}

        <Dialog open={openDialog} onOpenChange={setOpenDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Ouvrir une session de caisse</DialogTitle>
              <DialogDescription>
                Le montant d’ouverture initialise le solde théorique du site sélectionné.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="opening-amount">
              Fonds de caisse initial (XOF)
              <Input
                id="opening-amount"
                type="number"
                min="0"
                step="1"
                value={openingAmount}
                onChange={(event) => setOpeningAmount(event.target.value)}
                disabled={saving}
              />
            </label>
            {mutation.error && <p className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpenDialog(false)} disabled={saving}>
                Annuler
              </Button>
              <Button onClick={openCashSession} disabled={saving || !siteId}>
                {saving ? "Ouverture…" : "Ouvrir la caisse"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={movementDialogOpen} onOpenChange={setMovementDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {movementType === "entry" ? "Enregistrer une entrée" : "Enregistrer une sortie"}
              </DialogTitle>
              <DialogDescription>
                Le mouvement sera ajouté au journal et au solde de cette session.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="movement-amount">
              Montant (XOF)
              <Input
                id="movement-amount"
                type="number"
                min="0"
                step="1"
                value={movementAmount}
                onChange={(event) => setMovementAmount(event.target.value)}
                disabled={saving}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="movement-description">
              Description (facultative)
              <Input
                id="movement-description"
                value={movementDescription}
                onChange={(event) => setMovementDescription(event.target.value)}
                disabled={saving}
              />
            </label>
            {mutation.error && <p className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setMovementDialogOpen(false)} disabled={saving}>
                Annuler
              </Button>
              <Button onClick={addMovement} disabled={saving || !movementAmount}>
                {saving ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
          <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Clôturer la session de caisse</DialogTitle>
              <DialogDescription>
                Solde théorique : {session
                  ? `${(session.theoretical_balance_cents / 100).toLocaleString("fr-CI")} XOF`
                  : "—"}. Comptez les espèces avant de confirmer.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="counted-amount">
              Montant réellement compté (XOF)
              <Input
                id="counted-amount"
                type="number"
                min="0"
                step="1"
                value={countedAmount}
                onChange={(event) => setCountedAmount(event.target.value)}
                disabled={saving}
              />
            </label>

            <ClosingUtilityReadings
              sessionId={session?.id ?? ""}
              meters={utilityMeters}
              loading={utilitiesLoading}
              error={utilitiesError}
              disabled={saving}
              onChange={setClosingUtilitySubmission}
            />

            {countHasDiscrepancy && (
              /* Apparition en fondu simple : pendant un comptage de caisse,
                 rien ne doit bouger sous les doigts de la personne qui saisit.
                 La lueur rouge est fixe, elle ne clignote pas. */
              <motion.label
                className="glow-danger glow-static flex flex-col gap-2 rounded-lg p-3 text-sm font-medium"
                htmlFor="discrepancy-reason"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={TRANSITION.enter}
              >
                Motif de l’écart obligatoire
                <Input
                  id="discrepancy-reason"
                  value={discrepancyReason}
                  onChange={(event) => setDiscrepancyReason(event.target.value)}
                  disabled={saving}
                />
              </motion.label>
            )}
            {mutation.error && <p className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setCloseDialogOpen(false)} disabled={saving}>
                Annuler
              </Button>
              <Button
                onClick={closeCashSession}
                disabled={saving || parsedCountedAmount == null || !closingUtilitySubmission.canClose || (countHasDiscrepancy && !discrepancyReason.trim())}
              >
                {saving ? "Clôture…" : "Confirmer la clôture"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </BaseLayout>
  )
}
