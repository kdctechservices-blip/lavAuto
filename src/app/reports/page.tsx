"use client"

import { useMemo, useState } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { AnimatedNumber } from "@/components/ui/animated-number"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MotionCard } from "@/components/ui/motion"
import { useApi } from "@/lib/api"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { useCapability } from "@/lib/subscription"
import type { ChartConfig } from "@/components/ui/chart"
import type { ReportGranularity, ReportResponse } from "@/lib/reporting-api"
import type { SiteRecord } from "@/lib/sites-api"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import { BarChart3, Download, Lock, Wallet, CarFront, Receipt, TrendingUp, History, Users, Clock, Building2 } from "lucide-react"

const chartConfig = {
  revenue: { label: "Encaissements", color: "#2563eb" },
  expenses: { label: "Dépenses", color: "#f97316" },
  washes: { label: "Lavages", color: "#0f766e" },
} satisfies ChartConfig

const paymentLabels: Record<string, string> = {
  cash: "Espèces",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  other: "Autre",
}

const expenseLabels: Record<string, string> = {
  supply: "Approvisionnement",
  salary: "Salaire",
  maintenance: "Maintenance",
  utilities: "Factures",
  rent: "Loyer",
  tax: "Impôts et taxes",
  marketing: "Marketing",
  other: "Autre",
}

function dateInAbidjan(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

function formatXof(cents: number) {
  return `${(cents / 100).toLocaleString("fr-CI", { maximumFractionDigits: 2 })} F CFA`
}

function formatDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("fr-CI", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
  })
}

const GRANULARITY_OPTIONS: { value: ReportGranularity; label: string; description: string }[] = [
  { value: "day", label: "Jour", description: "Rapport quotidien" },
  { value: "week", label: "Semaine", description: "Rapport hebdomadaire (lundi au dimanche)" },
  { value: "month", label: "Mois", description: "Rapport mensuel" },
]

/** Libellé d'un point de la série, adapté au pas choisi. */
function formatBucket(date: string, granularity: ReportGranularity) {
  const value = new Date(`${date}T00:00:00Z`)
  if (granularity === "month") {
    return value.toLocaleDateString("fr-CI", { timeZone: "UTC", month: "short", year: "2-digit" })
  }
  if (granularity === "week") {
    return `sem. ${formatDate(date)}`
  }
  return formatDate(date)
}

const ROLE_LABELS: Record<string, string> = {
  car_washer: "Laveur",
  versatile_washer: "Laveur polyvalent",
  team_lead: "Chef d’équipe",
  cashier: "Caissier",
  manager: "Responsable",
}

