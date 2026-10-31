"use client"

import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { apiFetch, apiErrorMessage } from "@/lib/api"
import { toastSuccess, toastError } from "@/lib/toast"
import { RefreshCw, User } from "lucide-react"

const schema = z.object({
  first_name: z.string().trim().min(1, "Le prénom est obligatoire.").max(100),
  last_name: z.string().trim().min(1, "Le nom est obligatoire.").max(100),
  phone: z.string().trim().max(30).optional().nullable(),
  district: z.string().trim().max(120).optional().nullable(),
  role: z.enum(["car_washer", "moto_washer", "versatile_washer", "team_lead", "custom"], {
    error: "Choisissez un rôle.",
  }),
  custom_role: z.string().trim().max(100).optional().nullable(),
  joined_at: z.string().optional().nullable(),
})
type FormData = z.infer<typeof schema>

interface CreatedWorker {
  id: string
  first_name: string
  last_name: string
  phone: string | null
  district: string | null
  role: FormData["role"]
  custom_role: string | null
  joined_at: string | null
}

interface CreateWorkerModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onCreated?: (worker: CreatedWorker) => void
}

const ROLES = [
  { value: "car_washer", label: "Laveur auto" },
  { value: "moto_washer", label: "Laveur moto" },
  { value: "versatile_washer", label: "Polyvalent" },
  { value: "team_lead", label: "Responsable d'équipe" },
  { value: "custom", label: "Personnalisé" },
] as const

const EMPTY_VALUES: FormData = {
  first_name: "",
  last_name: "",
  phone: "",
  district: "",
  role: "car_washer",
  custom_role: "",
  joined_at: "",
}

export function CreateWorkerModal({
  open = false,
  onOpenChange,
  onCreated,
}: CreateWorkerModalProps) {
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_VALUES,
  })
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = form

  const role = watch("role")

  // Réinitialise le formulaire à chaque ouverture de la modale.
  useEffect(() => {
    if (open) reset(EMPTY_VALUES)
  }, [open, reset])

  async function onSubmit(data: FormData) {
    // Validation croisée : rôle personnalisé requis quand role === "custom"
    if (data.role === "custom" && (!data.custom_role || data.custom_role.trim().length < 2)) {
      toastError("Rôle personnalisé requis", "Précisez la fonction personnalisée (2 caractères minimum).")
      return
    }

    // Payload aligné sur ce que l'API attend (cf. src/app/team/page.tsx).
    const payload = {
      first_name: data.first_name.trim(),
      last_name: data.last_name.trim(),
      phone: data.phone?.trim() || null,
      district: data.district?.trim() || null,
      role: data.role,
      custom_role: data.role === "custom" ? data.custom_role?.trim() || null : null,
      joined_at: data.joined_at || null,
    }

    try {
      const response = await apiFetch("/api/v1/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response))
      }
      const worker: CreatedWorker = await response.json()
      toastSuccess("Travailleur ajouté", "Le travailleur a été créé avec succès.")
      onCreated?.(worker)
      onOpenChange?.(false)
    } catch (err) {
      toastError(
        "Échec de la création",
        err instanceof Error ? err.message : "Impossible d'ajouter le travailleur.",
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>Nouveau travailleur</DialogTitle>
          <DialogDescription>Ajoutez un employé à votre station de lavage.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="worker-first-name">Prénom *</Label>
              <Input id="worker-first-name" {...register("first_name")} placeholder="Jean" />
              {errors.first_name && (
                <span className="text-xs text-destructive">{errors.first_name.message}</span>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="worker-last-name">Nom *</Label>
              <Input id="worker-last-name" {...register("last_name")} placeholder="Koffi" />
              {errors.last_name && (
                <span className="text-xs text-destructive">{errors.last_name.message}</span>
              )}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="worker-phone">Téléphone</Label>
              <Input id="worker-phone" {...register("phone")} placeholder="+225 07 XX XX XX XX" />
              {errors.phone && (
                <span className="text-xs text-destructive">{errors.phone.message}</span>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="worker-district">Quartier</Label>
              <Input id="worker-district" {...register("district")} placeholder="Ex: Cocody" />
              {errors.district && (
                <span className="text-xs text-destructive">{errors.district.message}</span>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="worker-role">Rôle *</Label>
            <Select
              value={role}
              onValueChange={(value) => {
                setValue("role", value as FormData["role"], { shouldValidate: true })
                if (value !== "custom") setValue("custom_role", null)
              }}
            >
              <SelectTrigger id="worker-role">
                <SelectValue placeholder="Choisir un rôle…" />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.role && (
              <span className="text-xs text-destructive">{errors.role.message}</span>
            )}
          </div>
          {role === "custom" && (
            <div className="space-y-2">
              <Label htmlFor="worker-custom-role">Rôle personnalisé *</Label>
              <Input id="worker-custom-role" {...register("custom_role")} placeholder="Précisez le rôle…" />
              {errors.custom_role && (
                <span className="text-xs text-destructive">{errors.custom_role.message}</span>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <RefreshCw className="mr-2 size-4 animate-spin" />
              ) : (
                <User className="mr-2 size-4" />
              )}
              {isSubmitting ? "Ajout en cours…" : "Ajouter le travailleur"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
