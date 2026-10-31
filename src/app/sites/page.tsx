"use client"

import { useMemo, useState, type FormEvent } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { Badge } from "@/components/ui/badge"
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
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import { DowngradeNotice } from "@/components/subscription/plan-gate"
import { useSubscription } from "@/lib/subscription"
import {
  emptySiteInput,
  siteInputFrom,
  type SiteInput,
  type SiteRecord,
} from "@/lib/sites-api"
import {
  Building2,
  MapPin,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
} from "lucide-react"

/** Clé d'occupation du formulaire. */
const FORM_KEY = "formulaire"

export default function SitesPage() {
  const canManage = useAccess("settings:manage")
  // Modifier ouvre un formulaire ; désactiver et supprimer écrivent aussitôt.
  const siteForm = actionGate({
    loading: canManage.loading,
    allowed: canManage.allowed,
    reason: canManage.reason,
  })
  const siteWrite = actionGate({
    loading: canManage.loading,
    allowed: canManage.allowed,
    reason: canManage.reason,
    writesImmediately: true,
  })
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, loading, error } = useApi<SiteRecord[]>(`/api/v1/sites?refresh=${refreshKey}`)
  const { state: subscription } = useSubscription()

  const sites = useMemo(() => data ?? [], [data])
  const activeSites = useMemo(() => sites.filter((site) => site.is_active), [sites])
  const siteLimit = subscription?.limits?.sites.limit
  const limitState = subscription?.limits?.sites
  const limitReached = limitState?.creation_blocked ?? false

  // Le plafond de stations du forfait n'est pas un refus de droit.
  const createSite = actionGate({
    loading: canManage.loading,
    allowed: canManage.allowed,
    reason: canManage.reason,
    blockedBy: limitReached
      ? `Votre forfait autorise ${siteLimit} station${(siteLimit ?? 0) > 1 ? "s" : ""} active${(siteLimit ?? 0) > 1 ? "s" : ""}. Désactivez-en une ou changez de forfait.`
      : null,
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingSite, setEditingSite] = useState<SiteRecord | null>(null)
  const [form, setForm] = useState<SiteInput>(emptySiteInput)
  // Un contrôleur unique : occupation, ligne concernée et deux messages.
  const mutation = useMutation()
  const saving = mutation.busyKey === FORM_KEY
  const busySiteId = mutation.busyKey

  function openCreateDialog() {
    setEditingSite(null)
    setForm(emptySiteInput())
    mutation.reset()
    setDialogOpen(true)
  }

  function openEditDialog(site: SiteRecord) {
    setEditingSite(site)
    setForm(siteInputFrom(site))
    mutation.reset()
    setDialogOpen(true)
  }

  function handleDialogChange(open: boolean) {
    if (!open && !saving) {
      setDialogOpen(false)
      mutation.reset()
    } else if (open) {
      setDialogOpen(true)
    }
  }

  async function saveSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    mutation.reset()
    const input: SiteInput = {
      ...form,
      name: form.name.trim(),
      city: form.city.trim(),
      address: form.address?.trim() || null,
      phone: form.phone?.trim() || null,
      email: form.email?.trim() || null,
      description: form.description?.trim() || null,
    }
    if (!input.name || !input.city) {
      mutation.fail("Le nom et la ville de la station sont obligatoires.")
      return
    }

    const outcome = await mutation.run({
      url: editingSite ? `/api/v1/sites/${encodeURIComponent(editingSite.id)}` : "/api/v1/sites",
      method: editingSite ? "PATCH" : "POST",
      body: input,
      success: editingSite ? "La station a été mise à jour." : "La station a été ajoutée.",
      failure: "Impossible d’enregistrer la station.",
      busyKey: FORM_KEY,
    })
    if (!outcome.ok) return
    setDialogOpen(false)
    setRefreshKey((key) => key + 1)
  }

  /**
   * Désactiver plutôt que supprimer : une station fermée garde ses lavages,
   * ses caisses et ses dépenses dans les rapports des mois précédents.
   */
  async function toggleSite(site: SiteRecord) {
    const next = !site.is_active
    const outcome = await mutation.run({
      url: `/api/v1/sites/${encodeURIComponent(site.id)}`,
      method: "PATCH",
      body: { is_active: next },
      confirm: next
        ? undefined
        : `Désactiver « ${site.name} » ? Elle disparaîtra des nouveaux enregistrements, mais son historique reste dans les rapports.`,
      success: next ? "La station a été réactivée." : "La station a été désactivée.",
      failure: "Impossible de modifier la station.",
      busyKey: site.id,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  /**
   * La suppression n'est utile que pour une station créée par erreur. Dès
   * qu'un lavage l'a référencée, le serveur répond 409 et oriente vers la
   * désactivation — on relaie son message tel quel.
   */
  async function deleteSite(site: SiteRecord) {
    const outcome = await mutation.run({
      url: `/api/v1/sites/${encodeURIComponent(site.id)}`,
      method: "DELETE",
      confirm: `Supprimer définitivement « ${site.name} » ? Cette action n’est possible que si aucune activité n’y est rattachée.`,
      success: "La station a été supprimée.",
      failure: "Impossible de supprimer la station.",
      busyKey: site.id,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  return (
    <BaseLayout
      title="Stations"
      description="Gérez les points de lavage de votre organisation."
    >
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Chaque lavage, session de caisse et dépense est rattaché à une station.
            C’est ce rattachement qui permet de comparer les points de vente dans
            les rapports.
          </p>
          <div className="flex flex-col items-start gap-1.5">
            <Button
              onClick={openCreateDialog}
              title={createSite.reason ?? undefined}
              aria-busy={createSite.busy}
              disabled={createSite.disabled}
            >
              <Plus className="mr-2 size-4" /> Ajouter une station
            </Button>
            <BlockedReason reason={createSite.reason} className="max-w-80" />
          </div>
        </div>

        {mutation.success && (
          <p
            role="status"
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
          >
            {mutation.success}
          </p>
        )}
        {mutation.error && !dialogOpen && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {mutation.error}
          </p>
        )}

        {limitState?.over_limit && (
          <DowngradeNotice
            limit={limitState.limit ?? 0}
            activeCount={limitState.active_count}
            excess={limitState.excess}
            graceDaysRemaining={limitState.grace_days_remaining}
            enforced={limitState.enforced}
          />
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription>Stations actives</CardDescription>
              <Building2 className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{loading ? "…" : activeSites.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription>Limite du forfait</CardDescription>
              <Building2 className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">
                {subscription ? (siteLimit == null ? "Illimité" : siteLimit) : "—"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription>Inactives</CardDescription>
              <PowerOff className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">
                {loading ? "…" : sites.length - activeSites.length}
              </p>
            </CardContent>
          </Card>
        </div>

        {limitReached && !limitState?.over_limit && canManage.allowed && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            La limite de {siteLimit} station{(siteLimit ?? 0) > 1 ? "s" : ""} active
            {(siteLimit ?? 0) > 1 ? "s" : ""} de votre forfait est atteinte. Désactivez une
            station ou passez à un forfait supérieur pour en ouvrir une nouvelle.
          </p>
        )}

        {!canManage.allowed && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            La création et la modification des stations sont réservées au propriétaire.
            Vous pouvez consulter la liste ci-dessous.
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="size-4" /> Points de lavage
            </CardTitle>
            <CardDescription>
              Une station inactive reste visible dans les rapports historiques.
            </CardDescription>
          </CardHeader>
          <CardContent aria-busy={loading}>
            <BlockedReason reason={siteWrite.reason} className="mb-3" />
            {loading ? (
              <TableSkeleton rows={3} cols={4} label="Chargement des stations" />
            ) : sites.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="Aucune station enregistrée"
                description="Ajoutez votre premier point de lavage pour commencer à y rattacher des opérations."
                action={
                  canManage.allowed ? (
                    <Button onClick={openCreateDialog}>
                      <Plus className="mr-2 size-4" /> Ajouter une station
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nom</TableHead>
                      <TableHead>Ville</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Statut</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sites.map((site) => (
                      <TableRow key={site.id}>
                        <TableCell>
                          <p className="font-medium">{site.name}</p>
                          {site.address && (
                            <p className="text-xs text-muted-foreground">{site.address}</p>
                          )}
                        </TableCell>
                        <TableCell>{site.city}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {site.phone || site.email || "—"}
                        </TableCell>
                        <TableCell>
                          {!site.is_active ? (
                            <Badge variant="secondary">Inactive</Badge>
                          ) : site.writable === false ? (
                            // Au-delà du forfait : l'historique reste lisible,
                            // mais plus aucune opération ne peut s'y ajouter.
                            <Badge
                              variant="outline"
                              className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
                              title="Au-delà de votre forfait : consultable et exportable, mais fermée aux nouvelles opérations."
                            >
                              Lecture seule
                            </Badge>
                          ) : (
                            <Badge variant="outline">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Modifier ${site.name}`}
                              title={siteForm.reason ?? undefined}
                              disabled={siteForm.disabled || busySiteId === site.id}
                              onClick={() => openEditDialog(site)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={
                                site.is_active
                                  ? `Désactiver ${site.name}`
                                  : `Réactiver ${site.name}`
                              }
                              title={siteWrite.reason ?? undefined}
                              disabled={siteWrite.disabled || busySiteId === site.id}
                              onClick={() => toggleSite(site)}
                            >
                              {site.is_active ? (
                                <PowerOff className="size-4" />
                              ) : (
                                <Power className="size-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Supprimer ${site.name}`}
                              title={siteWrite.reason ?? undefined}
                              disabled={siteWrite.disabled || busySiteId === site.id}
                              onClick={() => deleteSite(site)}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
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
            <DialogTitle>
              {editingSite ? "Modifier la station" : "Ajouter une station"}
            </DialogTitle>
            <DialogDescription>
              Le nom et la ville suffisent pour démarrer ; les autres champs
              apparaissent sur les documents remis aux clients.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveSite} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Nom de la station <span className="sr-only">obligatoire</span>
                <Input
                  required
                  maxLength={150}
                  value={form.name}
                  placeholder="Station Cocody Riviera"
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, name: event.target.value }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Ville <span className="sr-only">obligatoire</span>
                <Input
                  required
                  maxLength={100}
                  value={form.city}
                  placeholder="Abidjan"
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, city: event.target.value }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                Adresse
                <Input
                  maxLength={255}
                  value={form.address ?? ""}
                  placeholder="Rue des Jardins, face à la pharmacie"
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      address: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Téléphone
                <Input
                  type="tel"
                  maxLength={50}
                  value={form.phone ?? ""}
                  placeholder="+225 …"
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      phone: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                E-mail
                <Input
                  type="email"
                  maxLength={255}
                  value={form.email ?? ""}
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      email: event.target.value || null,
                    }))
                  }
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                Description
                <Input
                  maxLength={255}
                  value={form.description ?? ""}
                  placeholder="Station principale, ouverte 7j/7"
                  onChange={(event) =>
                    setForm((previous) => ({
                      ...previous,
                      description: event.target.value || null,
                    }))
                  }
                />
              </label>
            </div>
            {mutation.error && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleDialogChange(false)}
                disabled={saving}
              >
                Annuler
              </Button>
              <Button
                type="submit"
                disabled={saving || !form.name.trim() || !form.city.trim()}
              >
                {saving && <RefreshCw className="mr-2 size-4 animate-spin" />}
                {editingSite ? "Enregistrer les modifications" : "Ajouter la station"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
