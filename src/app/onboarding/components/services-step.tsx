import * as React from "react"
import { useApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { FrameFooter } from "@/components/ui/frame"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import type {
  CatalogTemplate,
  CustomService,
  SelectedService,
  ServicesData,
} from "@/lib/onboarding-api"
import { saveStage } from "./save-stage"
import type { OnboardingWizardProps } from "./onboarding-wizard"

const formatXOF = (cents: number | null | undefined) =>
  cents == null ? "—"
    : `${(cents / 100).toLocaleString("fr-CI")} F CFA`

export function ServicesStep({ progress, onDone, onQuit }: OnboardingWizardProps) {
  const saved = progress?.services_data
  const { data: catalog, loading, error } = useApi<CatalogTemplate[]>(
    "/api/v1/service-catalog"
  )
  const [selected, setSelected] = React.useState<SelectedService[]>(
    saved?.selected ?? []
  )
  const [custom, setCustom] = React.useState<CustomService[]>(
    saved?.custom ?? []
  )
  const [newName, setNewName] = React.useState("")
  const [newPrice, setNewPrice] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const items = catalog ?? []

  function toggle(t: CatalogTemplate) {
    setSelected((prev) => {
      const exists = prev.some((s) => s.template_id === t.id)
      if (exists) return prev.filter((s) => s.template_id !== t.id)
      return [...prev, { template_id: t.id, name: t.name, price_cents: t.price_cents }]
    })
  }

  function addCustom() {
    const name = newName.trim()
    if (name.length < 2) return
    if (custom.some((c) => c.name.toLowerCase() === name.toLowerCase())) return
    const parsedPrice = newPrice ? Number(newPrice) : null
    if (parsedPrice !== null && (!Number.isFinite(parsedPrice) || parsedPrice < 0)) return
    const price = parsedPrice === null ? null : Math.round(parsedPrice * 100)
    setCustom((prev) => [...prev, { name, category: "autre", price_cents: price }])
    setNewName("")
    setNewPrice("")
  }

  async function save(quit: boolean) {
    if (!quit && selected.length === 0 && custom.length === 0) {
      setServerError("Sélectionnez ou ajoutez au moins une prestation pour continuer.")
      return
    }
    setSaving(true)
    setServerError(null)
    try {
      const response = await saveStage("services", {
        selected,
        custom,
      } satisfies ServicesData, undefined, quit)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Erreur ${response.status}`)
      }
      if (quit) await onQuit()
      else onDone()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {loading && (
        <div className="grid gap-3 md:grid-cols-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="grid gap-2 md:grid-cols-2">
        {items.map((t) => {
          const checked = selected.some((s) => s.template_id === t.id)
          return (
            <label
              key={t.id}
              className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50 has-[[data-state=checked]]:border-primary"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={() => toggle(t)}
              />
              <span className="flex-1 text-sm" title={t.description ?? undefined}>
                {t.name}
              </span>
              {t.duration_minutes ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t.duration_minutes} min
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">{formatXOF(t.price_cents)}</span>
            </label>
          )
        })}
      </div>

      {/* « Autre service » : prestation personnalisée, exclusivement rattachée à la station (§5) */}
      <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
        <p className="text-sm font-medium">Autre service</p>
        <p className="text-xs text-muted-foreground">
          Ajoutez une prestation propre à votre station (elle ne modifiera pas
          le catalogue général).
        </p>
        <FieldGroup className="grid gap-2 md:grid-cols-[1fr_140px_auto]">
          <Field>
            <FieldLabel htmlFor="custom-name" className="sr-only">Nom du service</FieldLabel>
            <Input
              id="custom-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nom du service personnalisé"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="custom-price" className="sr-only">Prix indicatif</FieldLabel>
            <Input
              id="custom-price"
              inputMode="numeric"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              placeholder="Prix (F CFA)"
            />
          </Field>
          <Button type="button" variant="outline" onClick={addCustom}>
            Ajouter
          </Button>
        </FieldGroup>
        {custom.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {custom.map((c, i) => (
              <Badge key={i} variant="secondary" className="gap-1">
                {c.name}
                {c.price_cents != null && ` — ${formatXOF(c.price_cents)}`}
                <button
                  type="button"
                  aria-label={`Retirer ${c.name}`}
                  className="ml-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setCustom((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {serverError && <p className="text-destructive text-sm">{serverError}</p>}

      <FrameFooter>
        <Button variant="ghost" onClick={() => save(true)} disabled={saving}>
          Enregistrer et quitter
        </Button>
        <Button
          onClick={() => save(false)}
          disabled={saving || (selected.length === 0 && custom.length === 0)}
        >
          {saving ? "Enregistrement…" : "Continuer"}
        </Button>
      </FrameFooter>
    </div>
  )
}
