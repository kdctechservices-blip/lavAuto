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
import { Label } from "@/components/ui/label"
import { apiErrorMessage, apiFetch } from "@/lib/api"
import { toastSuccess, toastError } from "@/lib/toast"
import { RefreshCw, Settings2 } from "lucide-react"

const schema = z.object({
  name: z.string().trim().min(2, "Le nom doit contenir au moins 2 caractères.").max(120),
  city: z.string().trim().min(1, "La ville est obligatoire.").max(120),
  address: z.string().trim().max(300).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z
    .union([z.string().trim().email("Email invalide").max(200), z.literal("")])
    .optional()
    .nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  is_active: z.boolean().optional(),
})
type FormData = z.infer<typeof schema>

interface Site {
  id: string
  name: string
  city: string | null
  address: string | null
  phone: string | null
  email: string | null
  description: string | null
  is_active: boolean
}

interface EditSiteModalProps {
  site: Site | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onUpdated?: (site: Site) => void
}

export function EditSiteModal({ site, open = false, onOpenChange, onUpdated }: EditSiteModalProps) {
  const [saving, setSaving] = useState(false)
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: site?.name ?? "",
      city: site?.city ?? "",
      address: site?.address ?? "",
      phone: site?.phone ?? "",
      email: site?.email ?? "",
      description: site?.description ?? "",
      is_active: site?.is_active ?? true,
    },
  })
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = form

  // Re-synchronise le formulaire quand la station sélectionnée change
  // ou quand la modale se rouvre.
  useEffect(() => {
    reset({
      name: site?.name ?? "",
      city: site?.city ?? "",
      address: site?.address ?? "",
      phone: site?.phone ?? "",
      email: site?.email ?? "",
      description: site?.description ?? "",
      is_active: site?.is_active ?? true,
    })
  }, [site, open, reset])

  async function onSubmit(data: FormData) {
    if (!site) return
    setSaving(true)
    try {
      const response = await apiFetch(`/api/v1/sites/${encodeURIComponent(site.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: data.name,
          city: data.city,
          address: data.address || null,
          phone: data.phone || null,
          email: data.email || null,
          description: data.description || null,
          is_active: data.is_active ?? true,
        }),
      })
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      const updated: Site =
        response.status === 204 ? { ...site, ...data, id: site.id } : await response.json()
      toastSuccess("Station modifiée", "Les informations de la station ont été mises à jour.")
      onUpdated?.(updated)
      onOpenChange?.(false)
    } catch (err) {
      toastError(
        "Erreur",
        err instanceof Error ? err.message : "Impossible de mettre à jour la station."
      )
    } finally {
      setSaving(false)
    }
  }

  const busy = saving || isSubmitting

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>Modifier la station</DialogTitle>
          <DialogDescription>Mettez à jour les informations de votre station de lavage.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="site-name">Nom de la station *</Label>
            <Input id="site-name" {...register("name")} placeholder="Ex: Station Cocody Riviera" />
            {errors.name && <span className="text-xs text-destructive">{errors.name.message}</span>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-city">Ville *</Label>
            <Input id="site-city" {...register("city")} placeholder="Ex: Abidjan" />
            {errors.city && <span className="text-xs text-destructive">{errors.city.message}</span>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-address">Adresse</Label>
            <Input id="site-address" {...register("address")} placeholder="Ex: Boulevard de France, Cocody" />
            {errors.address && <span className="text-xs text-destructive">{errors.address.message}</span>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="site-phone">Téléphone</Label>
              <Input id="site-phone" {...register("phone")} placeholder="+225 27 XX XX XX XX" />
              {errors.phone && <span className="text-xs text-destructive">{errors.phone.message}</span>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-email">Email</Label>
              <Input id="site-email" type="email" {...register("email")} placeholder="contact@station.ci" />
              {errors.email && <span className="text-xs text-destructive">{errors.email.message}</span>}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="site-description">Description</Label>
            <Input id="site-description" {...register("description")} placeholder="Présentation de votre station…" />
            {errors.description && <span className="text-xs text-destructive">{errors.description.message}</span>}
          </div>
          <div className="flex items-center gap-2">
            <input
              id="site-is-active"
              type="checkbox"
              className="rounded border-primary"
              {...register("is_active")}
            />
            <Label htmlFor="site-is-active" className="text-sm font-medium">Station active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>Annuler</Button>
            <Button type="submit" disabled={busy || !site}>
              {busy ? <RefreshCw className="mr-2 size-4 animate-spin" /> : <Settings2 className="mr-2 size-4" />}
              Enregistrer les modifications
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
