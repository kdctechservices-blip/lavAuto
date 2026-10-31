"use client"

import type * as React from "react"
import { useMemo, useState, type FormEvent } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import type { CurrentMember } from "@/lib/team-api"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { Pencil, Plus, RefreshCw, Search, Sparkles, ToggleLeft, ToggleRight, Trash2 } from "lucide-react"
import { useCapability } from "@/lib/subscription"
import { ConsumablesDialog } from "@/components/stock/consumables-dialog"
import { Package } from "lucide-react"
import { formatXof } from "@/lib/format"
import { VEHICLE_FAMILIES } from "@/config/vehicle-taxonomy"
import { matchingServiceCategory } from "@/config/service-categories"
import { configuredPriceRange } from "@/lib/service-pricing"

interface Service {
  id: string
  template_id: string | null
  name: string
  description: string | null
  price_cents: number
  price_by_vehicle_type: Record<string, number> | null
  /**
   * Catégories de véhicules autorisées et leur tarif, en centimes.
   * La **présence** de la clé est l'autorisation ; sa valeur, le prix.
   */
  vehicle_prices: Record<string, number> | null
  category_id: string | null
  duration_minutes: number | null
  is_active: boolean
}

interface ServiceCategory {
  id: string
  name: string
  is_active: boolean
}

interface VehicleCategory {
  id: string
  name: string
  family: string | null
  is_active: boolean
}

/**
 * Un type de service du catalogue général (« Lavage moteur complet »…).
 *
 * C'est le point de départ d'une prestation : choisir un type remplit le nom,
 * la catégorie, la durée, la description et le prix indicatif. Le gérant part
 * d'une base juste au lieu d'une page blanche.
 */
interface ServiceTemplate {
  id: string
  category: string
  name: string
  price_cents: number | null
  duration_minutes: number | null
  description: string | null
}

interface ServiceForm {
  /** Type du catalogue choisi (`id`) ou « custom » pour un type maison. */
  template_id: string
  /**
   * Le nom — jamais saisi dans le formulaire principal : il vient du type de
   * service sélectionné. Pour un type maison, il est créé dans la boîte dédiée
   * « Ajouter un type de service au catalogue ».
   */
  name: string
  description: string
  category_id: string | null
  duration_minutes: string
  /**
   * Tarifs saisis par catégorie de véhicule, en francs (texte).
   *
   * La valeur survit à un décochage-recochage pendant la même édition :
   * seule la soumission ne retient que les catégories cochées. Un champ vide
   * n'est pas « zéro franc », c'est « prix non renseigné ».
   */
  priceDrafts: Record<string, string>
  /** Catégories cochées = autorisées. Décochée, une catégorie disparaît de la configuration enregistrée. */
  enabled: Record<string, boolean>
}

const emptyForm = (): ServiceForm => ({
  template_id: "custom",
  name: "",
  description: "",
  category_id: null,
  duration_minutes: "",
  priceDrafts: {},
  enabled: {},
})

/** Type maison en cours de création dans la boîte dédiée. */
interface CustomTypeForm {
  name: string
  description: string
  category_id: string | null
  duration_minutes: string
}

const emptyCustomType = (): CustomTypeForm => ({
  name: "",
  description: "",
  category_id: null,
  duration_minutes: "",
})

