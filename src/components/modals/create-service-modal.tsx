"use client"

import { useEffect, useState } from "react"
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
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { apiFetch, apiErrorMessage } from "@/lib/api"
import { createIdempotencyKey } from "@/lib/idempotency"
import { toastSuccess, toastError } from "@/lib/toast"
import { ConfirmModal } from "./confirm-modal"
import { RefreshCw, Plus, Pencil, Trash2 } from "lucide-react"

const serviceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Le nom de la prestation est requis")
    .max(120, "Le nom ne peut pas dépasser 120 caractères"),
  description: z
    .string()
    .max(1000, "La description ne peut pas dépasser 1000 caractères")
    .optional()
    .nullable(),
  category_id: z.string().uuid("Veuillez sélectionner une catégorie valide").optional().nullable(),
  // L'utilisateur saisit un prix en XOF ; il est converti en centimes avant l'envoi.
  price_xof: z.coerce
    .number({ message: "Saisissez un prix valide." })
    .int("Le prix doit être un nombre entier.")
    .min(0, "Le prix ne peut pas être négatif"),
  duration_minutes: z.coerce
    .number({ message: "Saisissez une durée valide." })
    .int("La durée doit être un nombre entier de minutes.")
    .min(1, "La durée doit être d'au moins 1 minute")
    .max(1440, "La durée ne peut pas dépasser 24h")
    .optional()
    .nullable(),
  is_active: z.boolean().default(true),
})

type ServiceFormInput = z.input<typeof serviceSchema>
type ServiceFormData = z.output<typeof serviceSchema>

interface ServiceCategory {
  id: string
  name: string
}

interface Service {
  id: string
  name: string
  description: string | null
  category_id: string | null
  price_cents: number
  duration_minutes: number | null
  is_active: boolean
}

interface CreateServiceModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** When provided, the modal switches to edit mode (PATCH + delete). */
  service?: Service | null
  onServiceCreated?: (service: Service) => void
  onServiceUpdated?: (service: Service) => void
  onServiceDeleted?: (serviceId: string) => void
}

const DEFAULT_VALUES = {
  name: "",
  description: "",
  category_id: "",
  price_xof: 0,
  duration_minutes: undefined as ServiceFormData["duration_minutes"],
  is_active: true,
}

