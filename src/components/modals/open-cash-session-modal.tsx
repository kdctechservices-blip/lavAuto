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
import { RefreshCw, Wallet } from "lucide-react"

const sessionSchema = z.object({
  site_id: z.string().uuid("Sélectionnez une station."),
  // L'utilisateur saisit un montant en XOF ; il est converti en centimes avant l'envoi.
  opening_amount_xof: z
    .number({ message: "Saisissez un montant valide." })
    .int("Le montant doit être un nombre entier.")
    .min(0, "Le montant d'ouverture ne peut pas être négatif."),
})

type SessionFormData = z.infer<typeof sessionSchema>

interface Site {
  id: string
  name: string
  is_active: boolean
}

interface CashSession {
  id: string
  status: string
  opening_amount_cents: number
  opened_at: string
}

interface OpenCashSessionModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSessionOpened?: (session: CashSession) => void
}

export function OpenCashSessionModal({
  open = false,
  onOpenChange,
  onSessionOpened,
}: OpenCashSessionModalProps) {
  const [sites, setSites] = useState<Site[]>([])
  const [sitesLoading, setSitesLoading] = useState(true)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const form = useForm<SessionFormData>({
    resolver: zodResolver(sessionSchema),
    defaultValues: { site_id: "", opening_amount_xof: 0 },
  })

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = form

  useEffect(() => {
    async function loadSites() {
      setSitesLoading(true)
      try {
        const res = await apiFetch("/api/v1/sites")
        if (res.ok) setSites(await res.json())
      } catch {
        toastError("Erreur", "Impossible de charger les stations.")
      } finally {
        setSitesLoading(false)
      }
    }
    void loadSites()
  }, [])

  // Réinitialise le formulaire à chaque ouverture de la modale.
  useEffect(() => {
    if (open) {
      reset({ site_id: "", opening_amount_xof: 0 })
      setMutationError(null)
    }
  }, [open, reset])

  async function onSubmit(data: SessionFormData) {
    setMutationError(null)
    try {
      const response = await apiFetch("/api/v1/cash-sessions/open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key":
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `open-${data.site_id}-${Date.now()}`,
        },
        body: JSON.stringify({
          site_id: data.site_id,
          opening_amount_cents: data.opening_amount_xof * 100,
        }),
      })
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response))
      }
      const session: CashSession = await response.json()
      toastSuccess("Caisse ouverte", "La session de caisse a été ouverte avec succès.")
      onSessionOpened?.(session)
      onOpenChange?.(false)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible d'ouvrir la session de caisse."
      setMutationError(message)
      toastError("Échec de l'ouverture", message)
    }
  }

  const activeSites = sites.filter((s) => s.is_active)
  const selectedSiteId = form.watch("site_id")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>Ouvrir une session de caisse</DialogTitle>
          <DialogDescription>
            Sélectionnez la station et saisissez le montant d'ouverture.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          {mutationError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {mutationError}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="site_id">Station *</Label>
            <Select
              value={selectedSiteId || undefined}
              onValueChange={(value: string | null) =>
                setValue("site_id", value ?? "", { shouldValidate: true })
              }
            >
              <SelectTrigger id="site_id" disabled={sitesLoading || activeSites.length === 0}>
                <SelectValue
                  placeholder={
                    sitesLoading
                      ? "Chargement des stations…"
                      : "Choisir une station…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {activeSites.map((site) => (
                  <SelectItem key={site.id} value={site.id}>
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.site_id && (
              <span className="text-xs text-destructive">{errors.site_id.message}</span>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="opening_amount_xof">Montant d'ouverture (XOF) *</Label>
            <div className="flex items-end gap-2">
              <Input
                id="opening_amount_xof"
                type="number"
                min={0}
                step="1"
                {...register("opening_amount_xof", { valueAsNumber: true })}
                placeholder="0"
              />
              <span className="text-xs text-muted-foreground">XOF</span>
            </div>
            {errors.opening_amount_xof && (
              <span className="text-xs text-destructive">
                {errors.opening_amount_xof.message}
              </span>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || activeSites.length === 0}
            >
              {isSubmitting ? (
                <RefreshCw className="mr-2 size-4 animate-spin" />
              ) : (
                <Wallet className="mr-2 size-4" />
              )}
              {isSubmitting ? "Ouverture en cours…" : "Ouvrir la caisse"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
