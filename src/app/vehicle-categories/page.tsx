"use client"

import * as React from "react"
import { useMemo, useState, type FormEvent } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { Badge } from "@/components/ui/badge"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { Button } from "@/components/ui/button"
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
import { Checkbox } from "@/components/ui/checkbox"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import type { CurrentMember } from "@/lib/team-api"
import {
  VEHICLE_FAMILIES,
  familyLabel,
  familyOrder,
  sortVehicleCategories,
} from "@/config/vehicle-taxonomy"
import { Pencil, Plus, RefreshCw, Search, ToggleLeft, ToggleRight } from "lucide-react"

/**
 * Catégories de véhicules.
 *
 * Le référentiel est plat en base (une ligne par catégorie) mais l'écran le
 * présente par **familles** : c'est à ce niveau qu'un gérant raisonne, et
 * c'est à ce niveau que les tarifs des prestations se saisissent. Ajouter une
 * catégorie ne se fait plus à la main, un nom à la fois : la station pioche
 * dans la liste de référence (61 types, 9 familles), famille par famille.
 */

interface VehicleCategory {
  id: string
  name: string
  family: string | null
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

interface CatalogType {
  code: string
  name: string
  category_id: string | null
  added: boolean
}

interface CatalogFamily {
  code: string
  label: string
  description: string
  types: CatalogType[]
}

interface CatalogResponse {
  families: CatalogFamily[]
  total_types: number
  total_categories: number
  added_types: number
}

/** Clé d'occupation du formulaire, distincte des clés de ligne. */
const FORM_KEY = "formulaire"
/** Clé d'occupation de l'ajout en lot. */
const IMPORT_KEY = "import"

const UNKNOWN_FAMILY = "sans_famille"

export default function VehicleCategoriesPage() {
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
  const { data, loading, error } = useApi<VehicleCategory[]>(`/api/v1/vehicle-categories?refresh=${refreshKey}`)
  const { data: catalog } = useApi<CatalogResponse>(`/api/v1/vehicle-categories/catalog?refresh=${refreshKey}`)
  const { data: member } = useApi<CurrentMember>(`/api/v1/auth/me?refresh=${refreshKey}`)
  const categories = useMemo(() => data ?? [], [data])
  const canManage = member?.role === "owner" || member?.role === "manager"
  const activeCount = useMemo(() => categories.filter((category) => category.is_active).length, [categories])

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<VehicleCategory | null>(null)
  const [name, setName] = useState("")
  const [family, setFamily] = useState<string>("")
  const [search, setSearch] = useState("")
  // Un seul contrôleur remplace « saving », la clé de ligne occupée et les
  // deux messages : c'est la même écriture, il n'y avait pas à la découper.
  const mutation = useMutation()
  const saving = mutation.busyKey === FORM_KEY

  const filteredCategories = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr-CI")
    if (!query) return categories
    return categories.filter((category) => {
      const label = familyLabel(category.family) ?? "Sans famille"
      return (
        category.name.toLocaleLowerCase("fr-CI").includes(query) ||
        label.toLocaleLowerCase("fr-CI").includes(query)
      )
    })
  }, [categories, search])

  /**
   * Les catégories rangées par famille, dans l'ordre du référentiel.
   *
   * Une catégorie dont la famille est inconnue ou vide atterrit dans un
   * dernier groupe « Sans famille » : elle doit rester visible et modifiable,
   * pas disparaître du tableau parce que son code ne correspond à rien.
   */
  const grouped = useMemo(() => {
    const byFamily = new Map<string, VehicleCategory[]>()
    for (const category of filteredCategories) {
      const key = category.family && familyLabel(category.family) ? category.family : UNKNOWN_FAMILY
      const bucket = byFamily.get(key)
      if (bucket) bucket.push(category)
      else byFamily.set(key, [category])
    }
    return [...byFamily.entries()]
      .map(([key, rows]) => ({ key, rows: sortVehicleCategories(rows) }))
      .sort((a, b) => familyOrder(a.key === UNKNOWN_FAMILY ? null : a.key) - familyOrder(b.key === UNKNOWN_FAMILY ? null : b.key))
  }, [filteredCategories])

  const familiesUsed = useMemo(
    () => new Set(categories.map((category) => category.family).filter((code): code is string => Boolean(code))),
    [categories],
  )
  const familiesUnused = VEHICLE_FAMILIES.filter((item) => !familiesUsed.has(item.code))

  // --- Ajout depuis le référentiel -----------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [pickerSearch, setPickerSearch] = useState("")
  const importing = mutation.busyKey === IMPORT_KEY

  const pickerFamilies = useMemo(() => {
    const query = pickerSearch.trim().toLocaleLowerCase("fr-CI")
    return (catalog?.families ?? [])
      .map((item) => ({
        ...item,
        types: item.types.filter(
          (type) => !query || type.name.toLocaleLowerCase("fr-CI").includes(query),
        ),
      }))
      .filter((item) => item.types.length > 0)
  }, [catalog, pickerSearch])

  function openPicker() {
    mutation.reset()
    setPicked([])
    setPickerSearch("")
    setPickerOpen(true)
  }

  function toggleType(code: string) {
    setPicked((previous) =>
      previous.includes(code) ? previous.filter((item) => item !== code) : [...previous, code],
    )
  }

  /**
   * Coche ou décoche toute une famille.
   *
   * On n'ajoute que les types absents : recocher une famille déjà utilisée ne
   * doit pas reproposer des doublons que le serveur refuserait.
   */
  function toggleFamily(family: CatalogFamily) {
    const available = family.types.filter((type) => !type.added).map((type) => type.code)
    const allPicked = available.length > 0 && available.every((code) => picked.includes(code))
    setPicked((previous) =>
      allPicked
        ? previous.filter((code) => !available.includes(code))
        : [...new Set([...previous, ...available])],
    )
  }

  async function importSelection() {
    if (picked.length === 0) return
    const outcome = await mutation.run({
      url: "/api/v1/vehicle-categories/catalog",
      method: "POST",
      body: { types: picked },
      success:
        picked.length > 1
          ? `${picked.length} types de véhicules ajoutés.`
          : "Type de véhicule ajouté.",
      failure: "Impossible d’ajouter ces types de véhicules.",
      busyKey: IMPORT_KEY,
    })
    if (!outcome.ok) return
    setPickerOpen(false)
    setPicked([])
    setRefreshKey((key) => key + 1)
  }

  // --- Création / édition ---------------------------------------------------
  function openCreateDialog() {
    setEditingCategory(null)
    setName("")
    setFamily("")
    mutation.reset()
    setDialogOpen(true)
  }

  function openEditDialog(category: VehicleCategory) {
    setEditingCategory(category)
    setName(category.name)
    setFamily(category.family ?? "")
    mutation.reset()
    setDialogOpen(true)
  }

  function handleDialogChange(open: boolean) {
    if (open) setDialogOpen(true)
    else if (!saving) {
      setDialogOpen(false)
      mutation.reset()
    }
  }

  async function saveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 100) {
      mutation.fail("Saisissez un nom de catégorie de 1 à 100 caractères.")
      return
    }
    const outcome = await mutation.run({
      url: editingCategory
        ? `/api/v1/vehicle-categories/${encodeURIComponent(editingCategory.id)}`
        : "/api/v1/vehicle-categories",
      method: editingCategory ? "PATCH" : "POST",
      body: {
        name: cleanName,
        family: family || null,
        is_active: editingCategory?.is_active ?? true,
      },
      success: editingCategory ? "Catégorie mise à jour." : "Catégorie créée.",
      failure: "Impossible d’enregistrer la catégorie.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setDialogOpen(false)
    setRefreshKey((key) => key + 1)
  }

  async function toggleCategory(category: VehicleCategory) {
    const nextStatus = !category.is_active
    const outcome = await mutation.run({
      url: `/api/v1/vehicle-categories/${encodeURIComponent(category.id)}`,
      method: "PATCH",
      body: { is_active: nextStatus },
      confirm: nextStatus
        ? undefined
        : `Désactiver « ${category.name} » ? Les lavages déjà enregistrés conserveront leur historique.`,
      success: nextStatus ? "Catégorie réactivée." : "Catégorie désactivée.",
      failure: "Impossible de modifier la catégorie.",
      busyKey: category.id,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  const remainingTypes = (catalog?.total_types ?? 0) - (catalog?.added_types ?? 0)

  return (
    <BaseLayout title="Catégories de véhicules" description="Gérez les catégories de véhicules utilisées lors de la création d’un lavage.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <p className="text-sm text-muted-foreground">
              Chaque catégorie appartient à une <strong>famille</strong> (deux-roues, SUV, poids lourds…).
              C’est la famille qui porte les tarifs différenciés des prestations.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              La désactivation masque une catégorie des nouveaux lavages sans effacer les anciens enregistrements.
            </p>
          </div>
          {canManage && (
            <div className="flex flex-col items-start gap-1.5">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={openPicker} disabled={catalogForm.disabled} aria-busy={catalogForm.busy} title={catalogForm.reason ?? undefined}>
                  <Search className="mr-2 size-4" />Parcourir le référentiel
                </Button>
                <Button onClick={openCreateDialog} disabled={catalogForm.disabled} aria-busy={catalogForm.busy} title={catalogForm.reason ?? undefined}>
                  <Plus className="mr-2 size-4" />Nouvelle catégorie
                </Button>
              </div>
              <BlockedReason reason={catalogForm.reason} className="max-w-72" />
            </div>
          )}
        </div>
        {mutation.success && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{mutation.success}</p>}
        {mutation.error && !dialogOpen && !pickerOpen && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{mutation.error}</p>}
        {!canManage && member && <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">La modification du catalogue est réservée au propriétaire et aux responsables.</p>}

        <Card>
          <CardHeader>
            <CardTitle>Catégories</CardTitle>
            <CardDescription>
              {activeCount} active{activeCount === 1 ? "" : "s"} sur {categories.length} enregistrée{categories.length === 1 ? "" : "s"}
              {catalog ? ` · ${catalog.added_types} des ${catalog.total_types} types du référentiel` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Rechercher un véhicule ou une famille…"
                aria-label="Rechercher une catégorie de véhicule"
              />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {canManage && <BlockedReason reason={catalogWrite.reason} />}
            {loading && <TableSkeleton rows={4} cols={3} label="Synchronisation des catégories" />}
            {!loading && !error && (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Véhicule</TableHead>
                      <TableHead>Famille</TableHead>
                      <TableHead>Statut</TableHead>
                      {canManage && <TableHead className="text-right">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grouped.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={canManage ? 4 : 3} className="h-24 text-center text-muted-foreground">
                          {categories.length === 0
                            ? "Aucune catégorie enregistrée. Ajoutez les types de véhicules pris en charge."
                            : "Aucune catégorie ne correspond à la recherche."}
                        </TableCell>
                      </TableRow>
                    )}
                    {grouped.map((group) => (
                      <React.Fragment key={group.key}>
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell colSpan={canManage ? 4 : 3} className="py-2">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="text-sm font-semibold">
                                {group.key === UNKNOWN_FAMILY ? "Sans famille" : familyLabel(group.key)}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {group.rows.length} catégorie{group.rows.length === 1 ? "" : "s"}
                                {group.key === UNKNOWN_FAMILY
                                  ? " · à rattacher à une famille pour recevoir un tarif"
                                  : ` · ${VEHICLE_FAMILIES.find((item) => item.code === group.key)?.description ?? ""}`}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                        {group.rows.map((category, index) => (
                          <TableRow key={category.id} className="row-in" style={{ "--row": Math.min(index, 10) } as React.CSSProperties}>
                            <TableCell className="font-medium">{category.name}</TableCell>
                            <TableCell className="text-muted-foreground">{familyLabel(category.family) ?? "—"}</TableCell>
                            <TableCell><Badge variant={category.is_active ? "secondary" : "outline"}>{category.is_active ? "Active" : "Inactive"}</Badge></TableCell>
                            {canManage && (
                              <TableCell>
                                <div className="flex justify-end gap-1">
                                  <Button variant="ghost" size="icon" disabled={catalogForm.disabled} title={catalogForm.reason ?? undefined} aria-label={`Modifier ${category.name}`} onClick={() => openEditDialog(category)}><Pencil className="size-4" /></Button>
                                  <Button variant="ghost" size="icon" title={catalogWrite.reason ?? undefined} disabled={catalogWrite.disabled || mutation.busyKey === category.id} aria-label={category.is_active ? `Désactiver ${category.name}` : `Réactiver ${category.name}`} onClick={() => void toggleCategory(category)}>{mutation.busyKey === category.id ? <RefreshCw className="size-4 animate-spin" /> : category.is_active ? <ToggleLeft className="size-4" /> : <ToggleRight className="size-4" />}</Button>
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {!loading && !error && familiesUnused.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Familles encore inutilisées : {familiesUnused.map((item) => item.label).join(", ")}.
                {remainingTypes > 0 && ` ${remainingTypes} types disponibles dans le référentiel.`}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* -------------------------------------------------- formulaire ------ */}
      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCategory ? "Modifier la catégorie" : "Nouvelle catégorie"}</DialogTitle>
            <DialogDescription>Les changements sont enregistrés immédiatement et utilisés par les nouveaux lavages.</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveCategory} className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Nom de la catégorie
              <Input required autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Berline moyenne, Moto, Camion-benne" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Famille
              <Select value={family || "none"} onValueChange={(value) => setFamily(!value || value === "none" ? "" : String(value))}>
                <SelectTrigger><SelectValue placeholder="Sans famille" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sans famille</SelectItem>
                  {VEHICLE_FAMILIES.map((item) => (
                    <SelectItem key={item.code} value={item.code}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs font-normal text-muted-foreground">
                La famille détermine le tarif appliqué si la prestation en prévoit un.
              </span>
            </label>
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleDialogChange(false)} disabled={saving}>Annuler</Button>
              <Button type="submit" disabled={saving || !name.trim()}>{saving && <RefreshCw className="mr-2 size-4 animate-spin" />}{editingCategory ? "Enregistrer" : "Créer la catégorie"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* --------------------------------------- référentiel (ajout en lot) - */}
      <Dialog open={pickerOpen} onOpenChange={(open) => { if (!importing) setPickerOpen(open) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Ajouter des véhicules</DialogTitle>
            <DialogDescription>
              Cochez les types pris en charge par la station. Les catégories déjà présentes sont barrées et ne seront pas ajoutées deux fois.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={pickerSearch}
                onChange={(event) => setPickerSearch(event.target.value)}
                placeholder="Filtrer les types (ex. bus, pick-up, électrique…)"
                aria-label="Filtrer le référentiel"
              />
            </div>

            <div className="space-y-4">
              {pickerFamilies.length === 0 && (
                <p className="text-sm text-muted-foreground">Aucun type ne correspond à ce filtre.</p>
              )}
              {pickerFamilies.map((item) => {
                const available = item.types.filter((type) => !type.added)
                const allPicked = available.length > 0 && available.every((type) => picked.includes(type.code))
                return (
                  <section key={item.code} className="rounded-lg border">
                    <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                      <div>
                        <p className="text-sm font-semibold">{item.label}</p>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                      {available.length > 0 ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => toggleFamily(item)}>
                          {allPicked ? "Tout retirer" : "Toute la famille"}
                        </Button>
                      ) : (
                        <Badge variant="outline">Complète</Badge>
                      )}
                    </header>
                    <div className="grid gap-1 p-2 sm:grid-cols-2">
                      {item.types.map((type) => {
                        const checked = type.added || picked.includes(type.code)
                        return (
                          <label
                            key={type.code}
                            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                              type.added ? "cursor-default text-muted-foreground" : "cursor-pointer hover:bg-muted/50"
                            }`}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={type.added}
                              onCheckedChange={() => { if (!type.added) toggleType(type.code) }}
                              aria-label={type.name}
                            />
                            <span className={type.added ? "line-through" : undefined}>{type.name}</span>
                            {type.added && <span className="ml-auto text-xs">déjà ajouté</span>}
                          </label>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          </div>

          {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}

          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {picked.length === 0 ? "Aucun type sélectionné" : `${picked.length} type${picked.length === 1 ? "" : "s"} à ajouter`}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setPickerOpen(false)} disabled={importing}>Annuler</Button>
              <Button type="button" onClick={() => void importSelection()} disabled={importing || picked.length === 0}>
                {importing && <RefreshCw className="mr-2 size-4 animate-spin" />}
                Ajouter {picked.length > 0 ? `(${picked.length})` : ""}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