function formatChartXof(value: number) {
  return new Intl.NumberFormat("fr-CI", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function csvAmount(cents: number) {
  return (cents / 100).toLocaleString("fr-CI", { maximumFractionDigits: 2 })
}

function downloadReport(report: ReportResponse) {
  const rows: Array<Array<string | number>> = [
    ["WashPilot CI — Rapport d’activité"],
    ["Période", report.period.from, report.period.to],
    ["Granularité", GRANULARITY_OPTIONS.find((o) => o.value === report.granularity)?.label ?? report.granularity],
    ["Périmètre", report.site ? report.site.name : "Toutes les stations"],
    [],
    ["Synthèse", "Valeur", "Montant (XOF)"],
    ["Lavages enregistrés", report.summary.total_washes, ""],
    ["Lavages terminés", report.summary.completed_washes, ""],
    ["Encaissements", "", csvAmount(report.summary.revenue_cents)],
    ["Dont à confirmer (mobile money)", "", csvAmount(report.summary.pending_cents)],
    // Les lignes financières ne sont exportées que si le rôle y a accès.
    ...(report.financial_access
      ? [
          ["Dépenses enregistrées", "", csvAmount(report.summary.expenses_cents ?? 0)],
          ["Solde opérationnel", "", csvAmount(report.summary.net_cents ?? 0)],
        ]
      : []),
    [],
    ["Évolution", "Début", "Fin", "Lavages", "Encaissements (XOF)", "Dépenses (XOF)"],
    ...report.series.map((row) => [
      GRANULARITY_OPTIONS.find((o) => o.value === report.granularity)?.label ?? report.granularity,
      row.date,
      row.period_end,
      row.wash_count,
      csvAmount(row.revenue_cents),
      report.financial_access ? csvAmount(row.expenses_cents ?? 0) : "",
    ]),
    [],
    ["Prestations", "Lavages", "Quantités", "Montant des prestations (XOF)"],
    ...report.top_services.map((row) => [row.name, row.wash_count, row.quantity, csvAmount(row.amount_cents)]),
    [],
    ["Moyens de paiement", "Nombre", "Montant (XOF)", "Confirmé (XOF)", "À confirmer (XOF)"],
    ...report.payment_methods.map((row) => [
      paymentLabels[row.method] ?? row.method,
      row.payment_count,
      csvAmount(row.amount_cents),
      csvAmount(row.verified_cents),
      csvAmount(row.pending_cents),
    ]),
    [],
    ["Activité par laveur", "Rôle", "Lavages", "Chiffre d’affaires attribué (XOF)"],
    ...report.top_workers.map((row) => [row.name, ROLE_LABELS[row.role] ?? row.role, row.wash_count, csvAmount(row.amount_cents)]),
    ...(report.by_site.length > 1
      ? [
          [],
          [
            "Résultats par station",
            "Ville",
            "Lavages",
            "Encaissements (XOF)",
            "Dépenses (XOF)",
            "Solde (XOF)",
          ],
          ...report.by_site.map((row) => [
            row.site_name,
            row.city,
            row.wash_count,
            csvAmount(row.revenue_cents),
            report.financial_access ? csvAmount(row.expenses_cents ?? 0) : "",
            report.financial_access ? csvAmount(row.net_cents ?? 0) : "",
          ]),
        ]
      : []),
    ...(report.financial_access
      ? [
          [],
          ["Dépenses par catégorie", "Nombre", "Montant (XOF)"],
          ...report.expense_categories.map((row) => [
            expenseLabels[row.category] ?? row.category,
            row.expense_count,
            csvAmount(row.amount_cents),
          ]),
        ]
      : []),
  ]
  const content = `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}`
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  const scope = report.site
    ? `-${report.site.name.toLocaleLowerCase("fr-CI").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`
    : ""
  link.download = `washpilot-rapport${scope}-${report.granularity}-${report.period.from}-${report.period.to}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export default function ReportsPage() {
  const exportReports = useAccess("report:export", "reports.export")
  // Gardes de forfait. Le serveur refuse de toute façon ; l'interface évite
  // d'envoyer une requête vouée au 402 et explique pourquoi le bouton est gris.
  const advancedReports = useCapability("reports.advanced")
  const consolidatedReports = useCapability("reports.consolidated")
  const today = useMemo(() => dateInAbidjan(), [])
  const [from, setFrom] = useState(() => shiftDate(dateInAbidjan(), -29))
  const [to, setTo] = useState(today)
  const [granularity, setGranularity] = useState<ReportGranularity>("day")
  // "" = toutes les stations. Le filtre reste côté serveur : le navigateur
  // envoie un identifiant, il ne choisit jamais le périmètre tout seul.
  const [siteId, setSiteId] = useState("")
  const { data: sites } = useApi<SiteRecord[]>("/api/v1/sites")
  const hasValidRange = Boolean(from && to && from <= to)
  const reportPath = hasValidRange
    ? `/api/v1/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=${granularity}${
        siteId ? `&site_id=${encodeURIComponent(siteId)}` : ""
      }`
    : ""
  const { data, loading, error } = useApi<ReportResponse>(reportPath)

  // L'export ne modifie rien, mais il lui faut des données : la raison du
  // blocage n'est alors pas un droit, et le dire évite de faire croire à un
  // refus de permission.
  const reportExport = actionGate({
    loading: exportReports.loading,
    allowed: exportReports.allowed,
    reason: exportReports.reason,
    blockedBy: !hasValidRange
      ? "Choisissez une période valide : la date de début doit précéder la date de fin."
      : loading
        ? "Rapport en cours de chargement…"
        : !data
          ? "Aucun rapport à exporter pour cette période."
          : null,
  })
  // Le serveur renvoie null sur les champs financiers quand le rôle n'y a pas
  // droit : l'interface s'aligne sur sa décision plutôt que de la deviner.
  const financialAccess = data?.financial_access ?? false

  const chartData = useMemo(
    () => (data?.series ?? []).map((row) => ({
      date: row.date,
      wash_count: row.wash_count,
      revenue: row.revenue_cents / 100,
      expenses: (row.expenses_cents ?? 0) / 100,
    })),
    [data],
  )
  const activeGranularity = data?.granularity ?? granularity
  const selectableSites = useMemo(
    () => (sites ?? []).filter((site) => site.is_active || site.id === siteId),
    [sites, siteId],
  )
  const multiSite = selectableSites.length > 1
  const bySite = data?.by_site ?? []

  function choosePeriod(days: number) {
    const end = dateInAbidjan()
    setTo(end)
    setFrom(shiftDate(end, -(days - 1)))
  }

  /** Raccourcis métier : la semaine en cours, le mois en cours. */
  function chooseCurrentWeek() {
    const end = dateInAbidjan()
    const weekday = (new Date(`${end}T00:00:00Z`).getUTCDay() + 6) % 7 // lundi = 0
    setTo(end)
    setFrom(shiftDate(end, -weekday))
    setGranularity("day")
  }

  function chooseCurrentMonth() {
    const end = dateInAbidjan()
    setTo(end)
    setFrom(`${end.slice(0, 7)}-01`)
    setGranularity("day")
  }

  function chooseYearByMonth() {
    const end = dateInAbidjan()
    setTo(end)
    setFrom(shiftDate(end, -364))
    setGranularity("month")
  }

  return (
    <BaseLayout title="Rapports" description="Suivez les lavages, les encaissements et les dépenses enregistrés par votre station.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Période du rapport</h2>
            <p className="text-sm text-muted-foreground">Les journées sont calculées selon le fuseau Africa/Abidjan.</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => choosePeriod(1)}>Aujourd’hui</Button>
              <Button type="button" size="sm" variant="outline" onClick={chooseCurrentWeek}>Cette semaine</Button>
              <Button type="button" size="sm" variant="outline" onClick={chooseCurrentMonth}>Ce mois</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => choosePeriod(90)}>90 jours</Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!advancedReports.allowed}
                title={advancedReports.allowed ? undefined : (advancedReports.reason ?? undefined)}
                onClick={chooseYearByMonth}
              >
                12 mois
              </Button>
            </div>
            <div
              className="flex flex-col gap-1 text-xs font-medium text-muted-foreground"
              role="group"
              aria-label="Granularité du rapport"
            >
              Regroupement
              <div className="flex overflow-hidden rounded-md border">
                {GRANULARITY_OPTIONS.map((option) => {
                  // « Rapport quotidien » est la promesse Starter ; le
                  // regroupement par semaine ou par mois relève du forfait Pro.
                  const locked = option.value !== "day" && !advancedReports.allowed
                  return (
                    <button
                      key={option.value}
                      type="button"
                      title={locked ? (advancedReports.reason ?? undefined) : option.description}
                      aria-pressed={granularity === option.value}
                      disabled={locked}
                      onClick={() => setGranularity(option.value)}
                      className={`h-9 min-w-16 px-3 text-sm transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
                        granularity === option.value
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-foreground hover:bg-accent"
                      }`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Du
              <Input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} className="w-full sm:w-40" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Au
              <Input type="date" value={to} min={from || undefined} max={today} onChange={(event) => setTo(event.target.value)} className="w-full sm:w-40" />
            </label>
            {/* Affiché seulement en multi-stations : un filtre à une seule
                valeur n'apporte rien et encombre la barre. */}
            {multiSite && (
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                Station
                <select
                  value={siteId}
                  onChange={(event) => setSiteId(event.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground sm:w-48"
                >
                  <option value="">Toutes les stations</option>
                  {selectableSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                      {site.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={reportExport.disabled}
              aria-busy={reportExport.busy}
              title={reportExport.reason ?? undefined}
              onClick={() => data && exportReports.allowed && downloadReport(data)}
            >
              {!reportExport.denied ? (
                <Download className="mr-2 size-4" />
              ) : (
                <Lock className="mr-2 size-4" />
              )}{" "}
              Exporter CSV
            </Button>
          </div>
        </div>
        <BlockedReason reason={reportExport.reason} />

        {data?.restriction && (
          <p
            role="status"
            className="row-in flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <History className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>
              {data.restriction.message} Période affichée : du{" "}
              {new Date(data.period.from).toLocaleDateString("fr-CI")} au{" "}
              {new Date(data.period.to).toLocaleDateString("fr-CI")}.
            </span>
          </p>
        )}
        {data?.site && (
          <p role="status" className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              Rapport filtré sur <strong>{data.site.name}</strong>. Le tableau
              « Résultats par station » ci-dessous reste consolidé sur l’ensemble
              de l’organisation.
            </span>
          </p>
        )}
        {!hasValidRange && <p role="alert" className="text-sm text-destructive">La date de début doit être antérieure ou égale à la date de fin.</p>}
        {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard index={0} title="Lavages enregistrés" icon={<CarFront className="size-4 text-muted-foreground" />} value={data?.summary.total_washes} loading={loading} detail={data ? `${data.summary.completed_washes} terminé${data.summary.completed_washes === 1 ? "" : "s"}` : undefined} />
          <MetricCard index={1} title="Encaissements" icon={<Wallet className="size-4 text-muted-foreground" />} value={data?.summary.revenue_cents} loading={loading} money detail={data ? `${data.summary.paid_washes} lavage${data.summary.paid_washes === 1 ? "" : "s"} réglé${data.summary.paid_washes === 1 ? "" : "s"}${data.summary.pending_cents > 0 ? ` · ${formatXof(data.summary.pending_cents)} à confirmer` : ""}` : undefined} />
          {/* Dépenses et marge : réservées aux rôles disposant de report:financial. */}
          {financialAccess ? (
            <>
              <MetricCard index={2} title="Dépenses enregistrées" icon={<Receipt className="size-4 text-muted-foreground" />} value={data?.summary.expenses_cents ?? undefined} loading={loading} money />
              <MetricCard index={3} title="Solde opérationnel" icon={<TrendingUp className="size-4 text-muted-foreground" />} value={data?.summary.net_cents ?? undefined} loading={loading} money />
            </>
          ) : (
            <Card className="row-in sm:col-span-2" style={{ "--row": 2 } as React.CSSProperties}>
              <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
                <Lock className="size-4 shrink-0" aria-hidden="true" />
                Les dépenses et la marge de la station sont réservées au propriétaire.
              </CardContent>
            </Card>
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Encaissements et dépenses</CardTitle>
              <CardDescription>
                Montants enregistrés par {activeGranularity === "month" ? "mois" : activeGranularity === "week" ? "semaine" : "jour"}, en XOF.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-[280px] w-full" /> : data ? (
                <ChartContainer config={chartConfig} className="h-[280px] w-full">
                  <AreaChart data={chartData} margin={{ left: 8, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(value) => formatBucket(String(value), activeGranularity)} />
                    <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={formatChartXof} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, payload) => payload?.[0]?.payload?.date ? formatBucket(String(payload[0].payload.date), activeGranularity) : ""} formatter={(value, name) => [formatXof(Number(value) * 100), name === "revenue" ? "Encaissements" : name === "expenses" ? "Dépenses" : String(name)]} />} />
                    <Area dataKey="revenue" type="monotone" stroke="var(--color-revenue)" fill="var(--color-revenue)" fillOpacity={0.13} strokeWidth={2} animationDuration={600} animationEasing="ease-out" />
                    <Area dataKey="expenses" type="monotone" stroke="var(--color-expenses)" fill="var(--color-expenses)" fillOpacity={0.08} strokeWidth={2} animationDuration={600} animationEasing="ease-out" />
                    <ChartLegend content={<ChartLegendContent />} />
                  </AreaChart>
                </ChartContainer>
              ) : <EmptyReportState />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                Lavages par {activeGranularity === "month" ? "mois" : activeGranularity === "week" ? "semaine" : "jour"}
              </CardTitle>
              <CardDescription>Nombre d’opérations non annulées enregistrées.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-[280px] w-full" /> : data ? (
                <ChartContainer config={chartConfig} className="h-[280px] w-full">
                  <BarChart data={chartData} margin={{ left: 0, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(value) => formatBucket(String(value), activeGranularity)} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, payload) => payload?.[0]?.payload?.date ? formatBucket(String(payload[0].payload.date), activeGranularity) : ""} />} />
                    <Bar dataKey="wash_count" name="Lavages" fill="var(--color-washes)" radius={[4, 4, 0, 0]} animationDuration={600} animationEasing="ease-out" />
                  </BarChart>
                </ChartContainer>
              ) : <EmptyReportState />}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <BreakdownTable
            title="Prestations les plus réalisées"
            description="Montant calculé à partir des prix figés au moment du lavage."
            loading={loading}
            columns={["Prestation", "Lavages", "Quantité", "Montant"]}
            empty="Aucune prestation réalisée sur cette période."
            rows={(data?.top_services ?? []).map((row) => [row.name, row.wash_count, row.quantity, formatXof(row.amount_cents)])}
          />
          {financialAccess && (
          <BreakdownTable
            title="Dépenses par catégorie"
            description="Dépenses enregistrées et non annulées."
            loading={loading}
            columns={["Catégorie", "Opérations", "Montant"]}
            empty="Aucune dépense enregistrée sur cette période."
            rows={(data?.expense_categories ?? []).map((row) => [expenseLabels[row.category] ?? row.category, row.expense_count, formatXof(row.amount_cents)])}
          />)}
        </div>

        <BreakdownTable
          title="Encaissements par moyen de paiement"
          description="Espèces, Orange Money, MTN MoMo, Moov Money et Wave suivis séparément. La colonne « À confirmer » correspond aux paiements mobile money pas encore vérifiés."
          loading={loading}
          columns={["Moyen de paiement", "Paiements", "Montant", "Confirmé", "À confirmer"]}
          empty="Aucun encaissement sur cette période."
          icon={<Wallet className="size-4 text-muted-foreground" />}
          rows={(data?.payment_methods ?? []).map((row) => [
            paymentLabels[row.method] ?? row.method,
            row.payment_count,
            formatXof(row.amount_cents),
            formatXof(row.verified_cents),
            row.pending_cents > 0 ? formatXof(row.pending_cents) : "—",
          ])}
        />

        {multiSite && !consolidatedReports.allowed && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="size-4 text-muted-foreground" /> Résultats par station
              </CardTitle>
              <CardDescription>
                Comparez vos points de lavage côte à côte — lavages, encaissements,
                dépenses et solde — sur la même période.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <Lock className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 min-w-48">{consolidatedReports.reason}</span>
            </CardContent>
          </Card>
        )}

        {multiSite && consolidatedReports.allowed && (
          <BreakdownTable
            title="Résultats par station"
            description={
              financialAccess
                ? "Vue consolidée du propriétaire : chaque station sur la même période, quel que soit le filtre appliqué plus haut."
                : "Vue consolidée du propriétaire. Les dépenses et la marge sont réservées aux rôles qui y ont droit."
            }
            loading={loading}
            icon={<Building2 className="size-4 text-muted-foreground" />}
            columns={
              financialAccess
                ? ["Station", "Ville", "Lavages", "Encaissements", "Dépenses", "Solde"]
                : ["Station", "Ville", "Lavages", "Encaissements"]
            }
            empty="Aucune station active sur cette période."
            rows={bySite.map((row) =>
              financialAccess
                ? [
                    row.site_name,
                    row.city,
                    row.wash_count,
                    formatXof(row.revenue_cents),
                    formatXof(row.expenses_cents ?? 0),
                    formatXof(row.net_cents ?? 0),
                  ]
                : [row.site_name, row.city, row.wash_count, formatXof(row.revenue_cents)],
            )}
          />
        )}

        <BreakdownTable
          title="Activité par laveur"
          description="Lavages réalisés et chiffre d’affaires attribué. Lorsqu’une équipe intervient sur un lavage, le montant est réparti à parts égales."
          loading={loading}
          columns={["Laveur", "Rôle", "Lavages", "Chiffre d’affaires"]}
          empty="Aucun laveur affecté à un lavage sur cette période."
          icon={<Users className="size-4 text-muted-foreground" />}
          rows={(data?.top_workers ?? []).map((row) => [
            row.name,
            ROLE_LABELS[row.role] ?? row.role,
            row.wash_count,
            formatXof(row.amount_cents),
          ])}
        />

        {data && data.summary.pending_cents > 0 && (
          <p className="row-in flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <Clock className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>
              {formatXof(data.summary.pending_cents)} d’encaissements mobile money restent à confirmer sur cette
              période. Vérifiez-les depuis la page Encaissements pour fiabiliser vos chiffres.
            </span>
          </p>
        )}

        {data && data.summary.total_washes === 0 && data.summary.revenue_cents === 0 && data.summary.expenses_cents === 0 && (
          <p className="rounded-md border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
            Aucune opération n’a été enregistrée entre le {data.period.from} et le {data.period.to}.
          </p>
        )}
      </div>
    </BaseLayout>
  )
}

function MetricCard({
  title,
  icon,
  value,
  loading,
  money = false,
  detail,
  index = 0,
}: {
  title: string
  icon: React.ReactNode
  value: number | null | undefined
  loading: boolean
  money?: boolean
  detail?: string
  index?: number
}) {
  return (
    <MotionCard index={index} aria-busy={loading || undefined}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardDescription>{title}</CardDescription>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-8 w-32" /> : (
          <>
            <p className="text-2xl font-bold">
              <AnimatedNumber
                value={value}
                format={(amount) => (money ? formatXof(amount) : amount.toLocaleString("fr-CI"))}
              />
            </p>
            {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
          </>
        )}
      </CardContent>
    </MotionCard>
  )
}

function EmptyReportState() {
  return (
    <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed">
      <EmptyState
        icon={BarChart3}
        title="Aucune donnée sur cette période"
        description="Changez les dates ou enregistrez des opérations : les graphiques se construisent automatiquement."
      />
    </div>
  )
}

function BreakdownTable({
  title,
  description,
  columns,
  rows,
  empty,
  loading,
  icon,
}: {
  title: string
  description: string
  columns: string[]
  rows: Array<Array<string | number>>
  empty: string
  loading: boolean
  icon?: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{icon ?? <BarChart3 className="size-4" />}{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <TableSkeleton rows={4} cols={columns.length} label={`Chargement : ${title}`} /> : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow>{columns.map((column) => <TableHead key={column} className="text-center">{column}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow><TableCell colSpan={columns.length} className="h-20 text-center text-muted-foreground">{empty}</TableCell></TableRow>
                ) : rows.map((row, index) => (
                  <TableRow
                    key={`${title}-${index}`}
                    className="row-in"
                    style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                  >
                    {row.map((value, cellIndex) => <TableCell key={cellIndex} className="text-center">{value}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
