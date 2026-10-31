import * as React from "react"
import { Button } from "@/components/ui/button"
import { FrameFooter } from "@/components/ui/frame"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Plus, Trash2 } from "lucide-react"
import type { WorkerInput, WorkersData } from "@/lib/onboarding-api"
import { saveStage } from "./save-stage"
import type { OnboardingWizardProps } from "./onboarding-wizard"

const ROLE_OPTIONS = [
  { value: "car_washer", label: "Laveur automobile" },
  { value: "moto_washer", label: "Laveur moto" },
  { value: "versatile_washer", label: "Laveur polyvalent" },
  { value: "team_lead", label: "Chef d'équipe" },
  { value: "custom", label: "Autre fonction…" },
]

const EMPTY: WorkerInput = {
  first_name: "",
  last_name: "",
  phone: "",
  district: "",
  role: "car_washer",
  custom_role: "",
  joined_at: "",
}

export function WorkersStep({ progress, onDone, onQuit }: OnboardingWizardProps) {
  const saved = progress?.workers_data
  const [workers, setWorkers] = React.useState<WorkerInput[]>(
    saved?.workers ?? []
  )
  const [errors, setErrors] = React.useState<Record<number, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const set = (i: number, k: keyof WorkerInput) => (v: string) =>
    setWorkers((prev) => prev.map((w, j) => (j === i ? { ...w, [k]: v } : w)))

  function validate(): boolean {
    const errs: Record<number, string> = {}
    workers.forEach((w, i) => {
      if (!w.first_name.trim() || !w.last_name.trim()) {
        errs[i] = "Nom et prénom obligatoires."
      } else if (w.role === "custom" && (!w.custom_role || w.custom_role.trim().length < 2)) {
        errs[i] = "Précisez la fonction personnalisée."
      }
    })
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function save(quit: boolean) {
    if (!quit && !validate()) return
    setSaving(true)
    setServerError(null)
    try {
      const response = await saveStage("workers", { workers } satisfies WorkersData, undefined, quit)
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
      {workers.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Aucun travailleur ajouté. Cliquez sur « Ajouter un travailleur » ou
          continuez directement si vous exercez seul.
        </p>
      )}

      {workers.map((w, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Travailleur {i + 1}</p>
            <div className="flex items-center gap-2">
              {errors[i] && <span className="text-destructive text-xs">{errors[i]}</span>}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Retirer le travailleur ${i + 1}`}
                onClick={() => setWorkers((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
          <FieldGroup className="grid gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`w-${i}-first`}>Prénom *</FieldLabel>
              <Input id={`w-${i}-first`} value={w.first_name} onChange={(e) => set(i, "first_name")(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`w-${i}-last`}>Nom *</FieldLabel>
              <Input id={`w-${i}-last`} value={w.last_name} onChange={(e) => set(i, "last_name")(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`w-${i}-phone`}>Téléphone</FieldLabel>
              <Input id={`w-${i}-phone`} value={w.phone ?? ""} onChange={(e) => set(i, "phone")(e.target.value)} placeholder="+225 …" />
            </Field>
            <Field>
              <FieldLabel htmlFor={`w-${i}-district`}>Quartier d'habitation</FieldLabel>
              <Input id={`w-${i}-district`} value={w.district ?? ""} onChange={(e) => set(i, "district")(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Fonction</FieldLabel>
              <Select value={w.role} onValueChange={(v) => set(i, "role")(String(v ?? "car_washer"))}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir une fonction" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {w.role === "custom" && (
              <Field>
                <FieldLabel htmlFor={`w-${i}-custom`}>Fonction personnalisée *</FieldLabel>
                <Input id={`w-${i}-custom`} value={w.custom_role ?? ""} onChange={(e) => set(i, "custom_role")(e.target.value)} />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`w-${i}-joined`}>Date d'entrée (facultatif)</FieldLabel>
              <Input id={`w-${i}-joined`} type="date" value={w.joined_at ?? ""} onChange={(e) => set(i, "joined_at")(e.target.value)} />
            </Field>
          </FieldGroup>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => setWorkers((prev) => [...prev, { ...EMPTY }])}
      >
        <Plus className="mr-2" /> Ajouter un travailleur
      </Button>

      {serverError && <p className="text-destructive text-sm">{serverError}</p>}

      <FrameFooter>
        <Button variant="ghost" onClick={() => save(true)} disabled={saving}>
          Enregistrer et quitter
        </Button>
        <Button onClick={() => save(false)} disabled={saving}>
          {saving ? "Enregistrement…" : "Continuer"}
        </Button>
      </FrameFooter>
    </div>
  )
}
