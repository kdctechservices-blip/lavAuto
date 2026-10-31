"use client"

import { useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { KeyRound, RefreshCw, ShieldCheck, UserPlus } from "lucide-react"

import { BlockedReason } from "@/components/access/blocked-reason"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { actionGate } from "@/lib/action-blocking"
import { accessCapacityReason, type AccessCapacity } from "@/lib/access-api"
import { useApi } from "@/lib/api"
import { useAccess } from "@/lib/permissions"
import type { OrganizationAccount } from "@/lib/team-api"
import { useMutation } from "@/lib/use-mutation"

const ACCOUNT_FORM_KEY = "compte-acces"

type AccountRole = "manager" | "cashier" | "washer"

interface AccountForm {
  first_name: string
  last_name: string
  email: string
  phone: string
  role: AccountRole
  password: string
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Propriétaire",
  manager: "Responsable",
  cashier: "Caissier",
  washer: "Agent de lavage",
}

function emptyAccount(role: AccountRole): AccountForm {
  return { first_name: "", last_name: "", email: "", phone: "", role, password: "" }
}

/**
 * Comptes de connexion de l'organisation.
 *
 * L'API réserve la liste complète au propriétaire. Un responsable peut créer
 * uniquement des comptes agents de lavage : l'écran applique le même périmètre,
 * sans afficher les comptes sensibles qu'il n'a pas le droit de lire.
 */
export function AccountAccessCard({
  role,
  roleLoading,
}: {
  role: string | null | undefined
  roleLoading: boolean
}) {
  const isOwner = role === "owner"
  const canCreateWithRole = isOwner || role === "manager"
  const access = useAccess("worker:create", "team.manage")
  const [refreshKey, setRefreshKey] = useState(0)
  const {
    data: capacity,
    loading: capacityLoading,
    error: capacityError,
  } = useApi<AccessCapacity>(canCreateWithRole ? `/api/v1/access/capacity?refresh=${refreshKey}` : "")
  const capacityReason = accessCapacityReason(capacity)
  const createGate = actionGate({
    loading: access.loading || roleLoading || (canCreateWithRole && capacityLoading),
    allowed: access.allowed && canCreateWithRole,
    reason: access.reason,
    blockedBy: capacityReason,
  })
  const {
    data: accounts,
    loading: accountsLoading,
    error: accountsError,
  } = useApi<OrganizationAccount[]>(isOwner ? `/api/v1/users?refresh=${refreshKey}` : "")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<AccountForm>(() => emptyAccount("washer"))
  const mutation = useMutation()
  const saving = mutation.busyKey === ACCOUNT_FORM_KEY

  function openDialog() {
    setForm(emptyAccount(isOwner ? "cashier" : "washer"))
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

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    mutation.reset()
    if (capacityReason) {
      mutation.fail(capacityReason)
      return
    }
    const input = {
      ...form,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim().toLowerCase(),
      phone: form.phone.trim() || null,
    }
    if (!input.first_name || !input.last_name || !input.email) {
      mutation.fail("Le prénom, le nom et l’adresse e-mail sont obligatoires.")
      return
    }
    if (input.password.length < 5) {
      mutation.fail("Le mot de passe initial doit contenir au moins 5 caractères.")
      return
    }

    const outcome = await mutation.run({
      url: "/api/v1/access/members",
      method: "POST",
      body: input,
      success: "Compte créé. Communiquez le mot de passe initial à votre collaborateur.",
      failure: "Impossible de créer le compte d’accès.",
      busyKey: ACCOUNT_FORM_KEY,
    })
    if (!outcome.ok) return
    setDialogOpen(false)
    setRefreshKey((key) => key + 1)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Comptes ayant accès à WashPilot</CardTitle>
              <CardDescription>
                Créez les accès de vos collaborateurs et choisissez leur rôle dans l’organisation.
              </CardDescription>
              {capacity && (
                <p className="text-xs text-muted-foreground">
                  {capacity.active_users} compte{capacity.active_users === 1 ? "" : "s"} actif{capacity.active_users === 1 ? "" : "s"}
                  {capacity.max_users === null
                    ? " · nombre illimité"
                    : ` · ${capacity.remaining_users} place${capacity.remaining_users === 1 ? "" : "s"} disponible${capacity.remaining_users === 1 ? "" : "s"} sur ${capacity.max_users}`}
                </p>
              )}
              {capacityError && <p className="text-xs text-destructive">Plafond indisponible : {capacityError}</p>}
            </div>
            {canCreateWithRole && (
              <div className="flex flex-col items-start gap-1.5">
                <Button
                  type="button"
                  onClick={openDialog}
                  disabled={createGate.disabled}
                  title={createGate.reason ?? undefined}
                  aria-busy={createGate.busy}
                >
                  <UserPlus className="mr-2 size-4" aria-hidden="true" />
                  Ajouter un compte
                </Button>
                <BlockedReason reason={createGate.reason} />
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {mutation.success && (
            <p role="status" className="mb-3 rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              {mutation.success}
            </p>
          )}
          {mutation.error && !dialogOpen && (
            <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {mutation.error}
            </p>
          )}

          {roleLoading ? (
            <TableSkeleton rows={3} cols={4} label="Chargement des comptes" />
          ) : isOwner ? (
            <>
              {accountsError && <p role="alert" className="mb-3 text-sm text-destructive">{accountsError}</p>}
              {accountsLoading ? (
                <TableSkeleton rows={3} cols={4} label="Chargement des comptes" />
              ) : accounts && accounts.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nom</TableHead>
                        <TableHead>E-mail</TableHead>
                        <TableHead>Rôle</TableHead>
                        <TableHead>Statut</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {accounts.map((account) => (
                        <TableRow key={account.id}>
                          <TableCell className="font-medium">
                            {[account.first_name, account.last_name].filter(Boolean).join(" ") || account.email}
                          </TableCell>
                          <TableCell>{account.email}</TableCell>
                          <TableCell><Badge variant="outline">{ROLE_LABELS[account.role] ?? account.role}</Badge></TableCell>
                          <TableCell>
                            <Badge variant={account.status === "active" ? "secondary" : "outline"}>
                              {account.status === "active" ? "Actif" : "Désactivé"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : !accountsError ? (
                <p className="text-sm text-muted-foreground">Aucun compte d’accès synchronisé.</p>
              ) : null}
            </>
          ) : (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              La liste complète des comptes est réservée au propriétaire.
              {role === "manager" ? " Vous pouvez créer des comptes agents de lavage avec le bouton ci-dessus." : ""}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="max-w-2xl text-xs text-muted-foreground">
              Le compte est actif immédiatement : le mot de passe initial se communique en personne. Aucune invitation n’est envoyée par e-mail.
            </p>
            {isOwner && (
              <Button variant="outline" size="sm" render={<Link to="/settings/access" viewTransition />}>
                <ShieldCheck className="mr-2 size-4" aria-hidden="true" />
                Gérer les rôles et les droits
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Ajouter un compte d’accès</DialogTitle>
            <DialogDescription>
              Le collaborateur pourra se connecter immédiatement avec l’e-mail et le mot de passe initial que vous lui communiquez.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveAccount} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Prénom
                <Input
                  required
                  autoFocus
                  maxLength={100}
                  value={form.first_name}
                  onChange={(event) => setForm((previous) => ({ ...previous, first_name: event.target.value }))}
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Nom
                <Input
                  required
                  maxLength={100}
                  value={form.last_name}
                  onChange={(event) => setForm((previous) => ({ ...previous, last_name: event.target.value }))}
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                Adresse e-mail
                <Input
                  required
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  value={form.email}
                  onChange={(event) => setForm((previous) => ({ ...previous, email: event.target.value }))}
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Téléphone (facultatif)
                <Input
                  type="tel"
                  maxLength={30}
                  value={form.phone}
                  onChange={(event) => setForm((previous) => ({ ...previous, phone: event.target.value }))}
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Rôle
                <Select
                  value={form.role}
                  onValueChange={(value) => setForm((previous) => ({ ...previous, role: String(value ?? "washer") as AccountRole }))}
                  disabled={saving}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {isOwner && <SelectItem value="manager">Responsable</SelectItem>}
                    {isOwner && <SelectItem value="cashier">Caissier</SelectItem>}
                    <SelectItem value="washer">Agent de lavage</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium sm:col-span-2">
                Mot de passe initial
                <Input
                  required
                  type="password"
                  minLength={5}
                  maxLength={200}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(event) => setForm((previous) => ({ ...previous, password: event.target.value }))}
                  disabled={saving}
                  aria-describedby="account-password-hint"
                />
                <span id="account-password-hint" className="text-xs font-normal text-muted-foreground">
                  5 caractères minimum. Il ne sera plus affiché après la création ; le collaborateur pourra ensuite demander une réinitialisation.
                </span>
              </label>
            </div>
            {!isOwner && (
              <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Seul le propriétaire peut créer un compte responsable ou caissier.
              </p>
            )}
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleDialogChange(false)} disabled={saving}>
                Annuler
              </Button>
              <Button
                type="submit"
                disabled={saving || !form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || form.password.length < 5}
                aria-busy={saving}
              >
                {saving && <RefreshCw className="mr-2 size-4 animate-spin" aria-hidden="true" />}
                Créer le compte
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
