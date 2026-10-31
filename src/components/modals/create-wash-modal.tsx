"use client"

import { useState, useEffect, useMemo } from "react"
import { useForm, useFieldArray } from "react-hook-form"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { apiFetch, apiErrorMessage } from "@/lib/api"
import { createIdempotencyKey } from "@/lib/idempotency"
import { configuredPriceFor, isEligibleFor } from "@/lib/service-pricing"
import { toastSuccess, toastError } from "@/lib/toast"
import { RefreshCw, CarFront, Wallet } from "lucide-react"

const washSchema = z.object({
  site_id: z.string().uuid("Sélectionnez une station."),
  vehicle_category_id: z.string().uuid("Sélectionnez une catégorie."),
  payment_method: z.enum([
    "cash",
    "orange_money",
    "mtn_momo",
    "moov_money",
    "wave",
    "other",
  ]),
  amount_received_cents: z
    .number({ error: "Montant invalide." })
    .int("Le montant doit être un nombre entier.")
    .min(0, "Le montant ne peut pas être négatif."),
  items: z
    .array(
      z.object({
        service_id: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
      })
    )
    .min(1, "Sélectionnez au moins une prestation."),
  cash_session_id: z.string().uuid().optional(),
  worker_ids: z.array(z.string().uuid()).min(1, "Sélectionnez au moins un laveur."),
})

type WashFormData = z.infer<typeof washSchema>

interface Site {
  id: string
  name: string
  city: string | null
  is_active: boolean
}
interface VehicleCategory {
  id: string
  name: string
  family?: string | null
  is_active: boolean
}
interface Service {
  id: string
  name: string
  price_cents: number
  price_by_vehicle_type?: Record<string, number> | null
  /** Catégories autorisées et leur tarif (clé présente = autorisée). */
  vehicle_prices?: Record<string, number> | null
  is_active: boolean
}
interface Worker {
  id: string
  first_name: string
  last_name: string
  role: string
  status: string
}
interface CashSession {
  id: string
  status: string
  opening_amount_cents: number
  opened_at: string
}

interface Wash {
  id: string
  site_id: string
  vehicle_category_id: string
  status: string
}

interface CreateWashModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onWashCreated?: (wash: Wash) => void
}

