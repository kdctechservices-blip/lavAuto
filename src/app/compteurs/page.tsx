"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  Droplets,
  Gauge,
  Plus,
  ReceiptText,
  RefreshCw,
  TriangleAlert,
  Zap,
} from "lucide-react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { BlockedReason } from "@/components/access/blocked-reason"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SubmitButton } from "@/components/ui/submit-button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { Textarea } from "@/components/ui/textarea"
import { UtilityInsightsPanel } from "@/components/utility-insights"
import { apiErrorMessage, apiFetch } from "@/lib/api"
import { EXPENSE_PAYMENT_METHODS } from "@/lib/expenses"
import { formatDate, formatXof } from "@/lib/format"
import { createIdempotencyKey } from "@/lib/idempotency"
import { useAccess } from "@/lib/permissions"
import { useMutation } from "@/lib/use-mutation"
import {
  UTILITY_PROVIDER_META,
  currentUtilityDate,
  currentUtilityMonth,
  formatUtilityIndex,
  formatUtilityQuantity,
  parseUtilityIndex,
  type UtilitiesOverview,
  type UtilityMeter,
  type UtilityProvider,
  type UtilityReading,
} from "@/lib/utilities"

interface Site {
  id: string
  name: string
  city: string | null
  is_active: boolean
}

interface CashSession {
  id: string
  site_id: string
  status: string
  opened_at: string
}

interface InvoiceDraft {
  amount: string
  expense_date: string
  payment_method: string
  reference: string
  cash_session_id: string
}

const SELECT_CLASS =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"

function invoiceDraft(date: string, sessions: CashSession[], siteId: string): InvoiceDraft {
  return {
    amount: "",
    expense_date: date,
    payment_method: "cash",
    reference: "",
    cash_session_id: sessions.find((session) => session.site_id === siteId)?.id ?? "",
  }
}

function validateInvoice(draft: InvoiceDraft) {
  if (!/^\d+$/.test(draft.amount.trim()) || Number(draft.amount) <= 0 || Number(draft.amount) > 1_000_000) {
    return { error: "Indiquez le montant réel de la facture, entre 1 et 1 000 000 F CFA.", invoice: null }
  }
  if (!draft.expense_date || draft.expense_date > currentUtilityDate()) {
    return { error: "La date de la facture est invalide ou située dans le futur.", invoice: null }
  }
  if (draft.payment_method === "cash" && !draft.cash_session_id) {
    return { error: "Sélectionnez une caisse ouverte pour un paiement en espèces.", invoice: null }
  }
  return {
    error: null,
    invoice: {
      amount_cents: Number(draft.amount) * 100,
      expense_date: draft.expense_date,
      payment_method: draft.payment_method,
      ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
      ...(draft.payment_method === "cash" ? { cash_session_id: draft.cash_session_id } : {}),
    },
  }
}

