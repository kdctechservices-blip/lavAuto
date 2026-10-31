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
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { apiFetch, apiErrorMessage } from "@/lib/api"
import { toastSuccess, toastError } from "@/lib/toast"
import { ConfirmModal } from "./confirm-modal"
import { RefreshCw, CarFront, Pencil, Trash2 } from "lucide-react"

const schema = z.object({
  name: z.string().trim().min(1, "Le nom est obligatoire.").max(120),
  is_active: z.boolean(),
})
type FormData = z.infer<typeof schema>

interface VehicleCategory {
  id: string
  name: string
  is_active: boolean
}

interface CreateVehicleCategoryModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** When provided, the modal switches to edit mode (PATCH + delete). */
  category?: VehicleCategory | null
  onCreated?: (category: VehicleCategory) => void
  onUpdated?: (category: VehicleCategory) => void
  onDeleted?: (categoryId: string) => void
}

export function CreateVehicleCategoryModal({
  open = false,
  onOpenChange,
  category = null,
  onCreated,
  onUpdated,
  onDeleted,
}: CreateVehicleCategoryModalProps) {
  const isEditing = Boolean(category)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", is_active: true },
  })
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    setError,
    setValue,
    watch,
  } = form

  // (Ré)initialiser le formulaire selon le mode create/edit à chaque ouverture.
  useEffect(() => {
    if (!open) return
    reset(
      category
        ? { name: category.name, is_active: category.is_active }
        : { name: "", is_active: true },
    )
  }, [open, category, reset])

  const isActive = watch("is_active")

  async function onSubmit(data: FormData) {
    try {
      const response = await apiFetch(
        isEditing
          ? `/api/v1/vehicle-categories/${encodeURIComponent(category!.id)}`
          : "/api/v1/vehicle-categories",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.name.trim(),
            is_active: data.is_active,
          }),
        },
      )
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response))
      }
      const saved: VehicleCategory = await response.json()
      if (isEditing) {
        toastSuccess("Catégorie modifiée", "La catégorie de véhicule a été mise à jour.")
        onUpdated?.(saved)
      } else {
        toastSuccess("Catégorie créée", "La catégorie de véhicule a été créée.")
        onCreated?.(saved)
      }
      onOpenChange?.(false)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : isEditing
            ? "Impossible de modifier la catégorie."
            : "Impossible de créer la catégorie."
      toastError(isEditing ? "Échec de la modification" : "Échec de la création", message)
      setError("name", { type: "manual", message })
    }
  }

  async function handleDelete() {
    if (!category) return
    setDeleting(true)
    try {
      const response = await apiFetch(
        `/api/v1/vehicle-categories/${encodeURIComponent(category.id)}`,
        { method: "DELETE" },
      )
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      toastSuccess("Catégorie supprimée", "La catégorie de véhicule a été supprimée.")
      onDeleted?.(category.id)
      onOpenChange?.(false)
    } catch (err) {
      toastError(
        "Échec de la suppression",
        err instanceof Error ? err.message : "Impossible de supprimer la catégorie.",
      )
    } finally {
      setDeleting(false)
      setConfirmDeleteOpen(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Modifier la catégorie de véhicule" : "Nouvelle catégorie de véhicule"}
          </DialogTitle>
          <DialogDescription>Ex: Berline, SUV, Moto, Utilitaire.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="category-name">Nom de la catégorie *</Label>
            <Input
              id="category-name"
              maxLength={120}
              aria-invalid={errors.name ? true : undefined}
              {...register("name")}
              placeholder="Ex: Berline"
              disabled={isSubmitting || deleting}
            />
            {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="vehicle-category-active"
              checked={isActive}
              onCheckedChange={(checked) => setValue("is_active", checked === true)}
              disabled={isSubmitting || deleting}
            />
            <Label htmlFor="vehicle-category-active" className="text-sm font-medium">
              Catégorie active
            </Label>
          </div>
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
              disabled={isSubmitting || deleting}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={isSubmitting || deleting}>
              {isSubmitting ? (
                <RefreshCw className="mr-2 size-4 animate-spin" />
              ) : isEditing ? (
                <Pencil className="mr-2 size-4" />
              ) : (
                <CarFront className="mr-2 size-4" />
              )}
              {isSubmitting
                ? isEditing
                  ? "Enregistrement…"
                  : "Création en cours…"
                : isEditing
                  ? "Enregistrer"
                  : "Créer la catégorie"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {isEditing && (
        <ConfirmModal
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title="Supprimer la catégorie ?"
          description={`« ${category!.name} » sera définitivement supprimée. Les lavages qui l'utilisent bloqueront la suppression.`}
          confirmLabel="Supprimer"
          destructive
          loading={deleting}
          onConfirm={() => void handleDelete()}
        />
      )}
    </Dialog>
  )
}
