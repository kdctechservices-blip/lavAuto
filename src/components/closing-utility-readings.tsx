"use client"

import { useEffect, useMemo, useState, type ChangeEvent } from "react"
import { Camera, Loader2, RefreshCw, TriangleAlert, X } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { apiErrorMessage, apiFetch } from "@/lib/api"
import { formatDate } from "@/lib/format"
import { compressUtilityPhoto, type UtilityPhotoDraft } from "@/lib/utility-photo"
import {
  UTILITY_PROVIDER_META,
  currentUtilityDate,
  formatUtilityIndex,
  formatUtilityQuantity,
  formatUtilityRatio,
  parseUtilityIndex,
  type UtilityMeter,
  type UtilityPhotoInput,
  type UtilityPreview,
} from "@/lib/utilities"

export interface ClosingUtilityReadingPayload {
  meter_id: string
  index_value: number
  anomaly_comment?: string
  photo?: UtilityPhotoInput
}

export interface ClosingUtilitySubmission {
  readings: ClosingUtilityReadingPayload[]
  canClose: boolean
}

interface Props {
  sessionId: string
  meters: UtilityMeter[]
  loading: boolean
  error: string | null
  disabled: boolean
  onChange: (submission: ClosingUtilitySubmission) => void
}

function readingToday(meter: UtilityMeter) {
  const today = currentUtilityDate()
  return meter.readings.find((reading) => reading.reading_date === today) ?? null
}