function parseXofAmount(value: string): number | null {
  if (!value.trim()) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  const cents = Math.round(amount * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

/** Clé d'occupation du formulaire, distincte des clés de ligne. */
const FORM_KEY = "formulaire"

export default function ServicesPage() {
  const manageCatalog = useAccess("service:manage", "catalog.manage")
  // Ouvrir un formulaire n'écrit rien : on reste cliquable pendant que les
  // droits chargent. Basculer un statut écrit tout de suite : on attend.
  const catalogForm = actionGate({
    loading: manageCatalog.loading,
    allowed: manageCatalog.allowed,
    reason: manageCatalog.reason,
  })
  const catalogWrite = actionGate({
    loading: manageCatalog.loading,
    allowed: manageCatalog.allowed,
    reason: manageCatalog.reason,
    writesImmediately: true,
  })
  const [refreshKey, setRefreshKey] = useState(0)
  const [recettePour, setRecettePour] = useState<Service | null>(null)
  // Sans forfait Pro, il n'y a pas de stock à consommer : le bouton n'a rien
  // à proposer. On le retire plutôt que de griser une icône dans chaque
  // ligne du catalogue — l'écran Stock est la page qui présente l'offre.
  const planStock = useCapability("stock.manage")
  const { data: services, loading, error } = useApi<Service[]>(`/api/v1/services?refresh=${refreshKey}`)
  const { data: categories, loading: categoriesLoading, error: categoriesError } = useApi<ServiceCategory[]>(`/api/v1/service-categories?refresh=${refreshKey}`)
  const { data: vehicleCategories } = useApi<VehicleCategory[]>(`/api/v1/vehicle-categories?refresh=${refreshKey}`)
  const { data: templates } = useApi<ServiceTemplate[]>(`/api/v1/service-catalog`)
  const { data: member } = useApi<CurrentMember>(`/api/v1/auth/me?refresh=${refreshKey}`)
  const servicesList = useMemo(() => services ?? [], [services])
  const categoryById = useMemo(() => new Map((categories ?? []).map((category) => [category.id, category.name])), [categories])
  const canManage = member?.role === "owner" || member?.role === "manager"

  /**
   * Catégories de véhicules proposées au tarif, groupées par famille et dans
   * l'ordre du référentiel. Une station rangée dans une famille inconnue (ou
   * sans famille) passe en dernier : elle reste tarifable.
   */
  const vehicleGroups = useMemo(() => {
    const groups = VEHICLE_FAMILIES.map((family) => ({
      code: family.code,
      label: family.label,
      categories: (vehicleCategories ?? [])
        .filter((category) => category.family === family.code)
        .sort((a, b) => a.name.localeCompare(b.name, "fr-CI")),
    }))
    const orphans = (vehicleCategories ?? []).filter(
      (category) => !category.family || !VEHICLE_FAMILIES.some((family) => family.code === category.family),
    )
    if (orphans.length > 0) {
      groups.push({
        code: "",
        label: "Sans famille",
        categories: [...orphans].sort((a, b) => a.name.localeCompare(b.name, "fr-CI")),
      })
    }
    return groups.filter((group) => group.categories.length > 0)
  }, [vehicleCategories])

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingService, setEditingService] = useState<Service | null>(null)
  // Boîte dédiée « Ajouter un type de service au catalogue » : le formulaire
  // principal reste sobre (choisir un type, autoriser des catégories, fixer
  // leurs prix), la création d'un type maison a son propre flux.
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [customType, setCustomType] = useState<CustomTypeForm>(emptyCustomType)
  const [form, setForm] = useState<ServiceForm>(emptyForm)
  const availableCategories = useMemo(
    () => (categories ?? []).filter((category) => category.is_active || category.id === form.category_id),
    [categories, form.category_id],
  )
  const [search, setSearch] = useState("")
  // Un seul contrôleur remplace « saving », « busyServiceId » et les deux
  // messages : c'est la même écriture, elle n'avait pas à vivre en quatre
  // états qu'il fallait penser à synchroniser.
  const mutation = useMutation()
  const saving = mutation.busyKey === FORM_KEY

  const filteredServices = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr-CI")
    return servicesList.filter((service) => !query || service.name.toLocaleLowerCase("fr-CI").includes(query))
  }, [servicesList, search])

  function openCreateDialog() {
    setEditingService(null)
    setForm(emptyForm())
    setCustomType(emptyCustomType())
    mutation.reset()
    setDialogOpen(true)
  }

  function openEditDialog(service: Service) {
    setEditingService(service)
    const template =
      (templates ?? []).find((item) => item.id === service.template_id) ??
      // Repli par le nom : les prestations créées avant la clé de type n'ont
      // pas de `template_id`, mais leur nom vient souvent du catalogue.
      (templates ?? []).find(
        (item) => item.name.toLocaleLowerCase("fr-CI") === service.name.toLocaleLowerCase("fr-CI"),
      )
    // Les associations déjà enregistrées cochent leurs catégories et
    // pré-remplissent leurs prix. Une catégorie autorisée n'est jamais
    // décochée d'office ; une catégorie sans association n'est pas cochée.
    const configured = service.vehicle_prices ?? {}
    setForm({
      template_id: template?.id ?? "custom",
      name: service.name,
      description: service.description ?? "",
      category_id: service.category_id,
      duration_minutes: service.duration_minutes == null ? "" : String(service.duration_minutes),
      priceDrafts: Object.fromEntries(
        Object.entries(configured).map(([id, cents]) => [id, String(cents / 100)]),
      ),
      enabled: Object.fromEntries(Object.keys(configured).map((id) => [id, true])),
    })
    setCustomType(
      template
        ? emptyCustomType()
        : {
            name: service.name,
            description: service.description ?? "",
            category_id: service.category_id,
            duration_minutes: service.duration_minutes == null ? "" : String(service.duration_minutes),
          },
    )
    mutation.reset()
    setDialogOpen(true)
  }

  /**
   * Choisir un type du catalogue pré-remplit la prestation.
   *
   * Le nom, la durée et la description viennent du catalogue, la catégorie est
   * retrouvée par son nom. Les tarifs, eux, ne bougent pas : ce sont les
   * catégories autorisées et leurs prix qui les portent.
   */
  function applyTemplate(value: string | null) {
    const templateId = value ?? "custom"
    if (templateId === "custom") {
      // Flux distinct : le type maison se crée dans sa propre boîte.
      setCustomDialogOpen(true)
      return
    }
    const template = (templates ?? []).find((item) => item.id === templateId)
    if (!template) return
    const category = matchingServiceCategory(template.category, categories ?? [])
    setForm((previous) => ({
      ...previous,
      template_id: templateId,
      name: template.name,
      description: template.description ?? "",
      duration_minutes:
        template.duration_minutes == null ? "" : String(template.duration_minutes),
      category_id: category?.id ?? previous.category_id,
    }))
  }

  /** Valide et applique un type maison créé dans la boîte dédiée. */
  function confirmCustomType() {
    const name = customType.name.trim()
    if (!name || name.length > 100) {
      return
    }
    const duration = customType.duration_minutes.trim() ? Number(customType.duration_minutes) : null
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) {
      return
    }
    setForm((previous) => ({
      ...previous,
      template_id: "custom",
      name,
      description: customType.description.trim(),
      category_id: customType.category_id,
      duration_minutes: customType.duration_minutes,
    }))
    setCustomDialogOpen(false)
  }

  function handleDialogChange(open: boolean) {
    if (open) setDialogOpen(true)
    else if (!saving) {
      setDialogOpen(false)
      mutation.reset()
    }
  }

  async function saveService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = form.name.trim()
    const durationMinutes = form.duration_minutes.trim() ? Number(form.duration_minutes) : null
    if (!name || name.length > 100) {
      mutation.fail("Sélectionnez un type de service valide.")
      return
    }
    if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) {
      mutation.fail("La durée doit être comprise entre 1 et 1 440 minutes.")
      return
    }

    // Catégories autorisées, dans l'ordre du référentiel. Une catégorie
    // cochée exige un prix valide ; un prix manquant n'est jamais remplacé
    // par zéro en silence. Une catégorie décochée n'est pas envoyée du tout :
    // elle n'est ni gratuite, ni au prix de base — simplement indisponible.
    const vehiclePricing: Array<{ vehicle_category_id: string; price_cents: number }> = []
    for (const group of vehicleGroups) {
      for (const category of group.categories) {
        if (!form.enabled[category.id]) continue
        const raw = form.priceDrafts[category.id] ?? ""
        if (!raw.trim()) {
          mutation.fail(`Renseignez le prix pour la catégorie ${category.name}.`)
          return
        }
        const cents = parseXofAmount(raw)
        if (cents == null) {
          mutation.fail(`Le prix doit être un montant valide en FCFA. Catégorie ${category.name}.`)
          return
        }
        vehiclePricing.push({ vehicle_category_id: category.id, price_cents: cents })
      }
    }
    if (vehiclePricing.length === 0) {
      mutation.fail("Sélectionnez au moins une catégorie de véhicule.")
      return
    }

    const outcome = await mutation.run({
      url: editingService ? `/api/v1/services/${encodeURIComponent(editingService.id)}` : "/api/v1/services",
      method: editingService ? "PATCH" : "POST",
      body: {
        template_id: form.template_id === "custom" ? null : form.template_id,
        name,
        description: form.description.trim() || null,
        category_id: form.category_id,
        duration_minutes: durationMinutes,
        is_active: editingService?.is_active ?? true,
        vehicle_pricing: vehiclePricing,
      },
      success: editingService ? "Prestation mise à jour." : "Prestation créée.",
      failure: "Impossible d’enregistrer la prestation.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setDialogOpen(false)
    setRefreshKey((key) => key + 1)
  }

  function toggleCategory(categoryId: string) {
    setForm((previous) => ({
      ...previous,
      enabled: { ...previous.enabled, [categoryId]: !previous.enabled[categoryId] },
    }))
  }

  function setPriceDraft(categoryId: string, value: string) {
    setForm((previous) => ({
      ...previous,
      priceDrafts: { ...previous.priceDrafts, [categoryId]: value },
    }))
  }

  /** Catégories cochées : au moins une, et toutes pourvues d'un prix saisissable. */
  const enabledCount = useMemo(
    () => Object.values(form.enabled).filter(Boolean).length,
    [form.enabled],
  )

  /**
   * Suppression définitive, réservée aux prestations jamais vendues.
   *
   * Le serveur répond 409 dès qu'un lavage la référence : l'historique garde
   * son prix, donc on désactive au lieu de supprimer. Le message est repris
   * tel quel par la mutation, il n'y a rien à reformuler ici.
   */
  async function deleteService(service: Service) {
    const outcome = await mutation.run({
      url: `/api/v1/services/${encodeURIComponent(service.id)}`,
      method: "DELETE",
      confirm: `Supprimer définitivement « ${service.name} » ? Si des lavages la référencent, la suppression sera refusée : désactivez-la dans ce cas.`,
      success: "Prestation supprimée.",
      failure: "Impossible de supprimer la prestation.",
      busyKey: service.id,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  async function toggleService(service: Service) {
    const nextStatus = !service.is_active
    const outcome = await mutation.run({
      url: `/api/v1/services/${encodeURIComponent(service.id)}`,
      method: "PATCH",
      body: { is_active: nextStatus },
      confirm: nextStatus
        ? undefined
        : `Désactiver « ${service.name} » ? Les lavages historiques conserveront leurs prix enregistrés.`,
      success: nextStatus ? "Prestation réactivée." : "Prestation désactivée.",
      failure: "Impossible de modifier la prestation.",
      busyKey: service.id,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  return (
    <BaseLayout title="Prestations" description="Gérez les prestations et tarifs utilisés dans les lavages.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-sm text-muted-foreground">Les modifications sont enregistrées dans l’organisation active. Les prix historiques restent figés sur chaque lavage.</p>
            <p className="mt-1 text-xs text-muted-foreground">Chaque prestation est proposée aux <strong>catégories de véhicules autorisées</strong>, avec un tarif propre à chacune. Une catégorie non cochée ne peut pas recevoir la prestation.</p>
          </div>
          {canManage && (
            <div className="flex flex-col items-start gap-1.5">
              <Button onClick={openCreateDialog} disabled={catalogForm.disabled} aria-busy={catalogForm.busy} title={catalogForm.reason ?? undefined}><Plus className="mr-2 size-4" />Nouvelle prestation</Button>
              <BlockedReason reason={catalogForm.reason} className="max-w-72" />
            </div>
          )}
        </div>

        {mutation.success && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{mutation.success}</p>}
        {mutation.error && !dialogOpen && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{mutation.error}</p>}
        {!canManage && member && <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">La création et la modification du catalogue sont réservées au propriétaire et aux responsables.</p>}

        <Card>
          <CardHeader>
            <CardTitle>Catalogue des prestations</CardTitle>
            <CardDescription>{servicesList.length} prestation{servicesList.length === 1 ? "" : "s"} enregistrée{servicesList.length === 1 ? "" : "s"}. Les prestations inactives sont conservées pour l’historique.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher une prestation…" aria-label="Rechercher une prestation" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {canManage && <BlockedReason reason={catalogWrite.reason} />}
            {categoriesError && <p role="alert" className="text-sm text-destructive">Impossible de charger les catégories : {categoriesError}</p>}
            {(loading || categoriesLoading) && <TableSkeleton rows={5} cols={5} label="Synchronisation du catalogue" />}
            {!loading && !error && (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader><TableRow><TableHead>Prestation</TableHead><TableHead>Catégorie</TableHead><TableHead>Durée</TableHead><TableHead className="text-right">Prix</TableHead><TableHead>Statut</TableHead>{canManage && <TableHead className="text-right">Actions</TableHead>}</TableRow></TableHeader>
                  <TableBody>
                    {filteredServices.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={canManage ? 6 : 5} className="p-0">
                          <EmptyState
                            icon={Sparkles}
                            title={servicesList.length === 0 ? "Aucune prestation enregistrée" : "Aucun résultat"}
                            description={
                              servicesList.length === 0
                                ? "Ajoutez vos prestations (lavage extérieur, intérieur, complet…) pour pouvoir enregistrer des lavages."
                                : "Aucune prestation ne correspond à la recherche."
                            }
                          />
                        </TableCell>
                      </TableRow>
                    )}
                    {filteredServices.map((service, index) => (
                      <TableRow
                        key={service.id}
                        /* La ligne en cours de modification s'estompe : le
                           retour est immédiat, avant même la réponse serveur. */
                        className={`row-in transition-all duration-200 ${
                          mutation.busyKey === service.id ? "scale-[0.995] opacity-50" : "hover:bg-muted/40"
                        }`}
                        style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                      >
                        <TableCell className="font-medium">{service.name}</TableCell>
                        <TableCell>{service.category_id ? categoryById.get(service.category_id) ?? "Catégorie archivée" : "—"}</TableCell>
                        <TableCell>{service.duration_minutes ? `${service.duration_minutes} min` : "—"}</TableCell>
                        <TableCell className="text-right">
                          {(() => {
                            const range = configuredPriceRange(service)
                            if (!range) {
                              return <span className="text-xs text-muted-foreground">Non configurée</span>
                            }
                            return (
                              <span className="inline-flex flex-col items-end">
                                <span className="font-medium">dès {formatXof(range.min)}</span>
                                {range.max !== range.min && (
                                  <span className="text-xs text-muted-foreground">jusqu’à {formatXof(range.max)}</span>
                                )}
                              </span>
                            )
                          })()}
                        </TableCell>
                        <TableCell><Badge variant={service.is_active ? "secondary" : "outline"}>{service.is_active ? "Active" : "Inactive"}</Badge></TableCell>
                        {canManage && <TableCell><div className="flex justify-end gap-1">{planStock.allowed && <Button variant="ghost" size="icon" disabled={catalogForm.disabled} title={catalogForm.reason ?? "Ce que cette prestation sort du stock"} aria-label={`Consommables de ${service.name}`} onClick={() => setRecettePour(service)}><Package className="size-4" /></Button>}<Button variant="ghost" size="icon" disabled={catalogForm.disabled} title={catalogForm.reason ?? undefined} aria-label={`Modifier ${service.name}`} onClick={() => openEditDialog(service)}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" title={catalogWrite.reason ?? undefined} disabled={catalogWrite.disabled || mutation.busyKey === service.id} aria-label={service.is_active ? `Désactiver ${service.name}` : `Réactiver ${service.name}`} onClick={() => void toggleService(service)}>{mutation.busyKey === service.id ? <RefreshCw className="size-4 animate-spin" /> : service.is_active ? <ToggleLeft className="size-4" /> : <ToggleRight className="size-4" />}</Button><Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" title={catalogWrite.reason ?? "Supprimer définitivement cette prestation"} disabled={catalogWrite.disabled || mutation.busyKey === service.id} aria-label={`Supprimer ${service.name}`} onClick={() => void deleteService(service)}><Trash2 className="size-4" /></Button></div></TableCell>}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingService ? "Modifier la prestation" : "Nouvelle prestation"}</DialogTitle>
            <DialogDescription>Les changements sont enregistrés immédiatement pour la station active.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveService} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">Type de service
                <Select value={form.template_id} onValueChange={applyTemplate}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Prestation personnalisée" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">
                      {form.template_id === "custom" && form.name
                        ? `Type personnalisé — ${form.name}`
                        : "Prestation personnalisée…"}
                    </SelectItem>
                    {(templates ?? []).map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs font-normal text-muted-foreground">
                  Le nom de la prestation vient du type choisi. Un type maison se crée dans
                  « Ajouter un type de service au catalogue ».
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">Catégorie de service
                <Select value={form.category_id ?? "none"} onValueChange={(value) => setForm((previous) => ({ ...previous, category_id: value && value !== "none" ? String(value) : null }))}>
                  <SelectTrigger><SelectValue placeholder="Sans catégorie" /></SelectTrigger>
                  <SelectContent><SelectItem value="none">Sans catégorie</SelectItem>{availableCategories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}{category.is_active ? "" : " (inactive)"}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">Durée (minutes)<Input type="number" min={1} max={1440} step={1} value={form.duration_minutes} onChange={(event) => setForm((previous) => ({ ...previous, duration_minutes: event.target.value }))} placeholder="Facultatif" /></label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">Description
                <Input maxLength={1000} value={form.description} onChange={(event) => setForm((previous) => ({ ...previous, description: event.target.value }))} placeholder="Une phrase reprise sur la fiche de la prestation" />
              </label>
            </div>

            <fieldset className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Catégories de véhicules autorisées</legend>
              <p className="mb-3 text-xs text-muted-foreground">
                Sélectionnez les catégories de véhicules pouvant bénéficier de cette prestation.
                Définissez ensuite un tarif pour chaque catégorie sélectionnée.
              </p>
              {vehicleGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Aucune catégorie de véhicule configurée. Ajoutez-en dans Configuration ›
                  Catégories de véhicules avant de créer une prestation.
                </p>
              ) : (
                <div className="space-y-4">
                  {vehicleGroups.map((group) => (
                    <div key={group.code || "sans-famille"}>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {group.categories.map((category) => {
                          const checked = Boolean(form.enabled[category.id])
                          const priceId = `prix-${category.id}`
                          return (
                            <div
                              key={category.id}
                              className={`flex flex-col gap-1.5 rounded-md border p-2.5 text-sm transition-colors ${
                                checked ? "border-primary/60 bg-primary/5" : "bg-muted/30"
                              }`}
                            >
                              <label className="flex items-center gap-2 font-medium">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={() => toggleCategory(category.id)}
                                  id={`cat-${category.id}`}
                                />
                                <span>
                                  {category.name}
                                  {category.is_active ? "" : " — catégorie désactivée"}
                                </span>
                              </label>
                              {checked && (
                                <label className="flex flex-col gap-1 text-xs" htmlFor={priceId}>
                                  <span className="text-muted-foreground">Prix en FCFA</span>
                                  <Input
                                    id={priceId}
                                    type="number"
                                    min={0}
                                    step="any"
                                    inputMode="decimal"
                                    value={form.priceDrafts[category.id] ?? ""}
                                    onChange={(event) => setPriceDraft(category.id, event.target.value)}
                                    placeholder="Ex. 5 000"
                                    aria-label={`Prix en FCFA pour ${category.name}`}
                                  />
                                </label>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </fieldset>

            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleDialogChange(false)} disabled={saving}>Annuler</Button>
              <Button type="submit" disabled={saving || !form.name.trim() || enabledCount === 0}>{saving && <RefreshCw className="mr-2 size-4 animate-spin" />}{editingService ? "Enregistrer" : "Créer la prestation"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={customDialogOpen} onOpenChange={(next) => { if (!next) setCustomDialogOpen(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter un type de service au catalogue</DialogTitle>
            <DialogDescription>
              Ce type devient le nom de la prestation. Pour un tarif différent selon les véhicules,
              cela se règle ensuite dans « Catégories de véhicules autorisées ».
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium">Nom du type
              <Input required maxLength={100} value={customType.name} onChange={(event) => setCustomType((previous) => ({ ...previous, name: event.target.value }))} placeholder="Ex. Lustrage carrosserie" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">Catégorie de service
              <Select value={customType.category_id ?? "none"} onValueChange={(value) => setCustomType((previous) => ({ ...previous, category_id: value && value !== "none" ? String(value) : null }))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Sans catégorie" /></SelectTrigger>
                <SelectContent><SelectItem value="none">Sans catégorie</SelectItem>{availableCategories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">Durée (minutes)
              <Input type="number" min={1} max={1440} step={1} value={customType.duration_minutes} onChange={(event) => setCustomType((previous) => ({ ...previous, duration_minutes: event.target.value }))} placeholder="Facultatif" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">Description
              <Input maxLength={1000} value={customType.description} onChange={(event) => setCustomType((previous) => ({ ...previous, description: event.target.value }))} placeholder="Facultatif" />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCustomDialogOpen(false)}>Annuler</Button>
            <Button type="button" onClick={confirmCustomType} disabled={!customType.name.trim()}>Ajouter au catalogue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConsumablesDialog
        serviceId={recettePour?.id ?? null}
        serviceName={recettePour?.name ?? ""}
        open={recettePour !== null}
        onOpenChange={(next) => { if (!next) setRecettePour(null) }}
      />
    </BaseLayout>
  )
}