function InvoiceFields({
  draft,
  onChange,
  sessions,
  siteId,
  pending,
}: {
  draft: InvoiceDraft
  onChange: (draft: InvoiceDraft) => void
  sessions: CashSession[]
  siteId: string
  pending: boolean
}) {
  const siteSessions = sessions.filter((session) => session.site_id === siteId && session.status === "open")
  return (
    <div className="grid gap-4 rounded-lg border bg-muted/20 p-4">
      <div>
        <h3 className="font-medium">Facture fournisseur</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Le montant réel crée immédiatement une dépense « Factures » liée à ce relevé.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="invoice-amount">Montant (F CFA)</Label>
          <Input
            id="invoice-amount"
            inputMode="numeric"
            placeholder="Ex. 45 000"
            value={draft.amount}
            onChange={(event) => onChange({ ...draft, amount: event.target.value.replace(/[^0-9]/g, "") })}
            disabled={pending}
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invoice-date">Date de la facture</Label>
          <Input
            id="invoice-date"
            type="date"
            max={currentUtilityDate()}
            value={draft.expense_date}
            onChange={(event) => onChange({ ...draft, expense_date: event.target.value })}
            disabled={pending}
            required
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="invoice-payment">Paiement</Label>
          <select
            id="invoice-payment"
            className={SELECT_CLASS}
            value={draft.payment_method}
            onChange={(event) => onChange({ ...draft, payment_method: event.target.value })}
            disabled={pending}
          >
            {EXPENSE_PAYMENT_METHODS.map((method) => (
              <option key={method.value} value={method.value}>{method.label}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invoice-reference">N° de facture (facultatif)</Label>
          <Input
            id="invoice-reference"
            maxLength={120}
            value={draft.reference}
            onChange={(event) => onChange({ ...draft, reference: event.target.value })}
            disabled={pending}
          />
        </div>
      </div>
      {draft.payment_method === "cash" && (
        <div className="grid gap-2">
          <Label htmlFor="invoice-cash-session">Caisse de la station</Label>
          <select
            id="invoice-cash-session"
            className={SELECT_CLASS}
            value={draft.cash_session_id}
            onChange={(event) => onChange({ ...draft, cash_session_id: event.target.value })}
            disabled={pending || siteSessions.length === 0}
            required
          >
            <option value="">Sélectionner une caisse</option>
            {siteSessions.map((session) => (
              <option key={session.id} value={session.id}>
                Caisse ouverte le {formatDate(session.opened_at)}
              </option>
            ))}
          </select>
          {siteSessions.length === 0 && (
            <p className="text-xs text-warning">Aucune caisse ouverte pour cette station. Choisissez un autre paiement ou ouvrez la caisse.</p>
          )}
        </div>
      )}
    </div>
  )
}

function MeterDialog({
  sites,
  meters,
  initialSiteId,
  onClose,
  onSaved,
}: {
  sites: Site[]
  meters: UtilityMeter[]
  initialSiteId: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const availableSites = sites.filter((site) => site.is_active)
  const firstSite = availableSites.find((site) =>
    !["cie", "sodeci"].every((provider) => meters.some((meter) => meter.site_id === site.id && meter.provider === provider)),
  ) ?? availableSites[0]
  const [siteId, setSiteId] = useState(
    initialSiteId && availableSites.some((site) => site.id === initialSiteId) ? initialSiteId : firstSite?.id || "",
  )
  const initialProvider = (["cie", "sodeci"] as UtilityProvider[]).find(
    (provider) => !meters.some((meter) => meter.site_id === siteId && meter.provider === provider),
  ) ?? "cie"
  const [provider, setProvider] = useState<UtilityProvider>(initialProvider)
  const [meterNumber, setMeterNumber] = useState("")
  const [requestKey] = useState(createIdempotencyKey)
  const save = useMutation()
  const inFlight = useRef(false)

  function changeSite(value: string) {
    setSiteId(value)
    const available = (["cie", "sodeci"] as UtilityProvider[]).find(
      (item) => !meters.some((meter) => meter.site_id === value && meter.provider === item),
    )
    if (available) setProvider(available)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    if (!siteId || meterNumber.trim().length < 2) {
      save.fail("Choisissez une station et indiquez le numéro du compteur.")
      return
    }
    if (meters.some((meter) => meter.site_id === siteId && meter.provider === provider)) {
      save.fail("Ce fournisseur a déjà un compteur dans cette station.")
      return
    }
    inFlight.current = true
    const outcome = await save.run({
      url: "/api/v1/utility-meters",
      body: { site_id: siteId, provider, meter_number: meterNumber.trim() },
      headers: { "Idempotency-Key": requestKey },
      success: "Compteur ajouté. Vous pouvez maintenant saisir son premier index.",
      failure: "Le compteur n'a pas pu être ajouté.",
    })
    inFlight.current = false
    if (outcome.ok) {
      await onSaved()
      onClose()
    }
  }

  const providerAlreadyConfigured = meters.some((meter) => meter.site_id === siteId && meter.provider === provider)
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.pending) onClose() }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!save.pending}>
        <DialogHeader>
          <DialogTitle>Ajouter un compteur</DialogTitle>
          <DialogDescription>Un compteur CIE et un compteur SODECI maximum par station.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="meter-site">Station</Label>
            <select id="meter-site" className={SELECT_CLASS} value={siteId} onChange={(event) => changeSite(event.target.value)} disabled={save.pending}>
              {availableSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="meter-provider">Fournisseur</Label>
            <select id="meter-provider" className={SELECT_CLASS} value={provider} onChange={(event) => setProvider(event.target.value as UtilityProvider)} disabled={save.pending}>
              {(["cie", "sodeci"] as UtilityProvider[]).map((item) => {
                const configured = meters.some((meter) => meter.site_id === siteId && meter.provider === item)
                return <option key={item} value={item} disabled={configured}>{UTILITY_PROVIDER_META[item].label} — {UTILITY_PROVIDER_META[item].resource}{configured ? " (déjà configuré)" : ""}</option>
              })}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="meter-number">Numéro du compteur</Label>
            <Input id="meter-number" autoFocus value={meterNumber} onChange={(event) => setMeterNumber(event.target.value)} maxLength={80} placeholder="Numéro indiqué sur la facture" disabled={save.pending} required />
          </div>
          {providerAlreadyConfigured && <p className="text-xs text-warning">Ce fournisseur est déjà configuré dans la station choisie.</p>}
          {save.error && <p role="alert" className="text-sm text-destructive">{save.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.pending}>Annuler</Button>
            <SubmitButton type="submit" pending={save.pending} disabled={!siteId || providerAlreadyConfigured} pendingLabel="Ajout…">Ajouter le compteur</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type EntryTarget =
  | { mode: "reading"; meter: UtilityMeter }
  | { mode: "invoice"; meter: UtilityMeter; reading: UtilityReading }

function EntryDialog({
  target,
  sessions,
  onClose,
  onSaved,
}: {
  target: EntryTarget
  sessions: CashSession[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const isInvoice = target.mode === "invoice"
  const reading = isInvoice ? target.reading : null
  const [readingDate, setReadingDate] = useState(currentUtilityDate)
  const [index, setIndex] = useState("")
  const [notes, setNotes] = useState("")
  const [withInvoice, setWithInvoice] = useState(false)
  const [invoice, setInvoice] = useState<InvoiceDraft>(() =>
    invoiceDraft(reading?.reading_date ?? currentUtilityDate(), sessions, target.meter.site_id),
  )
  const [requestKey] = useState(createIdempotencyKey)
  const save = useMutation()
  const inFlight = useRef(false)
  const meta = UTILITY_PROVIDER_META[target.meter.provider]

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    const parsedIndex = isInvoice ? 0 : parseUtilityIndex(index)
    if (!isInvoice && (parsedIndex == null || !readingDate || readingDate > currentUtilityDate())) {
      save.fail("Saisissez un index positif avec trois décimales maximum et une date qui n'est pas dans le futur.")
      return
    }
    const checkedInvoice = isInvoice || withInvoice ? validateInvoice(invoice) : { error: null, invoice: null }
    if (checkedInvoice.error) {
      save.fail(checkedInvoice.error)
      return
    }
    const url = isInvoice
      ? `/api/v1/utility-readings/${target.reading.id}/invoice`
      : `/api/v1/utility-meters/${target.meter.id}/readings`
    const payload = isInvoice
      ? checkedInvoice.invoice
      : {
          reading_date: readingDate,
          index_value: parsedIndex,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(checkedInvoice.invoice ? { invoice: checkedInvoice.invoice } : {}),
        }

    inFlight.current = true
    const outcome = await save.run({
      url,
      body: payload,
      headers: { "Idempotency-Key": requestKey },
      success: isInvoice
        ? "Facture comptabilisée dans les dépenses."
        : checkedInvoice.invoice
          ? "Relevé et facture enregistrés. La dépense est comptabilisée une seule fois."
          : "Relevé enregistré. La consommation a été recalculée.",
      failure: isInvoice ? "La facture n'a pas pu être comptabilisée." : "Le relevé n'a pas pu être enregistré.",
    })
    inFlight.current = false
    if (outcome.ok) {
      await onSaved()
      onClose()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.pending) onClose() }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl" showCloseButton={!save.pending}>
        <DialogHeader>
          <DialogTitle>{isInvoice ? "Comptabiliser la facture" : `Relever le compteur ${meta.label}`}</DialogTitle>
          <DialogDescription>
            {target.meter.site_name} · compteur {target.meter.meter_number} · index en {meta.unit}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          {isInvoice ? (
            <div className="rounded-lg bg-muted/40 p-3 text-sm">
              Relevé du {formatDate(target.reading.reading_date)} : <strong>{formatUtilityIndex(target.reading.index_milli)} {meta.unit}</strong>
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="reading-date">Date du relevé</Label>
                  <Input id="reading-date" type="date" max={currentUtilityDate()} value={readingDate} onChange={(event) => setReadingDate(event.target.value)} disabled={save.pending} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="reading-index">Nouvel index ({meta.unit})</Label>
                  <Input id="reading-index" inputMode="decimal" autoFocus placeholder="Ex. 1250,500" value={index} onChange={(event) => setIndex(event.target.value)} disabled={save.pending} required />
                </div>
              </div>
              {target.meter.latest_reading && (
                <p className="text-xs text-muted-foreground">
                  Dernier index connu : {formatUtilityIndex(target.meter.latest_reading.index_milli)} {meta.unit}, le {formatDate(target.meter.latest_reading.reading_date)}. Un relevé antérieur est accepté s’il respecte la chronologie.
                </p>
              )}
              <div className="grid gap-2">
                <Label htmlFor="reading-notes">Note (facultative)</Label>
                <Textarea id="reading-notes" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={save.pending} placeholder="Précision utile sur le relevé" />
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
                <input type="checkbox" className="mt-1 size-4" checked={withInvoice} onChange={(event) => setWithInvoice(event.target.checked)} disabled={save.pending} />
                <span>
                  <span className="block font-medium">Saisir la facture en même temps</span>
                  <span className="block text-xs text-muted-foreground">La dépense sera créée automatiquement, sans ressaisie.</span>
                </span>
              </label>
            </>
          )}
          {(isInvoice || withInvoice) && (
            <InvoiceFields draft={invoice} onChange={setInvoice} sessions={sessions} siteId={target.meter.site_id} pending={save.pending} />
          )}
          {save.error && <p role="alert" className="text-sm text-destructive">{save.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.pending}>Annuler</Button>
            <SubmitButton type="submit" pending={save.pending} pendingLabel="Enregistrement…">
              {isInvoice ? "Comptabiliser la facture" : "Enregistrer le relevé"}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function UtilityMetersPage() {
  const createAccess = useAccess("expense:create")
  const [month, setMonth] = useState(currentUtilityMonth)
  const [siteId, setSiteId] = useState("")
  const [overview, setOverview] = useState<UtilitiesOverview | null>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [sessions, setSessions] = useState<CashSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [meterDialogOpen, setMeterDialogOpen] = useState(false)
  const [entry, setEntry] = useState<EntryTarget | null>(null)
  const [insightsRefreshKey, setInsightsRefreshKey] = useState(0)
  const loadSequence = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setInsightsRefreshKey(sequence)
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams({ month })
      if (siteId) query.set("site_id", siteId)
      const [utilityResponse, siteResponse, sessionResponse] = await Promise.all([
        apiFetch(`/api/v1/utilities?${query}`),
        apiFetch("/api/v1/sites"),
        apiFetch("/api/v1/cash-sessions?status=open"),
      ])
      if (!utilityResponse.ok) throw new Error(await apiErrorMessage(utilityResponse))
      if (!siteResponse.ok) throw new Error(await apiErrorMessage(siteResponse))
      const [utilityData, siteData, sessionData] = await Promise.all([
        utilityResponse.json() as Promise<UtilitiesOverview>,
        siteResponse.json() as Promise<Site[]>,
        sessionResponse.ok ? sessionResponse.json() as Promise<CashSession[]> : Promise.resolve([]),
      ])
      if (sequence !== loadSequence.current) return
      setOverview(utilityData)
      setSites(siteData)
      setSessions(sessionData)
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setError(reason instanceof Error ? reason.message : "Impossible de charger les compteurs.")
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [month, siteId])

  useEffect(() => {
    ;(async () => { await load() })()
  }, [load])

  const meters = overview?.meters ?? []
  const canWrite = createAccess.allowed && !createAccess.loading
  const activeSites = sites.filter((site) => site.is_active)

  return (
    <BaseLayout>
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Gauge className="size-4" /> Finance · Compteurs</div>
            <h1 className="text-2xl font-semibold tracking-tight">Compteurs CIE & SODECI</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Suivez les consommations réelles et comptabilisez les factures sans les ressaisir dans les dépenses.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" render={<Link to="/expenses" />}>Voir les dépenses <ArrowRight /></Button>
            <Button variant="outline" onClick={() => setMeterDialogOpen(true)} disabled={!canWrite || activeSites.length === 0}><Plus /> Ajouter un compteur</Button>
            <Button onClick={() => meters[0] && setEntry({ mode: "reading", meter: meters[0] })} disabled={!canWrite || meters.length === 0}><Gauge /> Nouveau relevé</Button>
          </div>
        </div>
        <BlockedReason reason={createAccess.reason} />

        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-2 sm:max-w-xs">
            <Label htmlFor="utilities-site">Station</Label>
            <select id="utilities-site" className={SELECT_CLASS} value={siteId} onChange={(event) => setSiteId(event.target.value)}>
              <option value="">Toutes les stations</option>
              {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </div>
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="utilities-month">Mois analysé</Label>
            <Input id="utilities-month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </div>
          <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} aria-label="Actualiser les compteurs"><RefreshCw className={loading ? "animate-spin" : ""} /></Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Les compteurs n'ont pas pu être chargés</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader><CardDescription>Consommation CIE · {month}</CardDescription><CardTitle className="text-2xl">{formatUtilityQuantity(overview?.totals.electricity_milli ?? 0, "cie")}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Consommation SODECI · {month}</CardDescription><CardTitle className="text-2xl">{formatUtilityQuantity(overview?.totals.water_milli ?? 0, "sodeci")}</CardTitle></CardHeader>
          </Card>
          <Card>
            <CardHeader><CardDescription>Factures comptabilisées · {month}</CardDescription><CardTitle className="text-2xl">{formatXof(overview?.totals.invoiced_cents ?? 0)}</CardTitle></CardHeader>
          </Card>
        </div>

        <UtilityInsightsPanel siteId={siteId} refreshKey={insightsRefreshKey} />

        {loading && !overview ? (
          <Card><CardContent><TableSkeleton rows={4} cols={4} /></CardContent></Card>
        ) : meters.length === 0 ? (
          <Card>
            <EmptyState
              icon={Gauge}
              title="Aucun compteur dans cette vue"
              description="Ajoutez le compteur CIE ou SODECI de la station, puis saisissez un premier index comme point de départ."
              action={canWrite && activeSites.length > 0 ? <Button onClick={() => setMeterDialogOpen(true)}><Plus /> Ajouter un compteur</Button> : undefined}
            />
          </Card>
        ) : (
          <div className="grid gap-5 xl:grid-cols-2">
            {meters.map((meter) => {
              const meta = UTILITY_PROVIDER_META[meter.provider]
              const Icon = meter.provider === "cie" ? Zap : Droplets
              return (
                <Card key={meter.id} className="min-w-0">
                  <CardHeader className="border-b">
                    <div className="flex items-start gap-3">
                      <span className={`rounded-lg p-2 ${meter.provider === "cie" ? "bg-amber-500/10 text-amber-600" : "bg-sky-500/10 text-sky-600"}`}><Icon className="size-5" /></span>
                      <div>
                        <CardTitle>{meta.label} · {meter.site_name}</CardTitle>
                        <CardDescription>Compteur {meter.meter_number} · {meta.resource}</CardDescription>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setEntry({ mode: "reading", meter })} disabled={!canWrite}><Plus /> Relever</Button>
                  </CardHeader>
                  <CardContent className="grid gap-4 pt-4">
                    <div className="grid gap-3 rounded-lg bg-muted/30 p-3 text-sm sm:grid-cols-3">
                      <div><span className="block text-xs text-muted-foreground">Dernier index</span><strong>{meter.latest_reading ? `${formatUtilityIndex(meter.latest_reading.index_milli)} ${meta.unit}` : "—"}</strong></div>
                      <div><span className="block text-xs text-muted-foreground">Consommation du mois</span><strong>{formatUtilityQuantity(meter.month_consumption_milli, meter.provider)}</strong></div>
                      <div><span className="block text-xs text-muted-foreground">Factures du mois</span><strong>{formatXof(meter.month_invoiced_cents)}</strong></div>
                    </div>
                    {meter.latest_reading && <p className="text-xs text-muted-foreground">Dernier relevé le {formatDate(meter.latest_reading.reading_date)}</p>}
                    {meter.readings.length === 0 ? (
                      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Aucun relevé sur ce mois. Les index des autres mois restent conservés.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Index</TableHead><TableHead>Consommation</TableHead><TableHead>Facture</TableHead></TableRow></TableHeader>
                          <TableBody>
                            {meter.readings.map((reading) => (
                              <TableRow key={reading.id}>
                                <TableCell className="whitespace-nowrap">{formatDate(reading.reading_date)}</TableCell>
                                <TableCell className="whitespace-nowrap">{formatUtilityIndex(reading.index_milli)} {meta.unit}</TableCell>
                                <TableCell>{reading.consumption_milli == null ? <Badge variant="outline">Point de départ</Badge> : formatUtilityQuantity(reading.consumption_milli, meter.provider)}</TableCell>
                                <TableCell>
                                  {reading.expense ? (
                                    <div className="space-y-1">
                                      <span className="block whitespace-nowrap font-medium">{formatXof(reading.expense.amount_cents)}</span>
                                      <span className="block text-xs text-muted-foreground">{reading.expense.status === "cancelled" ? "Facture annulée" : `Dépense du ${formatDate(reading.expense.expense_date)}`}</span>
                                    </div>
                                  ) : canWrite ? (
                                    <Button size="sm" variant="ghost" onClick={() => setEntry({ mode: "invoice", meter, reading })}><ReceiptText /> Comptabiliser</Button>
                                  ) : <Badge variant="outline">Non saisie</Badge>}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          La consommation est la différence entre deux index chronologiques. Seules les factures réelles alimentent les dépenses et les rapports : aucun tarif n'est estimé.
        </p>
      </div>

      {meterDialogOpen && (
        <MeterDialog sites={sites} meters={meters} initialSiteId={siteId} onClose={() => setMeterDialogOpen(false)} onSaved={load} />
      )}
      {entry && (
        <EntryDialog key={`${entry.mode}-${entry.meter.id}-${entry.mode === "invoice" ? entry.reading.id : "new"}`} target={entry} sessions={sessions} onClose={() => setEntry(null)} onSaved={load} />
      )}
    </BaseLayout>
  )
}