export function CreateWashModal({
  open = false,
  onOpenChange,
  onWashCreated,
}: CreateWashModalProps) {
  const [sites, setSites] = useState<Site[]>([])
  const [categories, setCategories] = useState<VehicleCategory[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [cashSession, setCashSession] = useState<CashSession | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const form = useForm<WashFormData>({
    resolver: zodResolver(washSchema),
    defaultValues: {
      site_id: "",
      vehicle_category_id: "",
      payment_method: "cash",
      amount_received_cents: 0,
      worker_ids: [],
    },
  })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setValue,
    watch,
    reset,
  } = form

  // Les prestations sont gérées par le formulaire (items = services + quantités).
  const { append, remove, update } = useFieldArray({
    control: form.control,
    name: "items",
  })

  const paymentMethod = watch("payment_method")
  const amountReceivedCents = watch("amount_received_cents")
  const items = watch("items")
  const siteId = watch("site_id")
  const selectedWorkerIds = watch("worker_ids") ?? []

  async function loadReferenceData() {
    try {
      const [sitesRes, catsRes, servicesRes, workersRes] = await Promise.all([
        apiFetch("/api/v1/sites"),
        apiFetch("/api/v1/vehicle-categories"),
        apiFetch("/api/v1/services"),
        apiFetch("/api/v1/workers"),
      ])
      if (sitesRes.ok) setSites(await sitesRes.json())
      if (catsRes.ok) setCategories(await catsRes.json())
      if (servicesRes.ok) setServices(await servicesRes.json())
      if (workersRes.ok) setWorkers(await workersRes.json())
    } catch {
      toastError("Erreur", "Impossible de charger les données de référence.")
    }
  }

  useEffect(() => {
    void loadReferenceData()
  }, [])

  async function loadCashSession(siteId: string) {
    try {
      const res = await apiFetch(
        "/api/v1/cash-sessions/current?site_id=" +
        encodeURIComponent(siteId) +
        "&refresh=" +
        refreshKey
      )
      if (res.ok) {
        const session: CashSession | null = await res.json()
        setCashSession(session && session.status === "open" ? session : null)
        if (session && session.status === "open") {
          setValue("cash_session_id", session.id)
        } else {
          setValue("cash_session_id", undefined)
        }
      } else {
        setCashSession(null)
        setValue("cash_session_id", undefined)
      }
    } catch {
      setCashSession(null)
      setValue("cash_session_id", undefined)
    }
  }

  const activeSites = sites.filter((s) => s.is_active)
  const activeCategories = categories.filter((c) => c.is_active)
  const activeServices = services.filter((s) => s.is_active)
  const activeWorkers = workers.filter((w) => w.status === "active")

  const selectedServices = useMemo(
    () =>
      new Map(
        (items ?? []).map((item) => [item.service_id, item.quantity] as const)
      ),
    [items]
  )
  // Le véhicule retenu porte l'éligibilité et le prix : même règle que le
  // serveur, sans quoi le total affiché ici divergerait du montant facturé.
  const selectedVehicle = useMemo(() => {
    const id = form.watch("vehicle_category_id")
    const category = categories.find((item) => item.id === id)
    return category ? { id: category.id, family: category.family ?? null } : null
  }, [categories, form])

  // Seules les prestations autorisées pour le véhicule sont proposées.
  const eligibleServices = useMemo(
    () =>
      selectedVehicle
        ? activeServices.filter((service) => isEligibleFor(service, selectedVehicle.id))
        : activeServices,
    [activeServices, selectedVehicle]
  )

  const totalCents = useMemo(
    () =>
      eligibleServices.reduce(
        (total, service) =>
          total +
          (configuredPriceFor(service, selectedVehicle?.id ?? null) ?? 0) *
            (selectedServices.get(service.id) ?? 0),
        0
      ),
    [eligibleServices, selectedServices, selectedVehicle]
  )
  const cashNeedsSession =
    paymentMethod === "cash" && amountReceivedCents > 0
  const cashSessionMissing =
    cashNeedsSession && (!cashSession || cashSession.status !== "open")

  /**
   * Choisir la catégorie du véhicule retire du panier les prestations qui ne
   * lui sont pas autorisées : l'interdiction s'applique tout de suite, elle
   * n'attend pas la validation serveur.
   */
  function chooseVehicle(value: string) {
    setValue("vehicle_category_id", value, { shouldValidate: true })
    const category = categories.find((item) => item.id === value)
    if (!category) return
    const currentItems = form.getValues("items") ?? []
    const doomed: number[] = []
    currentItems.forEach((item, index) => {
      const service = services.find((candidate) => candidate.id === item.service_id)
      if (service && !isEligibleFor(service, category.id)) doomed.push(index)
    })
    for (let index = doomed.length - 1; index >= 0; index -= 1) remove(doomed[index])
  }

  function toggleService(serviceId: string, checked: boolean) {
    if (checked) {
      append({ service_id: serviceId, quantity: 1 })
    } else {
      const index = (items ?? []).findIndex((item) => item.service_id === serviceId)
      if (index >= 0) remove(index)
    }
  }

  function changeQuantity(serviceId: string, rawValue: string) {
    const quantity = Number(rawValue)
    const index = (items ?? []).findIndex((item) => item.service_id === serviceId)
    if (index < 0) return
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      remove(index)
    } else {
      update(index, { service_id: serviceId, quantity })
    }
  }

  function toggleWorker(workerId: string, checked: boolean) {
    setValue(
      "worker_ids",
      checked
        ? [...selectedWorkerIds, workerId]
        : selectedWorkerIds.filter((id) => id !== workerId),
      { shouldValidate: true }
    )
  }

  function serviceQuantity(serviceId: string): number {
    return selectedServices.get(serviceId) ?? 0
  }

  async function onSubmit(data: WashFormData) {
    setMutationError(null)

    // Validation croisée : montant reçu ne peut dépasser le total calculé.
    if (data.amount_received_cents > totalCents) {
      setMutationError(
        "Le montant reçu ne peut pas dépasser le total des prestations (" +
        (totalCents / 100).toLocaleString("fr-CI") +
        " XOF)."
      )
      return
    }
    // Validation croisée : paiement en espèces => session de caisse ouverte requise.
    if (data.payment_method === "cash" && data.amount_received_cents > 0) {
      if (!cashSession || cashSession.status !== "open") {
        setMutationError(
          "Ouvrez d'abord une session de caisse pour enregistrer un paiement en espèces."
        )
        return
      }
    }

    const requestKey = createIdempotencyKey()
    const payload = {
      site_id: data.site_id,
      vehicle_category_id: data.vehicle_category_id,
      items: data.items,
      worker_ids: data.worker_ids ?? [],
      payment_method: data.payment_method,
      amount_received_cents: data.amount_received_cents,
      ...(data.payment_method === "cash" &&
        data.amount_received_cents > 0 &&
        cashSession
        ? { cash_session_id: cashSession.id }
        : {}),
    }

    try {
      const response = await apiFetch("/api/v1/washes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response))
      }
      const wash: Wash = await response.json()
      toastSuccess("Lavage enregistré", "Le lavage a été créé avec succès.")
      onWashCreated?.(wash)
      setRefreshKey((key) => key + 1)
      onOpenChange?.(false)
      reset()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Impossible d'enregistrer le lavage."
      setMutationError(message)
      toastError("Échec de l'enregistrement", message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px] p-6" showCloseButton>
        <DialogHeader>
          <DialogTitle>Enregistrer un nouveau lavage</DialogTitle>
          <DialogDescription>
            Sélectionnez la station, le véhicule, les prestations et le paiement.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Station *</Label>
              <Select
                value={siteId || undefined}
                onValueChange={(value: string | null) => {
                  setValue("site_id", value ?? "", { shouldValidate: true })
                  if (value) void loadCashSession(value)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choisir une station…" />
                </SelectTrigger>
                <SelectContent>
                  {activeSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name}
                      {site.city ? ` · ${site.city}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.site_id && (
                <span className="text-xs text-destructive">
                  {errors.site_id.message}
                </span>
              )}
            </div>
            <div className="space-y-2">
              <Label>Catégorie véhicule *</Label>
              <Select
                value={watch("vehicle_category_id") || undefined}
                onValueChange={(value: string | null) =>
                  chooseVehicle(value ?? "")
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choisir une catégorie…" />
                </SelectTrigger>
                <SelectContent>
                  {activeCategories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.vehicle_category_id && (
                <span className="text-xs text-destructive">
                  {errors.vehicle_category_id.message}
                </span>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Prestations *</Label>
            {activeServices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucune prestation active disponible.
              </p>
            ) : eligibleServices.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucune prestation n’est autorisée pour cette catégorie de véhicule.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                {eligibleServices.map((service) => {
                  const quantity = serviceQuantity(service.id)
                  return (
                    <label
                      key={service.id}
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border p-3 transition-colors hover:bg-muted/50 has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5"
                    >
                      <Checkbox
                        checked={quantity > 0}
                        onCheckedChange={(checked) =>
                          toggleService(service.id, checked === true)
                        }
                        aria-label={service.name}
                      />
                      <span className="text-sm font-medium">{service.name}</span>
                      {quantity > 0 && (
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={quantity}
                          onChange={(e) =>
                            changeQuantity(service.id, e.target.value)
                          }
                          inputMode="numeric"
                          className="h-9 w-14 rounded-md border border-input text-center text-sm tabular-nums"
                          aria-label={`Quantité pour ${service.name}`}
                        />
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {selectedVehicle
                          ? (configuredPriceFor(service, selectedVehicle.id) ?? 0) > 0
                            ? ((configuredPriceFor(service, selectedVehicle.id) ?? 0) / 100).toLocaleString("fr-CI") +
                              " F CFA"
                            : "Gratuit"
                          : "Tarif selon la catégorie"}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {errors.items && typeof errors.items.message === "string" && (
              <span className="text-xs text-destructive">{errors.items.message}</span>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Sélectionnez les prestations réalisées et leurs quantités.
            </p>
          </div>

          {activeWorkers.length > 0 && (
            <div className="space-y-2">
              <Label>Travailleurs assignés *</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {activeWorkers.map((worker) => (
                  <label
                    key={worker.id}
                    className="flex items-center gap-2 rounded-lg border p-2 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={selectedWorkerIds.includes(worker.id)}
                      onCheckedChange={(checked) =>
                        toggleWorker(worker.id, checked === true)
                      }
                      aria-label={worker.first_name + " " + worker.last_name}
                    />
                    <span className="text-sm">
                      {worker.first_name} {worker.last_name}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {worker.role}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {errors.worker_ids && typeof errors.worker_ids.message === "string" && (
            <span className="text-xs text-destructive mb-2">{errors.worker_ids.message}</span>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Mode de paiement *</Label>
              <Select
                value={paymentMethod}
                onValueChange={(value) =>
                  setValue(
                    "payment_method",
                    value as WashFormData["payment_method"],
                    { shouldValidate: true }
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choisir un mode…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Espèces</SelectItem>
                  <SelectItem value="orange_money">Orange Money</SelectItem>
                  <SelectItem value="mtn_momo">MTN MoMo</SelectItem>
                  <SelectItem value="moov_money">Moov Money</SelectItem>
                  <SelectItem value="wave">Wave</SelectItem>
                  <SelectItem value="other">Autre</SelectItem>
                </SelectContent>
              </Select>
              {errors.payment_method && (
                <span className="text-xs text-destructive">
                  {errors.payment_method.message}
                </span>
              )}
            </div>
            <div className="space-y-2">
              <Label>Montant reçu (XOF)</Label>
              <div className="flex items-end gap-2">
                <Input
                  type="number"
                  min={0}
                  step="1"
                  inputMode="numeric"
                  className="h-11 text-base tabular-nums"
                  {...register("amount_received_cents", {
                    valueAsNumber: true,
                    validate: (value) =>
                      Number.isInteger(value) ||
                      "Le montant doit être un nombre entier de XOF.",
                  })}
                  placeholder="0"
                />
                {/* Cas le plus fréquent en station : le client paie le montant exact. */}
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 whitespace-nowrap"
                  disabled={totalCents <= 0}
                  onClick={() => setValue("amount_received_cents", totalCents, { shouldValidate: true })}
                >
                  Appoint exact
                </Button>
              </div>
              {errors.amount_received_cents && (
                <span className="text-xs text-destructive">
                  {errors.amount_received_cents.message}
                </span>
              )}
              {totalCents > 0 && (
                <p className="text-xs text-muted-foreground">
                  Total des prestations : {" "}
                  {(totalCents / 100).toLocaleString("fr-CI")} XOF
                </p>
              )}
              {cashSessionMissing && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  Aucune session de caisse ouverte pour cette station.
                </div>
              )}
            </div>
          </div>

          {cashSession && cashSession.status === "open" && (
            <div className="rounded-lg bg-muted/50 p-3 border border-border/50">
              <div className="flex items-center gap-2 text-sm">
                <Wallet className="size-4 text-muted-foreground" />
                <span className="font-medium">Session de caisse ouverte</span>
                <span className="ml-auto text-muted-foreground">
                  {new Date(cashSession.opened_at).toLocaleString("fr-CI")}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Ouverture:
                {(cashSession.opening_amount_cents / 100).toLocaleString("fr-CI")} XOF
              </div>
            </div>
          )}

          {mutationError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {mutationError}
            </div>
          )}

          <DialogFooter className="sticky bottom-0 -mx-6 -mb-6 gap-3 border-t bg-background/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-center sm:justify-between">
            {/* Récapitulatif toujours visible, y compris sur mobile. */}
            <div className="flex items-baseline justify-between gap-3 sm:justify-start">
              <span className="text-xs text-muted-foreground">Total à encaisser</span>
              <span className="text-lg font-bold tabular-nums">
                {(totalCents / 100).toLocaleString("fr-CI")} XOF
              </span>
            </div>
            <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-11 flex-1 sm:flex-none" onClick={() => onOpenChange?.(false)}>
              Annuler
            </Button>
            <Button
              type="submit"
              className="h-11 flex-1 sm:flex-none"
              disabled={
                isSubmitting ||
                !siteId ||
                cashSessionMissing ||
                selectedWorkerIds.length === 0
              }
            >
              {isSubmitting ? (
                <RefreshCw className="mr-2 size-4 animate-spin" />
              ) : (
                <CarFront className="mr-2 size-4" />
              )}
              {isSubmitting ? "Enregistrement…" : "Enregistrer le lavage"}
            </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}