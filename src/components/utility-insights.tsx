"use client"

import { useEffect, useMemo, useState } from "react"
import { CalendarDays, Camera, Droplets, Minus, TrendingDown, TrendingUp, TriangleAlert, Zap } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiErrorMessage, apiFetch, useApi } from "@/lib/api"
import { formatDate } from "@/lib/format"
import {
  UTILITY_PROVIDER_META,
  formatUtilityLitres,
  formatUtilityQuantity,
  formatUtilityRatio,
  formatUtilityTrend,
  type UtilityInsights,
  type UtilityPeriodInsight,
  type UtilityProvider,
  type UtilityProviderInsight,
} from "@/lib/utilities"

interface Props {
  siteId: string
  refreshKey: number
}

function TrendBadge({ value }: { value: number | null }) {
  const Icon = value == null || value === 0 ? Minus : value > 0 ? TrendingUp : TrendingDown
  const color = value == null
    ? "text-muted-foreground"
    : value > 0
      ? "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300"
      : value < 0
        ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
        : "text-muted-foreground"
  return <Badge variant="outline" className={color}><Icon className="size-3.5" />{formatUtilityTrend(value)}</Badge>
}

function ProviderSummary({ summary }: { summary: UtilityProviderInsight }) {
  const meta = UTILITY_PROVIDER_META[summary.provider]
  const Icon = summary.provider === "cie" ? Zap : Droplets
  return (
    <div className="grid gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-medium"><Icon className="size-4" />{meta.label}</p>
          <p className="mt-1 text-2xl font-semibold">{formatUtilityQuantity(summary.consumption_milli, summary.provider)}</p>
          {summary.provider === "sodeci" && summary.consumption_milli != null && (
            <p className="text-xs text-muted-foreground">soit {formatUtilityLitres(summary.consumption_milli)}</p>
          )}
        </div>
        <TrendBadge value={summary.ratio_trend_percent} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Moyenne mobile par lavage</p>
          <p className="mt-1 font-medium">{formatUtilityRatio(summary.ratio_per_wash, summary.provider)}</p>
          <p className="text-xs text-muted-foreground">{summary.wash_count} lavages sur les périodes mesurées</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Moyenne quotidienne sur 7 jours</p>
          <p className="mt-1 font-medium">{formatUtilityQuantity(summary.daily_average_milli, summary.provider)}</p>
          <p className="text-xs text-muted-foreground">{summary.reading_count} relevé{summary.reading_count > 1 ? "s" : ""} cette semaine</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {summary.missing_days > 0 && <Badge variant="outline">{summary.missing_days} jour{summary.missing_days > 1 ? "s" : ""} sans relevé</Badge>}
        {summary.multi_day_periods > 0 && <Badge variant="outline">{summary.multi_day_periods} période{summary.multi_day_periods > 1 ? "s" : ""} de plusieurs jours</Badge>}
        {summary.alert_count > 0 && <Badge className="bg-amber-500/15 text-amber-900 hover:bg-amber-500/15 dark:text-amber-200"><TriangleAlert className="size-3.5" />{summary.alert_count} alerte{summary.alert_count > 1 ? "s" : ""}</Badge>}
      </div>
    </div>
  )
}