export function ClosingUtilityReadings({ sessionId, meters, loading, error, disabled, onChange }: Props) {
  const [indexes, setIndexes] = useState<Record<string, string>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [photos, setPhotos] = useState<Record<string, UtilityPhotoDraft>>({})
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({})
  const [photoProcessing, setPhotoProcessing] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<{ fingerprint: string; data: UtilityPreview } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const readings = useMemo<ClosingUtilityReadingPayload[]>(() => {
    const result: ClosingUtilityReadingPayload[] = []
    for (const meter of meters) {
      const existing = readingToday(meter)
      const indexValue = existing
        ? existing.index_milli / 1000
        : parseUtilityIndex(indexes[meter.id] ?? "")
      if (indexValue == null) continue
      const comment = (comments[meter.id] ?? existing?.anomaly_comment ?? "").trim()
      const photo = photos[meter.id]
      result.push({
        meter_id: meter.id,
        index_value: indexValue,
        ...(comment ? { anomaly_comment: comment } : {}),
        ...(photo ? { photo: { mime_type: photo.mime_type, data_base64: photo.data_base64 } } : {}),
      })
    }
    return result
  }, [meters, indexes, comments, photos])

  const fingerprint = useMemo(
    () => JSON.stringify(readings.map((reading) => ({ meter_id: reading.meter_id, index_value: reading.index_value }))),
    [readings],
  )
  const complete = !loading && !error && readings.length === meters.length
  const previewFresh = preview?.fingerprint === fingerprint
  const processingPhoto = Object.values(photoProcessing).some(Boolean)
  const commentsComplete = !previewFresh || preview.data.readings.every((reading) => {
    if (!reading.alerts.length) return true
    return Boolean(comments[reading.meter_id]?.trim() || reading.anomaly_comment)
  })
  const canClose = complete && !processingPhoto && !previewLoading && (
    meters.length === 0 || (previewFresh && commentsComplete)
  )

  useEffect(() => {
    onChange({ readings, canClose })
  }, [readings, canClose, onChange])

  async function calculatePreview() {
    if (!complete || previewLoading) return
    setPreviewLoading(true)
    setPreviewError(null)
    const requestFingerprint = fingerprint
    try {
      const response = await apiFetch(`/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/utility-preview`, {
        method: "POST",
        body: JSON.stringify({
          utility_readings: readings.map((reading) => ({
            meter_id: reading.meter_id,
            index_value: reading.index_value,
          })),
        }),
      })
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      const data = await response.json() as UtilityPreview
      setPreview({ fingerprint: requestFingerprint, data })
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : "Impossible de calculer la consommation.")
    } finally {
      setPreviewLoading(false)
    }
  }

  async function selectPhoto(meterId: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.currentTarget.value = ""
    if (!file) return
    setPhotoProcessing((current) => ({ ...current, [meterId]: true }))
    setPhotoErrors((current) => ({ ...current, [meterId]: "" }))
    try {
      const photo = await compressUtilityPhoto(file)
      setPhotos((current) => ({ ...current, [meterId]: photo }))
    } catch (cause) {
      setPhotoErrors((current) => ({
        ...current,
        [meterId]: cause instanceof Error ? cause.message : "Impossible de préparer cette photo.",
      }))
    } finally {
      setPhotoProcessing((current) => ({ ...current, [meterId]: false }))
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <div>
        <h3 className="text-sm font-semibold">Relevés quotidiens des compteurs</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Relevez l'index réel après le dernier lavage. L'aperçu est obligatoire ; aucune facture ni dépense n'est créée à la clôture.
        </p>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Chargement des compteurs…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && meters.length === 0 && (
        <p className="text-sm text-muted-foreground">Aucun compteur CIE/SODECI configuré pour cette station.</p>
      )}

      {meters.map((meter) => {
        const meta = UTILITY_PROVIDER_META[meter.provider]
        const existing = readingToday(meter)
        const analysis = previewFresh
          ? preview.data.readings.find((reading) => reading.meter_id === meter.id) ?? null
          : null
        const photo = photos[meter.id]
        const comment = comments[meter.id] ?? existing?.anomaly_comment ?? ""
        return (
          <div key={meter.id} className="grid gap-3 rounded-md border bg-background p-3">
            <div className="grid gap-1.5">
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor={`closing-index-${meter.id}`}>
                {meta.label} · index du jour ({meta.unit})
                <Input
                  id={`closing-index-${meter.id}`}
                  inputMode="decimal"
                  placeholder={meter.latest_reading ? `Dernier index : ${formatUtilityIndex(meter.latest_reading.index_milli)}` : "Index affiché au compteur"}
                  value={existing ? String(existing.index_milli / 1000) : indexes[meter.id] ?? ""}
                  onChange={(event) => setIndexes((current) => ({ ...current, [meter.id]: event.target.value }))}
                  disabled={disabled || existing != null || photoProcessing[meter.id]}
                  required={!existing}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {existing
                  ? `Relevé du jour déjà enregistré : ${formatUtilityIndex(existing.index_milli)} ${meta.unit}.`
                  : meter.latest_reading
                    ? `Dernier index connu : ${formatUtilityIndex(meter.latest_reading.index_milli)} ${meta.unit}.`
                    : `Premier relevé du compteur ${meter.meter_number}.`}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium ${disabled || photoProcessing[meter.id] ? "pointer-events-none opacity-50" : "hover:bg-muted"}`}>
                {photoProcessing[meter.id] ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
                {photoProcessing[meter.id] ? "Compression…" : photo || existing?.has_photo ? "Remplacer la photo" : "Photo du compteur (facultative)"}
                <input
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  aria-label={`Photo du compteur ${meta.label}`}
                  disabled={disabled || photoProcessing[meter.id]}
                  onChange={(event) => selectPhoto(meter.id, event)}
                />
              </label>
              {photo && (
                <>
                  <img src={photo.preview_url} alt={`Aperçu du compteur ${meta.label}`} className="size-12 rounded border object-cover" />
                  <span className="text-xs text-muted-foreground">{Math.ceil(photo.byte_size / 1000)} Ko</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Retirer la photo ${meta.label}`}
                    disabled={disabled}
                    onClick={() => setPhotos((current) => {
                      const next = { ...current }
                      delete next[meter.id]
                      return next
                    })}
                  >
                    <X className="size-4" />
                  </Button>
                </>
              )}
              {!photo && existing?.has_photo && <Badge variant="outline">Justificatif déjà joint</Badge>}
            </div>
            {photoErrors[meter.id] && <p className="text-xs text-destructive">{photoErrors[meter.id]}</p>}

            {analysis && (
              <div className="grid gap-2 rounded-md bg-muted/40 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">Consommation : {formatUtilityQuantity(analysis.consumption_milli, meter.provider)}</span>
                  {analysis.period_days > 1 && <Badge variant="outline">{analysis.period_days} jours</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {analysis.period_days > 1
                    ? `Période réelle du ${formatDate(analysis.period_start)} au ${formatDate(analysis.period_end)}, sans répartition artificielle.`
                    : `Période du ${formatDate(analysis.period_start)}.`}
                  {" "}{analysis.wash_count} lavage{analysis.wash_count > 1 ? "s" : ""} terminé{analysis.wash_count > 1 ? "s" : ""} sur cette période.
                </p>
                <p><span className="text-muted-foreground">Ratio :</span> {formatUtilityRatio(analysis.ratio_per_wash, meter.provider)}</p>
                <p className="text-xs text-muted-foreground">
                  {analysis.baseline
                    ? `Référence mobile : ${formatUtilityRatio(analysis.baseline.ratio_per_wash, meter.provider)} (${analysis.baseline.reading_count} relevés).`
                    : "Référence en cours de constitution : quatorze jours d'historique, sept relevés de référence et cinq lavages sont nécessaires."}
                </p>
                {analysis.alerts.map((alert) => (
                  <Alert key={alert.code} className="border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200">
                    <TriangleAlert className="size-4" />
                    <AlertTitle>Consommation à vérifier</AlertTitle>
                    <AlertDescription>{alert.message}</AlertDescription>
                  </Alert>
                ))}
              </div>
            )}

            {analysis && (
              <label className="grid gap-1.5 text-xs font-medium" htmlFor={`anomaly-comment-${meter.id}`}>
                Vérification ou incident {analysis.alerts.length > 0 ? "(obligatoire)" : "(facultatif)"}
                <Textarea
                  id={`anomaly-comment-${meter.id}`}
                  rows={2}
                  maxLength={500}
                  placeholder={analysis.alerts.length > 0 ? "Ex. fuite recherchée, compteur vérifié, essai technique…" : "Note d'exploitation facultative"}
                  value={comment}
                  onChange={(event) => setComments((current) => ({ ...current, [meter.id]: event.target.value }))}
                  disabled={disabled}
                  required={analysis.alerts.length > 0}
                />
              </label>
            )}
          </div>
        )
      })}

      {preview && !previewFresh && (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          Un index a changé : actualisez l'aperçu avant la clôture.
        </p>
      )}
      {previewError && <p className="text-sm text-destructive">{previewError}</p>}
      {meters.length > 0 && (
        <Button
          type="button"
          variant="outline"
          onClick={calculatePreview}
          disabled={disabled || !complete || previewLoading || processingPhoto}
        >
          {previewLoading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
          {previewLoading ? "Calcul des consommations…" : preview ? "Actualiser l'aperçu" : "Calculer la consommation"}
        </Button>
      )}
    </div>
  )
}