export function CreateServiceModal({
  open = false,
  onOpenChange,
  service = null,
  onServiceCreated,
  onServiceUpdated,
  onServiceDeleted,
}: CreateServiceModalProps) {
  const [categories, setCategories] = useState<ServiceCategory[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isEditing = Boolean(service)

  const form = useForm<ServiceFormInput, unknown, ServiceFormData>({
    resolver: zodResolver(serviceSchema),
    defaultValues: DEFAULT_VALUES,
  })

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form

  // Charger les catégories à l'ouverture de la modale
  useEffect(() => {
    if (!open) return

    let cancelled = false
    setMutationError(null)

    async function loadCategories() {
      setIsLoading(true)
      try {
        const res = await apiFetch("/api/v1/service-categories")
        if (cancelled) return
        if (res.ok) {
          setCategories((await res.json()) as ServiceCategory[])
        } else {
          toastError("Erreur", await apiErrorMessage(res))
        }
      } catch {
        if (!cancelled) toastError("Erreur", "Impossible de charger les catégories.")
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadCategories()
    return () => {
      cancelled = true
    }
  }, [open])

  // (Ré)initialiser le formulaire selon le mode create/edit à chaque ouverture.
  useEffect(() => {
    if (!open) return
    if (service) {
      reset({
        name: service.name,
        description: service.description ?? "",
        category_id: service.category_id ?? "",
        price_xof: service.price_cents / 100,
        duration_minutes: service.duration_minutes ?? undefined,
        is_active: service.is_active,
      })
    } else {
      reset(DEFAULT_VALUES)
    }
  }, [open, service, reset])

  const isActive = watch("is_active")

  async function onSubmit(data: ServiceFormData) {
    setMutationError(null)
    try {
      const payload = {
        name: data.name,
        description: data.description || null,
        category_id: data.category_id || null,
        price_cents: data.price_xof * 100,
        duration_minutes: data.duration_minutes || null,
        is_active: data.is_active,
      }
      const res = await apiFetch(
        isEditing ? `/api/v1/services/${encodeURIComponent(service!.id)}` : "/api/v1/services",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(isEditing ? {} : { "Idempotency-Key": createIdempotencyKey() }),
          },
          body: JSON.stringify(payload),
        },
      )

      if (!res.ok) {
        throw new Error(await apiErrorMessage(res))
      }

      const saved = (await res.json()) as Service
      if (isEditing) {
        toastSuccess("Prestation modifiée", "La prestation a été mise à jour avec succès.")
        onServiceUpdated?.(saved)
      } else {
        toastSuccess("Prestation créée", "La prestation a été créée avec succès.")
        onServiceCreated?.(saved)
      }
      onOpenChange?.(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Impossible d'enregistrer la prestation."
      setMutationError(message)
      toastError("Erreur", message)
    }
  }

  async function handleDelete() {
    if (!service) return
    setDeleting(true)
    try {
      const res = await apiFetch(`/api/v1/services/${encodeURIComponent(service!.id)}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(await apiErrorMessage(res))
      toastSuccess("Prestation supprimée", "La prestation a été supprimée.")
      onServiceDeleted?.(service.id)
      onOpenChange?.(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Impossible de supprimer la prestation."
      toastError("Erreur", message)
    } finally {
      setDeleting(false)
      setConfirmDeleteOpen(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Modifier la prestation" : "Créer une nouvelle prestation"}</DialogTitle>
          <DialogDescription>Définissez le nom, la catégorie, le prix et la durée.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="service-name">Nom de la prestation *</Label>
            <Input
              id="service-name"
              {...register("name")}
              placeholder="Ex: Lavage extérieur complet"
              disabled={isSubmitting}
            />
            {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="service-category">Catégorie</Label>
            <Select
              value={watch("category_id") || undefined}
              onValueChange={(value) => setValue("category_id", value)}
              disabled={isLoading || isSubmitting}
            >
              <SelectTrigger id="service-category">
                <SelectValue
                  placeholder={
                    isLoading ? "Chargement des catégories…" : "Choisir une catégorie…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="service-price">Prix (XOF) *</Label>
              <div className="flex items-end gap-2">
                <Input
                  id="service-price"
                  type="number"
                  min={0}
                  step="1"
                  {...register("price_xof")}
                  placeholder="0"
                  disabled={isSubmitting}
                />
                <span className="text-xs text-muted-foreground">XOF</span>
              </div>
              {errors.price_xof && (
                <span className="text-xs text-destructive">{errors.price_xof.message}</span>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="service-duration">Durée (minutes)</Label>
              <Input
                id="service-duration"
                type="number"
                min={1}
                max={1440}
                {...register("duration_minutes")}
                placeholder="Ex: 45"
                disabled={isSubmitting}
              />
              {errors.duration_minutes && <span className="text-xs text-destructive">{errors.duration_minutes.message}</span>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="service-description">Description</Label>
            <Textarea
              id="service-description"
              {...register("description")}
              placeholder="Détails de la prestation…"
              className="min-h-[80px] resize-none"
              disabled={isSubmitting}
            />
            {errors.description && <span className="text-xs text-destructive">{errors.description.message}</span>}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="service-active"
              checked={isActive}
              onCheckedChange={(checked) => setValue("is_active", checked === true)}
              disabled={isSubmitting}
            />
            <Label htmlFor="service-active" className="text-sm font-medium cursor-pointer">
              Prestation active
            </Label>
          </div>

          {mutationError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {mutationError}
            </div>
          )}

          <DialogFooter>
            {isEditing && (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={isSubmitting || deleting}
              >
                <Trash2 className="mr-2 size-4" />
                Supprimer
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange?.(false)}
              disabled={isSubmitting}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={isSubmitting || isLoading}>
              {isSubmitting ? <RefreshCw className="mr-2 size-4 animate-spin" /> : isEditing ? <Pencil className="mr-2 size-4" /> : <Plus className="mr-2 size-4" />}
              {isEditing ? "Enregistrer" : "Créer la prestation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {isEditing && (
        <ConfirmModal
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title="Supprimer la prestation ?"
          description={`« ${service!.name} » sera définitivement supprimée. Cette action est irréversible.`}
          confirmLabel="Supprimer"
          destructive
          loading={deleting}
          onConfirm={() => void handleDelete()}
        />
      )}
    </Dialog>
  )
}