function PeriodCell({ period, provider, onPhoto }: { period: UtilityPeriodInsight | null; provider: UtilityProvider; onPhoto: (period: UtilityPeriodInsight) => void }) {
  if (!period) return <span className="text-xs text-muted-foreground">Aucun relevé</span>
  return (
    <div className="grid min-w-36 gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium">{formatUtilityQuantity(period.consumption_milli, provider)}</span>
        {period.alerts.length > 0 && <TriangleAlert className="size-4 text-amber-600" aria-label="Alerte" />}
      </div>
      <span className="text-xs text-muted-foreground">{formatUtilityRatio(period.ratio_per_wash, provider)} · {period.wash_count} lavage{period.wash_count > 1 ? "s" : ""}</span>
      <div className="flex flex-wrap gap-1">
        {period.period_days > 1 && <Badge variant="outline" className="text-[10px]">{period.period_days} jours</Badge>}
        {period.has_photo && period.reading_id && (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Voir la photo ${UTILITY_PROVIDER_META[provider].label} du ${formatDate(period.reading_date)}`} onClick={() => onPhoto(period)}>
            <Camera className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

export function UtilityInsightsPanel({ siteId, refreshKey }: Props) {
  const path = siteId ? `/api/v1/utility-insights?site_id=${encodeURIComponent(siteId)}&refresh=${refreshKey}` : ""
  const { data, loading, error } = useApi<UtilityInsights>(path)
  const [selectedPhoto, setSelectedPhoto] = useState<UtilityPeriodInsight | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoLoading, setPhotoLoading] = useState(false)

  function openPhoto(period: UtilityPeriodInsight) {
    setPhotoUrl(null)
    setPhotoError(null)
    setPhotoLoading(true)
    setSelectedPhoto(period)
  }

  useEffect(() => {
    if (!selectedPhoto?.reading_id) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    ;(async () => {
      try {
        const response = await apiFetch(`/api/v1/utility-readings/${encodeURIComponent(selectedPhoto.reading_id!)}/photo`, { signal: controller.signal })
        if (!response.ok) throw new Error(await apiErrorMessage(response))
        objectUrl = URL.createObjectURL(await response.blob())
        if (!controller.signal.aborted) setPhotoUrl(objectUrl)
      } catch (cause) {
        if (!controller.signal.aborted) setPhotoError(cause instanceof Error ? cause.message : "Impossible de charger la photo.")
      } finally {
        if (!controller.signal.aborted) setPhotoLoading(false)
      }
    })()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [selectedPhoto])

  const alertPeriods = useMemo(
    () => data?.days.flatMap((day) => day.readings.filter((reading): reading is UtilityPeriodInsight => Boolean(reading?.alerts.length))) ?? [],
    [data],
  )

  if (!siteId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="size-4" />Pilotage sur sept jours</CardTitle>
          <CardDescription>Sélectionnez une station pour afficher les ratios par lavage, les tendances et les alertes de consommation.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (loading && !data) {
    return <Card><CardContent className="grid gap-3 pt-6"><Skeleton className="h-5 w-56" /><Skeleton className="h-32 w-full" /></CardContent></Card>
  }
  if (error) {
    return <Alert variant="destructive"><TriangleAlert /><AlertTitle>Synthèse indisponible</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
  }
  if (!data || data.providers.length === 0) return null

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="size-4" />Pilotage sur sept jours</CardTitle>
        <CardDescription>
          Du {formatDate(data.start_date)} au {formatDate(data.end_date)} · tendance par lavage comparée aux sept jours précédents.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 pt-5">
        <div className="grid gap-4 lg:grid-cols-2">
          {data.providers.map((summary) => <ProviderSummary key={summary.meter_id} summary={summary} />)}
        </div>

        {alertPeriods.length > 0 && (
          <div className="grid gap-3">
            <h3 className="text-sm font-semibold">Points à vérifier</h3>
            {alertPeriods.map((period) => (
              <Alert key={period.reading_id ?? `${period.meter_id}-${period.reading_date}`} className="border-amber-500/40 bg-amber-500/5">
                <TriangleAlert className="size-4 text-amber-600" />
                <AlertTitle>{UTILITY_PROVIDER_META[period.provider].label} · {formatDate(period.reading_date)}</AlertTitle>
                <AlertDescription className="grid gap-1.5">
                  {period.alerts.map((alert) => <p key={alert.code}>{alert.message}</p>)}
                  {period.anomaly_comment
                    ? <p className="text-xs"><span className="font-medium">Vérification :</span> {period.anomaly_comment}</p>
                    : <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Aucun commentaire de vérification enregistré.</p>}
                  {period.has_photo && period.reading_id && (
                    <Button type="button" variant="outline" size="sm" className="mt-1 w-fit" onClick={() => openPhoto(period)}><Camera className="size-4" />Voir le justificatif</Button>
                  )}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date / lavages</TableHead>
                <TableHead>CIE</TableHead>
                <TableHead>SODECI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.days.map((day) => (
                <TableRow key={day.date}>
                  <TableCell className="align-top">
                    <p className="font-medium">{formatDate(day.date)}</p>
                    <p className="text-xs text-muted-foreground">{day.wash_count} lavage{day.wash_count > 1 ? "s" : ""} ce jour</p>
                    {day.wash_count === 0 && <Badge variant="outline" className="mt-1 text-[10px]">Jour sans lavage</Badge>}
                  </TableCell>
                  {(["cie", "sodeci"] as const).map((provider) => {
                    const period = day.readings.find((reading) => reading?.provider === provider) ?? null
                    return <TableCell key={provider} className="align-top"><PeriodCell period={period} provider={provider} onPhoto={openPhoto} /></TableCell>
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Chaque consommation et chaque ratio utilisent les lavages de la même période entre deux index. Une période de plusieurs jours reste identifiée et n'est jamais répartie artificiellement. Les ratios ne sont ni des tarifs ni des dépenses.
        </p>
      </CardContent>

      <Dialog open={selectedPhoto != null} onOpenChange={(open) => { if (!open) setSelectedPhoto(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Justificatif du compteur {selectedPhoto ? UTILITY_PROVIDER_META[selectedPhoto.provider].label : ""}</DialogTitle>
            <DialogDescription>{selectedPhoto ? `Relevé du ${formatDate(selectedPhoto.reading_date)} · compteur ${selectedPhoto.meter_number}` : ""}</DialogDescription>
          </DialogHeader>
          {photoLoading && <Skeleton className="aspect-video w-full" />}
          {photoError && <p className="text-sm text-destructive">{photoError}</p>}
          {photoUrl && <img src={photoUrl} alt="Photo du cadran du compteur" className="max-h-[70vh] w-full rounded-md border object-contain" />}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
