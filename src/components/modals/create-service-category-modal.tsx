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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { apiErrorMessage, apiFetch } from "@/lib/api"
import { toastSuccess, toastError } from "@/lib/toast"
import { List, Plus, RefreshCw } from "lucide-react"

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Le nom est obligatoire.")
    .max(100, "Le nom ne doit pas dépasser 100 caractères."),
  is_active: z.boolean(),
})

type FormData = z.infer<typeof schema>

interface ServiceCategory {
  id: string
  name: string
  is_active: boolean
  created_at?: string
  updated_at?: string
}

interface CreateServiceCategoryModalProps {
  /** Optional controlled open state. Left undefined, the modal manages its own. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** When provided, the modal switches to edit mode (PATCH + delete). */
  category?: ServiceCategory | null
  onCreated?: (category: ServiceCategory) => void
  onUpdated?: (category: ServiceCategory) => void
  onDeleted?: (categoryId: string) => void
}

export function CreateServiceCategoryModal({
  open: openProp,
  onOpenChange,
  category = null,
  onCreated,
  onUpdated,
}: CreateServiceCategoryModalProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = openProp ?? internalOpen
  const isEditing = Boolean(category)

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", is_active: true },
  })
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form

  // (Ré)initialiser le formulaire selon le mode create/edit à chaque ouverture.
  useEffect(() => {
    if (!isOpen) return
    reset(category ? { name: category.name, is_active: category.is_active } : { name: "", is_active: true })
  }, [isOpen, category, reset])

  const isActive = watch("is_active")

  function setOpen(next: boolean) {
    if (openProp === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  function handleOpenChange(next: boolean) {
    // Empêche la fermeture pendant l’envoi pour ne pas perdre la saisie.
    if (!next && isSubmitting) return
    setOpen(next)
  }
  async function onSubmit(data: FormData) {
    try {
      const response = await apiFetch(
        isEditing
          ? `/api/v1/service-categories/${encodeURIComponent(category!.id)}`
          : "/api/v1/service-categories",
        {
          method: isEditing ? "PATCH" : "POST",
          body: JSON.stringify({ name: data.name.trim(), is_active: data.is_active }),
        },
      )
      if (!response.ok) throw new Error(await apiErrorMessage(response))

      const saved = (await response.json()) as ServiceCategory
      if (isEditing) {
        toastSuccess("Catégorie modifiée", "La catégorie de prestation a été mise à jour.")
        onUpdated?.(saved)
      } else {
        toastSuccess("Catégorie créée", "La catégorie de prestation a été créée.")
        onCreated?.(saved)
      }
      reset({ name: "", is_active: true })
      setOpen(false)
    } catch (error) {
      toastError(
        "Erreur",
        error instanceof Error
          ? error.message
          : "Impossible d'enregistrer la catégorie de prestation.",
      )
    }
  }


  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {!isEditing && (
        <DialogTrigger render={<Button variant="outline" className="gap-2" />}>
          <Plus className="size-4" />
          Nouvelle catégorie prestation
        </DialogTrigger>
      )}
      <DialogContent className="max-w-[480px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Modifier la catégorie" : "Nouvelle catégorie de prestation"}</DialogTitle>
          <DialogDescription>Ex: Lavage classique, Detailing &amp; Soins.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="service-category-name">Nom de la catégorie *</Label>
            <Input
              id="service-category-name"
              autoFocus
              maxLength={100}
              aria-invalid={errors.name ? true : undefined}
              {...register("name")}
              placeholder="Ex: Lavage classique"
            />
            {errors.name && (
              <span className="text-xs text-destructive">{errors.name.message}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="service-category-active"
              checked={isActive}
              onCheckedChange={(checked) => setValue("is_active", checked)}
            />
            <Label htmlFor="service-category-active" className="text-sm font-medium">
              Catégorie active
            </Label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => handleOpenChange(false)}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <RefreshCw className="mr-2 size-4 animate-spin" />
              ) : (
                <List className="mr-2 size-4" />
              )}
              Créer la catégorie
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}