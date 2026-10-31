import * as React from "react"
import { Button } from "@/components/ui/button"
import { FrameFooter } from "@/components/ui/frame"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import type { StationData } from "@/lib/onboarding-api"
import { saveStage } from "./save-stage"
import type { OnboardingWizardProps } from "./onboarding-wizard"

export function StationStep({ progress, onDone, onQuit }: OnboardingWizardProps) {
  const saved = progress?.station_data
  const [values, setValues] = React.useState<StationData>({
    name: saved?.name ?? "",
    phone: saved?.phone ?? "",
    address: saved?.address ?? "",
    city: saved?.city ?? "",
    description: saved?.description ?? "",
    email: saved?.email ?? "",
  })
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const set = (k: keyof StationData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }))

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (values.name.trim().length < 2) errs.name = "Le nom de la station est obligatoire (2 caractères minimum)."
    if (!values.city.trim()) errs.city = "La ville ou commune est obligatoire."
    if (values.phone && !/^[+\d][\d\s-]{6,28}$/.test(values.phone)) errs.phone = "Numéro de téléphone invalide."
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function save(quit: boolean) {
    if (!quit && !validate()) return
    setSaving(true)
    setServerError(null)
    try {
      const response = await saveStage("station", values, undefined, quit)
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
    <div className="flex flex-col gap-4">
      <FieldGroup className="grid gap-4">
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="station-name">Nom de la station *</FieldLabel>
          <Input id="station-name" value={values.name} onChange={set("name")} placeholder="Ex. Star Wash Cocody" />
          {errors.name && <FieldError>{errors.name}</FieldError>}
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field data-invalid={!!errors.phone}>
            <FieldLabel htmlFor="station-phone">Téléphone professionnel</FieldLabel>
            <Input id="station-phone" value={values.phone ?? ""} onChange={set("phone")} placeholder="+225 07 00 00 00 00" />
            {errors.phone && <FieldError>{errors.phone}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="station-email">E-mail professionnel (facultatif)</FieldLabel>
            <Input id="station-email" type="email" value={values.email ?? ""} onChange={set("email")} placeholder="contact@station.ci" />
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="station-address">Adresse ou quartier</FieldLabel>
            <Input id="station-address" value={values.address ?? ""} onChange={set("address")} placeholder="Ex. Rue des Jardins, Angré" />
          </Field>
          <Field data-invalid={!!errors.city}>
            <FieldLabel htmlFor="station-city">Ville ou commune *</FieldLabel>
            <Input id="station-city" value={values.city} onChange={set("city")} placeholder="Ex. Abidjan — Cocody" />
            {errors.city && <FieldError>{errors.city}</FieldError>}
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="station-description">Description (facultatif)</FieldLabel>
          <Textarea id="station-description" value={values.description ?? ""} onChange={set("description")} placeholder="Décrivez votre station en quelques mots." />
        </Field>

        {serverError && (
          <p className="text-destructive text-sm">{serverError}</p>
        )}

      <FrameFooter>
        <Button variant="ghost" onClick={() => save(true)} disabled={saving}>
          Enregistrer et quitter
        </Button>
        <Button onClick={() => save(false)} disabled={saving}>
          {saving ? "Enregistrement…" : "Continuer"}
        </Button>
      </FrameFooter>
      </FieldGroup>
    </div>
  )
}
