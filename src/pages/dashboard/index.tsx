import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  CarFront,
  ChartNoAxesCombined,
  Plus,
  Receipt,
  RefreshCw,
  Settings2,
  Wallet,
  Banknote,
  Clock3,
  Download,
  ArrowUpRight,
  AlertTriangle,
  ClipboardList,
  Package,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { CButton, CButtonGroup, CCol, CProgress, CRow, CWidgetStatsA } from '@coreui/react'

import { BaseLayout } from '@/components/layouts/base-layout'
import {
  Pressable,
  Stagger,
  StaggerItem,
  Surface,
} from '@/components/ui/motion'
import { DashboardMetrics } from '@/components/dashboard-metrics'
import { useOnboardingStatus } from '@/lib/onboarding-api'
import { useApi } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedNumber } from '@/components/ui/animated-number'
import { Sparkline } from '@/components/ui/sparkline'
import { Button } from '@/components/ui/button'
import { NewWashButton } from '@/components/actions/new-wash-button'
import { MetricLabel } from '@/components/ui/info-tooltip'
import { ActivityFeed } from '@/components/activity/activity-feed'
import { formatXof, formatDate } from '@/lib/format'
import type { Plan } from '@/lib/onboarding-api'

type Period = 'today' | '7days' | '30days'

type DashboardSummary = {
  plan: Plan | null
}

/** Réponse de GET /api/v1/reports/summary (montants en centimes XOF). */
type ReportsSummary = {
  period: { from: string; to: string }
  summary: {
    total_washes: number
    completed_washes: number
    paid_washes: number
    unpaid_washes: number
    revenue_cents: number
    /** Encaissements mobile money encore à confirmer. */
    pending_cents: number
    expenses_cents: number
    net_cents: number
  }
  series: Array<{
    date: string
    wash_count: number
    revenue_cents: number
    expenses_cents: number
  }>
}

type CashSession = {
  id: string
  status: 'open' | 'closed'
  opened_at: string
  opening_amount_cents: number
  theoretical_balance_cents: number
}

const PERIOD_LABELS: Record<Period, string> = {
  today: "Aujourd'hui",
  '7days': '7 derniers jours',
  '30days': '30 derniers jours',
}

const PERIOD_SHORT_LABELS: Record<Period, string> = {
  today: 'Jour',
  '7days': '7 jours',
  '30days': '30 jours',
}

/** Nombre de jours couverts par la période, aujourd'hui inclus. */
const PERIOD_DAYS: Record<Period, number> = {
  today: 1,
  '7days': 7,
  '30days': 30,
}

/** Date locale au format AAAA-MM-JJ attendu par l'API (évite le décalage UTC). */
function toApiDate(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

function periodRange(period: Period) {
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - (PERIOD_DAYS[period] - 1))
  return { from: toApiDate(start), to: toApiDate(today) }
}

/**
 * Les montants API sont en centimes. La mise en forme vient de `lib/format` :
 * une seule unité (« F CFA »), une seule locale, dans toute l'application.
 */
function formatFCFA(cents: number | null | undefined) {
  return formatXof(cents)
}

function formatCount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('fr-FR').format(value)
}

function formatDayLabel(isoDate: string) {
  const parsed = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return isoDate
  return parsed.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
}

function SummaryCard({
  title,
  value,
  unit,
  description,
  icon: Icon,
  loading = false,
  color,
  trend,
  explanation,
}: {
  title: string
  /** Valeur brute (centimes ou compteur) animée à l'affichage. */
  value: number | null | undefined
  /** Mise en forme appliquée à la valeur animée. */
  unit: (value: number) => string
  description: string
  icon: React.ElementType
  loading?: boolean
  color: 'primary' | 'info' | 'warning' | 'danger'
  /** Série journalière réelle de la période. */
  trend?: number[]
  /** Définition de la métrique : ce qui est compté, et ce qui ne l'est pas. */
  explanation?: React.ReactNode
}) {
  return (
    <CWidgetStatsA
      color={color}
      className="mb-4"
      aria-busy={loading || undefined}
      value={loading
        ? <Skeleton className="h-7 w-32 bg-white/25" />
        : <span className="coreui-widget-value"><AnimatedNumber value={value} format={unit} /></span>}
      title={(
        <>
          {explanation ? (
            <MetricLabel label={title} explanation={explanation} className="text-white/90" />
          ) : title}
          <p className="coreui-widget-description">{description}</p>
        </>
      )}
      action={<Icon className="coreui-widget-icon" aria-hidden="true" />}
      chart={(
        <div className="coreui-widget-chart" aria-hidden="true">
          {!loading && trend && trend.length > 1 && (
            <Sparkline values={trend} width={320} height={70} stroke="rgba(255,255,255,0.9)" />
          )}
        </div>
      )}
    />
  )
}

