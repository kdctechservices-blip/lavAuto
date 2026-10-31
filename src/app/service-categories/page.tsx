"use client"

import type * as React from "react"

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
import { Pencil, Plus, RefreshCw, ToggleLeft, ToggleRight } from "lucide-react"

interface ServiceCategory {
  id: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Clé d'occupation du formulaire, distincte des clés de ligne. */
const FORM_KEY = "formulaire"

export default function ServiceCategoriesPage() {
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
  const { data, loading, error } = useApi<ServiceCategory[]>(`/api/v1/service-categories?refresh=${refreshKey}`)
  const { data: member } = useApi<CurrentMember>(`/api/v1/auth/me?refresh=${refreshKey}`)
  const categories = useMemo(() => data ?? [], [data])
  const canManage = member?.role === "owner" || member?.role === "manager"
  const activeCount = useMemo(() => categories.filter((category) => category.is_active).length, [categories])

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<ServiceCategory | null>(null)
  const [name, setName] = useState("")
  const [search, setSearch] = useState("")
  // Un seul contrôleur remplace « saving », la clé de ligne occupée et les
  // deux messages : c'est la même écriture, elle n'avait pas à vivre en
  // quatre états qu'il fallait penser à synchroniser.
  const mutation = useMutation()
  const saving = mutation.busyKey === FORM_KEY

  const filteredCategories = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr-CI")
    return categories.filter((category) => !query || category.name.toLocaleLowerCase("fr-CI").includes(query))
  }, [categories, search])

  function openCreateDialog() {
    setEditingCategory(null)
    setName("")
    mutation.reset()
    setDialogOpen(true)
  }

  function openEditDialog(category: ServiceCategory) {
    setEditingCategory(category)
    setName(category.name)
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
        ? `/api/v1/service-categories/${encodeURIComponent(editingCategory.id)}`
        : "/api/v1/service-categories",
      method: editingCategory ? "PATCH" : "POST",
      body: { name: cleanName, is_active: editingCategory?.is_active ?? true },
      success: editingCategory
        ? "Catégorie de prestation mise à jour."
        : "Catégorie de prestation créée.",
      failure: "Impossible d’enregistrer la catégorie.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setDialogOpen(false)
    setRefreshKey((key) => key + 1)
  }

  async function toggleCategory(category: ServiceCategory) {
    const nextStatus = !category.is_active
    const outcome = await mutation.run({
      url: `/api/v1/service-categories/${encodeURIComponent(category.id)}`,
      method: "PATCH",
      body: { is_active: nextStatus },
      confirm: nextStatus
        ? undefined
        : `Désactiver « ${category.name} » ? Les prestations et lavages historiques seront conservés.`,
      success: nextStatus ? "Catégorie réactivée." : "Catégorie désactivée.",
      failure: "Impossible de modifier la catégorie.",
      busyKey: category.id,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  return (
    <BaseLayout title="Catégories de prestations" description="Organisez le catalogue des prestations de lavage.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">Les catégories permettent de classer les prestations. La désactivation les retire des nouvelles sélections sans supprimer l’historique.</p>
          {canManage && (
            <div className="flex flex-col items-start gap-1.5">
              <Button onClick={openCreateDialog} disabled={catalogForm.disabled} aria-busy={catalogForm.busy} title={catalogForm.reason ?? undefined}><Plus className="mr-2 size-4" />Nouvelle catégorie</Button>
              <BlockedReason reason={catalogForm.reason} className="max-w-72" />
            </div>
          )}
        </div>
        {mutation.success && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{mutation.success}</p>}
        {mutation.error && !dialogOpen && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{mutation.error}</p>}
        {!canManage && member && <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">La modification du catalogue est réservée au propriétaire et aux responsables.</p>}

        <Card>
          <CardHeader><CardTitle>Catégories de prestations</CardTitle><CardDescription>{activeCount} active{activeCount === 1 ? "" : "s"} sur {categories.length} enregistrée{categories.length === 1 ? "" : "s"}.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <Input className="max-w-md" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher une catégorie…" aria-label="Rechercher une catégorie" />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {canManage && <BlockedReason reason={catalogWrite.reason} />}
            {loading && <TableSkeleton rows={4} cols={3} label="Synchronisation des catégories" />}
            {!loading && !error && (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader><TableRow><TableHead>Nom</TableHead><TableHead>Statut</TableHead>{canManage && <TableHead className="text-right">Actions</TableHead>}</TableRow></TableHeader>
                  <TableBody>
                    {filteredCategories.length === 0 && <TableRow><TableCell colSpan={canManage ? 3 : 2} className="h-24 text-center text-muted-foreground">{categories.length === 0 ? "Aucune catégorie. Créez-en une pour structurer les prestations." : "Aucune catégorie ne correspond à la recherche."}</TableCell></TableRow>}
                    {filteredCategories.map((category, index) => (
                      <TableRow key={category.id} className="row-in" style={{ "--row": Math.min(index, 10) } as React.CSSProperties}>
                        <TableCell className="font-medium">{category.name}</TableCell>
                        <TableCell><Badge variant={category.is_active ? "secondary" : "outline"}>{category.is_active ? "Active" : "Inactive"}</Badge></TableCell>
                        {canManage && <TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" disabled={catalogForm.disabled} title={catalogForm.reason ?? undefined} aria-label={`Modifier ${category.name}`} onClick={() => openEditDialog(category)}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" title={catalogWrite.reason ?? undefined} disabled={catalogWrite.disabled || mutation.busyKey === category.id} aria-label={category.is_active ? `Désactiver ${category.name}` : `Réactiver ${category.name}`} onClick={() => void toggleCategory(category)}>{mutation.busyKey === category.id ? <RefreshCw className="size-4 animate-spin" /> : category.is_active ? <ToggleLeft className="size-4" /> : <ToggleRight className="size-4" />}</Button></div></TableCell>}
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editingCategory ? "Modifier la catégorie" : "Nouvelle catégorie"}</DialogTitle><DialogDescription>Les changements sont enregistrés immédiatement et reflétés dans le catalogue des prestations.</DialogDescription></DialogHeader>
          <form onSubmit={saveCategory} className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium">Nom de la catégorie<Input required autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Extérieur, Intérieur, Premium" /></label>
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleDialogChange(false)} disabled={saving}>Annuler</Button>
              <Button type="submit" disabled={saving || !name.trim()}>{saving && <RefreshCw className="mr-2 size-4 animate-spin" />}{editingCategory ? "Enregistrer" : "Créer la catégorie"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