function QuickAction({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: React.ElementType
  title: string
  description: string
  href: string
}) {
  return (
    <StaggerItem className="h-full">
      <Pressable className="h-full">
        <Link
          to={href}
          viewTransition
          className="surface-3d glow-primary group flex h-full items-center gap-3 rounded-xl border bg-card p-4 hover:border-primary/40"
        >
          <span className="edge-3d rounded-xl bg-primary/10 p-3 text-primary transition-transform duration-150 ease-out group-hover:scale-110">
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {description}
            </span>
          </span>
          <Plus className="size-4 text-muted-foreground transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
        </Link>
      </Pressable>
    </StaggerItem>
  )
}

/**
 * Dashboard dynamique (§10 du WORKFLOW) : personnalisé selon la station
 * active — nom réel, ville, coordonnées — avec les métriques calculées à
 * partir des données opérationnelles réelles (aucun chiffre inventé).
 */
export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>('today')
  const [refreshKey, setRefreshKey] = useState(0)
  // Mémorise que la courbe a déjà été tracée (évite de rejouer l'animation
  // à chaque changement de période : le lecteur suit la donnée, pas l'effet).
  const [chartAnimated, setChartAnimated] = useState(false)

  const { data: status, loading: statusLoading } = useOnboardingStatus()
  const { data: summary, loading: summaryLoading } = useApi<DashboardSummary>(
    `/api/v1/onboarding/summary?refresh=${refreshKey}`
  )

  // Indicateurs financiers calculés par l'API sur la période sélectionnée.
  const range = useMemo(() => periodRange(period), [period])
  const {
    data: report,
    loading: reportLoading,
    error: reportError,
  } = useApi<ReportsSummary>(
    `/api/v1/reports/summary?from=${range.from}&to=${range.to}&refresh=${refreshKey}`
  )

  // État de la caisse de la station (session ouverte ou non).
  const { data: cashSession, loading: cashSessionLoading } =
    useApi<CashSession | null>(`/api/v1/cash-sessions/current?refresh=${refreshKey}`)

  const station = status?.station
  const plan = summary?.plan
  const totals = report?.summary ?? null
  // Le bouton « Actualiser » tourne tant qu'une requête du tableau de bord est en vol.
  const refreshing = summaryLoading || reportLoading

  const stationName =
    station?.name ?? status?.org_name ?? 'Votre station de lavage'

  const stationAddress = [
    station?.address,
    station?.city,
  ].filter(Boolean).join(', ')

  // Série quotidienne du graphique : montants convertis en FCFA.
  const revenueSeries = useMemo(
    () =>
      (report?.series ?? []).map((day) => ({
        date: day.date,
        label: formatDayLabel(day.date),
        revenue: Math.round(day.revenue_cents / 100),
        expenses: Math.round(day.expenses_cents / 100),
        washes: day.wash_count,
      })),
    [report]
  )
  const hasRevenueData = revenueSeries.some(
    (day) => day.revenue > 0 || day.expenses > 0 || day.washes > 0
  )
  const completionPercent = totals?.total_washes
    ? Math.round((totals.completed_washes / totals.total_washes) * 100)
    : 0
  const paidPercent = totals?.total_washes
    ? Math.round((totals.paid_washes / totals.total_washes) * 100)
    : 0
  const expenseRatio = totals?.revenue_cents
    ? Math.round((totals.expenses_cents / totals.revenue_cents) * 100)
    : 0

  // Actualise toutes les données du dashboard : ré-instancie les métriques
  // (DashboardMetrics est remonté via key) et re-télécharge les résumés API.
  function handleRefresh() {
    setRefreshKey((key) => key + 1)
  }

  /** Export CSV de la série quotidienne affichée (montants en FCFA). */
  function handleExport() {
    if (revenueSeries.length === 0) return
    const rows = [
      ['Date', 'Lavages', 'Recettes (FCFA)', 'Dépenses (FCFA)'],
      ...revenueSeries.map((day) => [
        day.date,
        String(day.washes),
        String(day.revenue),
        String(day.expenses),
      ]),
    ]
    const csv = rows.map((row) => row.join(';')).join('\n')
    const url = URL.createObjectURL(
      new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `washpilot-recettes-${range.from}_${range.to}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <BaseLayout
      title="Tableau de bord"
      description="Pilotez votre station de lavage en un coup d'œil."
    >
        <div className="flex min-w-0 flex-1 flex-col gap-6 p-4 md:p-6 xl:p-8">
        {/* Header */}
        <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Vue d'ensemble</Badge>
              {plan && (
                <Badge variant="secondary">Forfait {plan.name}</Badge>
              )}
            </div>

            {statusLoading ? (
              <>
                <Skeleton className="h-9 w-64" />
                <Skeleton className="h-4 w-72" />
              </>
            ) : (
              <>
                {/* Le titre de page est rendu par `BaseLayout` : ce salut
                    reste un sous-titre pour ne pas produire deux <h1>. */}
                <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  Bonjour, bienvenue chez {stationName}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {stationAddress ||
                    "Complétez les informations de votre station pour personnaliser votre espace."}
                  {station?.phone ? ` · ${station.phone}` : ''}
                </p>
              </>
            )}

            <p className="text-sm text-muted-foreground">
              Voici le suivi de votre activité. Les chiffres affichés dépendent
              des opérations réellement enregistrées.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="gap-2"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                className={`size-4 ${refreshing ? 'animate-spin' : ''}`}
              />
              Actualiser
            </Button>

            {/* Même action que l'en-tête et le raccourci N : `?new=1` ouvre
                directement le formulaire de lavage. */}
            <NewWashButton size="lg" className="h-9" />
          </div>
        </section>

        {/* Finance and operations overview */}
        <section aria-label="Finances et activité" className="space-y-5">
          {reportError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              Impossible de charger les indicateurs financiers : {reportError}
            </p>
          )}

          <CRow>
            <CCol xs={12} sm={6} xl={3}>
            <SummaryCard
              title="Recettes encaissées"
              value={totals?.revenue_cents}
              unit={formatFCFA}
              description="Paiements confirmés, hors opérations annulées."
              icon={Wallet}
              loading={reportLoading}
              color="primary"
              trend={revenueSeries.map((day) => day.revenue)}
              explanation="Somme des paiements confirmés sur la période, opérations annulées exclues. Un paiement mobile money en attente n'est pas compté avant confirmation."
            />
            </CCol>
            <CCol xs={12} sm={6} xl={3}>
            <SummaryCard
              title="Lavages réalisés"
              value={totals?.completed_washes}
              unit={formatCount}
              description={
                totals
                  ? `${formatCount(totals.total_washes)} lavage${totals.total_washes === 1 ? '' : 's'} enregistré${totals.total_washes === 1 ? '' : 's'} au total sur la période.`
                  : 'Nombre de lavages terminés sur la période.'
              }
              icon={CarFront}
              loading={reportLoading}
              color="info"
              trend={revenueSeries.map((day) => day.washes)}
              explanation="Lavages au statut « terminé » sur la période. Les lavages en cours et annulés ne sont pas inclus."
            />
            </CCol>
            <CCol xs={12} sm={6} xl={3}>
            <SummaryCard
              title="Dépenses enregistrées"
              value={totals?.expenses_cents}
              unit={formatFCFA}
              description="Sorties enregistrées dans le module des dépenses."
              icon={Receipt}
              loading={reportLoading}
              color="warning"
              trend={revenueSeries.map((day) => day.expenses)}
              explanation="Dépenses saisies dans le module Dépenses sur la période, quel que soit leur mode de règlement."
            />
            </CCol>
            <CCol xs={12} sm={6} xl={3}>
            <SummaryCard
              title="Solde opérationnel estimé"
              value={totals?.net_cents}
              unit={formatFCFA}
              description="Recettes moins dépenses enregistrées. Ce n'est pas un bénéfice comptable."
              icon={ChartNoAxesCombined}
              loading={reportLoading}
              color="danger"
              trend={revenueSeries.map((day) => day.revenue - day.expenses)}
              explanation="Recettes encaissées moins dépenses enregistrées. Ce n'est pas un bénéfice comptable : salaires, impôts et amortissements n'y figurent pas."
            />
            </CCol>
          </CRow>
        </section>

        {/* Activity panels */}
        <section className="grid gap-4 xl:grid-cols-3">
          <Surface elevation={1} className="p-5 xl:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Évolution des recettes</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Recettes et dépenses jour par jour · Du {formatDate(range.from, 'day')} au {formatDate(range.to, 'day')}.
                </p>
              </div>
              <div className="d-flex flex-wrap align-items-center gap-2">
                <CButtonGroup aria-label="Période d'analyse">
                  {(Object.keys(PERIOD_LABELS) as Period[]).map((key) => (
                    <CButton
                      key={key}
                      type="button"
                      color={period === key ? 'primary' : 'secondary'}
                      variant={period === key ? undefined : 'outline'}
                      active={period === key}
                      size="sm"
                      onClick={() => setPeriod(key)}
                    >
                      {PERIOD_SHORT_LABELS[key]}
                    </CButton>
                  ))}
                </CButtonGroup>
                <CButton
                  type="button"
                  color="primary"
                  variant="outline"
                  size="sm"
                  className="d-flex align-items-center gap-2"
                  onClick={handleExport}
                  disabled={revenueSeries.length === 0}
                >
                  <Download className="size-4" />
                  Exporter
                </CButton>
              </div>
            </div>

            {reportLoading ? (
              <Skeleton className="mt-6 h-52 w-full rounded-xl" />
            ) : hasRevenueData ? (
              <div className="mt-6 h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueSeries} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="dashboard-revenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#5856d6" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#5856d6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="dashboard-expenses" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#e55353" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#e55353" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                      width={70}
                      tickFormatter={(value: number) =>
                        new Intl.NumberFormat('fr-FR', { notation: 'compact' }).format(value)
                      }
                    />
                    <Tooltip
                      formatter={(value, name) => [
                        `${new Intl.NumberFormat('fr-FR').format(Number(value))} FCFA`,
                        name === 'revenue' ? 'Recettes' : 'Dépenses',
                      ]}
                      labelFormatter={(label) => `Journée du ${label}`}
                    />
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      stroke="#5856d6"
                      strokeWidth={2}
                      fill="url(#dashboard-revenue)"
                      // Tracé animé au premier affichage seulement : changer de
                      // période ne redessine pas la courbe depuis zéro.
                      isAnimationActive={!chartAnimated}
                      animationDuration={600}
                      animationEasing="ease-out"
                      onAnimationEnd={() => setChartAnimated(true)}
                    />
                    <Area
                      type="monotone"
                      dataKey="expenses"
                      stroke="#e55353"
                      strokeWidth={2}
                      fill="url(#dashboard-expenses)"
                      isAnimationActive={!chartAnimated}
                      animationDuration={600}
                      animationEasing="ease-out"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="mt-6 flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 p-6 text-center">
                <ChartNoAxesCombined className="float-soft size-9 text-muted-foreground" />
                <p className="mt-3 font-medium">Aucune opération sur la période</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Enregistrez des lavages ou des dépenses : la courbe se construit
                  automatiquement à partir de vos données réelles.
                </p>
              </div>
            )}

            <div className="coreui-chart-footer -mx-5 -mb-5 mt-6 border-t px-5 py-3">
              <CRow className="text-center">
                <CCol xs={4}>
                  <div className="text-body-secondary small">Lavages terminés</div>
                  <div className="fw-semibold text-truncate">
                    {totals ? `${formatCount(totals.completed_washes)} / ${formatCount(totals.total_washes)}` : '—'}
                  </div>
                  <CProgress thin className="mt-2" color="success" value={completionPercent} />
                </CCol>
                <CCol xs={4}>
                  <div className="text-body-secondary small">Lavages encaissés</div>
                  <div className="fw-semibold text-truncate">
                    {totals ? `${formatCount(totals.paid_washes)} / ${formatCount(totals.total_washes)}` : '—'}
                  </div>
                  <CProgress thin className="mt-2" color="info" value={paidPercent} />
                </CCol>
                <CCol xs={4}>
                  <div className="text-body-secondary small">Dépenses / recettes</div>
                  <div className="fw-semibold text-truncate">
                    {totals?.revenue_cents ? `${expenseRatio} %` : '—'}
                  </div>
                  <CProgress thin className="mt-2" color="warning" value={Math.min(expenseRatio, 100)} />
                </CCol>
              </CRow>
            </div>
          </Surface>

          <Surface elevation={1} className="p-5">
            <div className="flex items-center gap-2">
              <Activity className="size-5 text-muted-foreground" />
              <h2 className="font-semibold">État de la station</h2>
            </div>

            <div className="mt-5 space-y-4">
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-muted p-2">
                  <Banknote className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Session de caisse</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {cashSessionLoading
                      ? 'Vérification en cours…'
                      : cashSession
                        ? `Solde théorique ${formatFCFA(cashSession.theoretical_balance_cents)}.`
                        : 'Aucune caisse ouverte : ouvrez-en une avant les encaissements.'}
                  </p>
                </div>
                {cashSessionLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : (
                  <Badge variant={cashSession ? 'secondary' : 'outline'}>
                    {cashSession ? 'Ouverte' : 'Fermée'}
                  </Badge>
                )}
              </div>

              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-muted p-2">
                  <Clock3 className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Activité récente</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {reportLoading
                      ? 'Chargement des opérations…'
                      : totals
                        ? `${formatCount(totals.total_washes)} lavage${totals.total_washes === 1 ? '' : 's'} et ${formatCount(totals.paid_washes)} encaissement${totals.paid_washes === 1 ? '' : 's'} sur la période.`
                        : "L'historique sera affiché à partir des lavages enregistrés."}
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-muted p-2">
                  <Settings2 className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Configuration</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Vérifiez les prestations, les tarifs et les informations de la station.
                  </p>
                </div>
              </div>
            </div>
          </Surface>
        </section>

        {/* Action-first workspace: les décisions du jour avant les statistiques. */}
        <section aria-labelledby="priorites-du-jour" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-primary/10 p-2 text-primary">
                  <ClipboardList className="size-4" aria-hidden="true" />
                </span>
                <h2 id="priorites-du-jour" className="text-lg font-semibold tracking-tight">
                  Priorités du jour
                </h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Les actions opérationnelles à traiter en premier.
              </p>
            </div>
            <Badge variant="secondary">Vue action</Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Link
              to="/washes"
              viewTransition
              className="surface-3d group rounded-2xl bg-card p-4 transition-all duration-200 hover:-translate-y-1 hover:bg-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="rounded-xl bg-primary/15 p-2.5 text-primary transition-transform duration-200 group-hover:scale-110">
                  <CarFront className="size-5" aria-hidden="true" />
                </span>
                <ArrowUpRight className="size-4 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
              <p className="mt-4 font-semibold">Lavages en cours</p>
              <p className="mt-1 text-sm text-muted-foreground">Ouvrir la file et faire avancer les tâches.</p>
            </Link>

            <Link
              to="/cash-drawer"
              viewTransition
              className="surface-3d group rounded-2xl bg-card p-4 transition-all duration-200 hover:-translate-y-1 hover:bg-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <span className={`rounded-xl p-2.5 ${cashSession ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}`}>
                  <Banknote className="size-5" aria-hidden="true" />
                </span>
                <Badge variant={cashSession ? 'secondary' : 'outline'}>{cashSession ? 'Ouverte' : 'À ouvrir'}</Badge>
              </div>
              <p className="mt-4 font-semibold">Caisse</p>
              <p className="mt-1 text-sm text-muted-foreground">{cashSession ? `Solde ${formatFCFA(cashSession.theoretical_balance_cents)}.` : 'Ouvrez la caisse avant les encaissements.'}</p>
            </Link>

            <Link
              to="/stock"
              viewTransition
              className="surface-3d group rounded-2xl bg-card p-4 transition-all duration-200 hover:-translate-y-1 hover:bg-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="rounded-xl bg-muted p-2.5 text-warning transition-transform duration-200 group-hover:scale-110">
                  <Package className="size-5" aria-hidden="true" />
                </span>
                <AlertTriangle className="size-4 text-orange-500" aria-hidden="true" />
              </div>
              <p className="mt-4 font-semibold">Alerte stock</p>
              <p className="mt-1 text-sm text-muted-foreground">Vérifier les consommables et les seuils bas.</p>
            </Link>

            <Link
              to="/washes"
              viewTransition
              className="surface-3d group rounded-2xl bg-card p-4 transition-all duration-200 hover:-translate-y-1 hover:bg-accent"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="rounded-xl bg-muted p-2.5 text-warning transition-transform duration-200 group-hover:scale-110">
                  <Clock3 className="size-5" aria-hidden="true" />
                </span>
                <Badge variant="outline">À traiter</Badge>
              </div>
              <p className="mt-4 font-semibold">Tâches urgentes</p>
              <p className="mt-1 text-sm text-muted-foreground">Traiter les lavages en attente ou en dépassement.</p>
            </Link>
          </div>
        </section>

        {/* Secondary metrics: conservées plus bas pour ne pas masquer les actions. */}
        <section className="space-y-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Indicateurs clés</h2>
              <p className="text-sm text-muted-foreground">
                {PERIOD_LABELS[period]} · Synthèse de votre station
              </p>
            </div>
            <Badge variant="outline">Données opérationnelles</Badge>
          </div>

          {/* key force le re-chargement des métriques lors de l’actualisation */}
          <DashboardMetrics key={refreshKey} />
        </section>

        {/* Quick actions */}
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Raccourcis opérationnels
            </h2>
            <p className="text-sm text-muted-foreground">
              Accédez rapidement aux opérations quotidiennes.
            </p>
          </div>

          <Stagger className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" inView>
            {/* Chaque raccourci pointe vers l'élément correspondant du sidebar */}
            <QuickAction
              icon={CarFront}
              title="Enregistrer un lavage"
              description="Ajouter une prestation réalisée"
              href="/washes"
            />
            <QuickAction
              icon={Banknote}
              title="Gérer la caisse"
              description="Ouvrir, suivre ou clôturer"
              href="/cash-drawer"
            />
            <QuickAction
              icon={Receipt}
              title="Ajouter une dépense"
              description="Enregistrer une sortie d'argent"
              href="/expenses"
            />
            <QuickAction
              icon={ArrowUpRight}
              title="Consulter les rapports"
              description="Analyser les résultats"
              href="/reports"
            />
          </Stagger>
        </section>

        {/* Journal d'activité : la même source que la page Historique, pour
            que le tableau de bord ne « résume » jamais une activité qu'il
            n'a pas réellement lue. */}
        <section className="space-y-4" aria-labelledby="journal-activite">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="journal-activite" className="text-lg font-semibold tracking-tight">
                Journal d’activité récent
              </h2>
              <p className="text-sm text-muted-foreground">
                Les dernières opérations enregistrées par l’équipe, du plus récent au plus ancien.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/history" viewTransition />}
              className="gap-1.5"
            >
              Ouvrir l’historique
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          <ActivityFeed limit={6} />
        </section>

        {/* Subscription */}
        {plan && (
          <section className="elev-1 flex flex-col justify-between gap-4 rounded-2xl border bg-muted/20 p-5 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold">Votre abonnement WashPilot CI</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Forfait {plan.name}
                {plan.price_cents > 0
                  ? ' · Validation du paiement à vérifier'
                  : ' · Consultez les fonctionnalités de votre forfait'}
              </p>
            </div>
            <Link
              to="/settings/billing"
              viewTransition
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-background hover:bg-muted text-sm font-medium transition-all"
            >
              Gérer mon forfait
            </Link>
          </section>
        )}
      </div>
    </BaseLayout>
  )
}
