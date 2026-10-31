"use client"

import * as React from "react"
import { Lock, ShieldCheck, UserCheck, UserPlus, UserX } from "lucide-react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { apiErrorMessage, apiFetch, useApi } from "@/lib/api"
import { accessCapacityReason, type AccessCapacity } from "@/lib/access-api"
import { usePermission, usePermissions, ROLE_LABELS, type Permission, type Role } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { cn } from "cn"

interface MemberOverride {
  permission: Permission
  granted: boolean
}

interface AccessMember {
  user_id: string
  role: Role
  status: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  is_self: boolean
  overrides: MemberOverride[]
  permissions: Permission[]
}

interface RolesCatalog {
  roles: { code: Role; label: string; description: string; permissions: Permission[] }[]
  permissions: { code: Permission; label: string; grantable: boolean }[]
  owner_only: Permission[]
}

const STATUS_LABELS: Record<string, string> = {
  active: "Actif",
  disabled: "Désactivé",
}

export default function AccessSettingsPage() {
  const manage = usePermission("user:manage")
  const permissions = usePermissions()
  // Seul le propriétaire délègue gérant ou caissier : un gérant ne crée que
  // des agents de lavage (la règle est aussi appliquée par le serveur).
  const isOwner = permissions.state?.role === "owner"
  const assignableRoles = isOwner
    ? ([
        { value: "manager", label: "Gérant" },
        { value: "cashier", label: "Caissier" },
        { value: "washer", label: "Agent de lavage" },
      ] as const)
    : ([{ value: "washer", label: "Agent de lavage" }] as const)
  // Changer un rôle ou un droit part aussitôt en requête : on attend de
  // connaître les droits plutôt que d'envoyer un PATCH voué au refus.
  const manageAccess = actionGate({
    loading: manage.loading,
    allowed: manage.allowed,
    reason: manage.reason,
    writesImmediately: true,
  })
  const [refreshKey, setRefreshKey] = React.useState(0)
  const {
    data: capacity,
    loading: capacityLoading,
    error: capacityError,
  } = useApi<AccessCapacity>(manage.allowed ? `/api/v1/access/capacity?refresh=${refreshKey}` : "")
  const capacityReason = accessCapacityReason(capacity)
  const { data, loading, error } = useApi<{ members: AccessMember[] }>(
    `/api/v1/access/members?refresh=${refreshKey}`,
  )
  const { data: catalog } = useApi<RolesCatalog>("/api/v1/access/roles")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)

  async function send(path: string, method: string, payload: unknown, successMessage: string) {
    setBusy(path)
    setActionError(null)
    setNotice(null)
    try {
      const response = await apiFetch(path, { method, body: JSON.stringify(payload) })
      if (!response.ok) {
        setActionError(await apiErrorMessage(response))
        return false
      }
      setNotice(successMessage)
      setRefreshKey((key) => key + 1)
      return true
    } catch {
      setActionError("Modification impossible : serveur injoignable.")
      return false
    } finally {
      setBusy(null)
    }
  }

  const members = data?.members ?? []

  return (
    <BaseLayout
      title="Gestion des accès"
      description="Attribuez les rôles, accordez des exceptions et désactivez un accès. Toute modification est journalisée."
    >
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        {!manage.allowed && (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="flex items-center gap-3 p-4 text-sm">
              <Lock className="size-5 shrink-0 text-destructive" aria-hidden="true" />
              <span>{manage.reason ?? "Cette page est réservée au propriétaire de la station."}</span>
            </CardContent>
          </Card>
        )}

        {/* Rappel du référentiel : ce que chaque rôle peut faire par défaut. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5" aria-hidden="true" /> Rôles disponibles
            </CardTitle>
            <CardDescription>
              Les droits ci-dessous s’appliquent par défaut. Le propriétaire peut ensuite accorder
              ou retirer une permission à un membre précis.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(catalog?.roles ?? []).map((role, index) => (
              <div
                key={role.code}
                className="row-in rounded-lg border bg-muted/30 p-3"
                style={{ "--row": index } as React.CSSProperties}
              >
                <p className="font-semibold">{role.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{role.description}</p>
                <p className="mt-2 text-xs font-medium tabular-nums">
                  {role.permissions.length} permission{role.permissions.length > 1 ? "s" : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Création d'un accès : le compte est actif immédiatement, le mot de
            passe initial est communiqué en personne. Les rôles proposés
            excluent « propriétaire » : une station ne se délègue pas d'ici. */}
        {manage.allowed && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="size-5" aria-hidden="true" /> Ajouter un membre
              </CardTitle>
              <CardDescription>
                Créez le compte d'un gérant, d'un caissier ou d'un agent de lavage. Il pourra se
                connecter aussitôt avec le mot de passe que vous lui communiquez.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {capacity && (
                <p className="mb-3 text-sm text-muted-foreground">
                  {capacity.active_users} compte{capacity.active_users === 1 ? "" : "s"} actif{capacity.active_users === 1 ? "" : "s"}
                  {capacity.max_users === null
                    ? " · nombre illimité"
                    : ` · ${capacity.remaining_users} place${capacity.remaining_users === 1 ? "" : "s"} disponible${capacity.remaining_users === 1 ? "" : "s"} sur ${capacity.max_users}`}
                </p>
              )}
              <BlockedReason reason={capacityReason} className="mb-3" />
              {capacityError && <p className="mb-3 text-xs text-destructive">Plafond indisponible : {capacityError}</p>}
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={async (event) => {
                  event.preventDefault()
                  if (busy !== null) return
                  if (capacityReason) {
                    setActionError(capacityReason)
                    return
                  }
                  const formElement = event.currentTarget
                  const form = new FormData(formElement)
                  const created = await send(
                    "/api/v1/access/members",
                    "POST",
                    {
                      email: String(form.get("email") ?? "").trim(),
                      first_name: String(form.get("first_name") ?? "").trim(),
                      last_name: String(form.get("last_name") ?? "").trim(),
                      phone: String(form.get("phone") ?? "").trim() || null,
                      role: String(form.get("role") ?? "cashier"),
                      password: String(form.get("password") ?? ""),
                    },
                    "Compte créé. Communiquez le mot de passe initial à votre collaborateur.",
                  )
                  // En cas de refus, la saisie reste disponible pour correction.
                  if (created) formElement.reset()
                }}
              >
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Prénom
                  <input name="first_name" required maxLength={100} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Nom
                  <input name="last_name" required maxLength={100} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">
                  Adresse e-mail
                  <input name="email" type="email" required maxLength={254} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Téléphone (facultatif)
                  <input name="phone" maxLength={30} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Rôle
                  <select name="role" defaultValue={assignableRoles[0].value} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                    {assignableRoles.map((role) => (
                      <option key={role.value} value={role.value}>{role.label}</option>
                    ))}
                  </select>
                  {!isOwner && (
                    <span className="text-xs font-normal text-muted-foreground">
                      Seul le propriétaire peut créer un compte gérant ou caissier.
                    </span>
                  )}
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium sm:col-span-2">
                  Mot de passe initial (5 caractères minimum)
                  <input
                    name="password"
                    type="text"
                    required
                    minLength={5}
                    autoComplete="off"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  />
                </label>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={busy !== null || capacityLoading || Boolean(capacityReason)}>
                    {busy === "/api/v1/access/members" ? "Création…" : "Créer le compte"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Membres de la station</CardTitle>
            <CardDescription>
              Un membre désactivé conserve son compte mais ne peut plus rien faire : toutes ses
              requêtes sont refusées par le serveur.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BlockedReason reason={manageAccess.reason} />
            {notice && (
              <p role="status" className="rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
                {notice}
              </p>
            )}
            {actionError && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {actionError}
              </p>
            )}

            {loading ? (
              <div className="space-y-2" role="status" aria-busy="true">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-20 w-full" />
                ))}
              </div>
            ) : error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : members.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="Aucun membre"
                description="Invitez un collaborateur pour lui attribuer un rôle."
              />
            ) : (
              members.map((member, index) => {
                const isOpen = expanded === member.user_id
                const disabled = member.status !== "active"
                return (
                  <div
                    key={member.user_id}
                    className={cn(
                      "row-in rounded-lg border p-4 transition-colors duration-150",
                      disabled && "bg-muted/40 opacity-80",
                    )}
                    style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {[member.first_name, member.last_name].filter(Boolean).join(" ") || member.email}
                          {member.is_self && <Badge variant="secondary">Vous</Badge>}
                          <Badge variant={disabled ? "outline" : "secondary"}>
                            {STATUS_LABELS[member.status] ?? member.status}
                          </Badge>
                        </p>
                        <p className="truncate text-sm text-muted-foreground">{member.email}</p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor={`role-${member.user_id}`}>
                          Rôle de {member.email}
                        </label>
                        <select
                          id={`role-${member.user_id}`}
                          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                          value={member.role}
                          disabled={manageAccess.disabled || member.is_self || busy !== null}
                          title={member.is_self ? "Vous ne pouvez pas modifier votre propre rôle." : undefined}
                          onChange={(event) =>
                            void send(
                              `/api/v1/access/members/${member.user_id}`,
                              "PATCH",
                              { role: event.target.value },
                              `Rôle mis à jour : ${ROLE_LABELS[event.target.value as Role]}.`,
                            )
                          }
                        >
                          {(catalog?.roles ?? []).map((role) => (
                            <option key={role.code} value={role.code}>
                              {role.label}
                            </option>
                          ))}
                        </select>

                        <Button
                          type="button"
                          variant={disabled ? "default" : "outline"}
                          className="h-10"
                          disabled={manageAccess.disabled || member.is_self || busy !== null}
                          title={member.is_self ? "Vous ne pouvez pas désactiver votre propre accès." : undefined}
                          onClick={() =>
                            void send(
                              `/api/v1/access/members/${member.user_id}`,
                              "PATCH",
                              { status: disabled ? "active" : "disabled" },
                              disabled ? "Accès réactivé." : "Accès désactivé.",
                            )
                          }
                        >
                          {disabled ? (
                            <>
                              <UserCheck className="mr-1.5 size-4" /> Réactiver
                            </>
                          ) : (
                            <>
                              <UserX className="mr-1.5 size-4" /> Désactiver
                            </>
                          )}
                        </Button>

                        <Button
                          type="button"
                          variant="ghost"
                          className="h-10"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : member.user_id)}
                        >
                          {isOpen ? "Masquer les droits" : "Droits détaillés"}
                        </Button>
                      </div>
                    </div>

                    {/* Exceptions : accorder ou retirer une permission précise. */}
                    {isOpen && (
                      <div className="mt-4 grid gap-2 border-t pt-4 sm:grid-cols-2">
                        {(catalog?.permissions ?? []).map((permission) => {
                          const override = member.overrides.find((o) => o.permission === permission.code)
                          const active = member.permissions.includes(permission.code)
                          const fromRole = active && !override
                          const locked =
                            !permission.grantable || member.role === "owner" || member.is_self
                          return (
                            <div
                              key={permission.code}
                              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm">{permission.label}</p>
                                <p className="text-xs text-muted-foreground">
                                  {member.role === "owner"
                                    ? "Incluse — propriétaire"
                                    : !permission.grantable
                                      ? "Réservée au propriétaire"
                                      : override
                                        ? override.granted
                                          ? "Accordée en exception"
                                          : "Retirée explicitement"
                                        : fromRole
                                          ? "Incluse dans le rôle"
                                          : "Non incluse"}
                                </p>
                              </div>
                              <div className="flex shrink-0 gap-1">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={active ? "secondary" : "outline"}
                                  className="h-8"
                                  disabled={locked || !manage.allowed || busy !== null}
                                  aria-pressed={active}
                                  onClick={() =>
                                    void send(
                                      `/api/v1/access/members/${member.user_id}/permissions/${permission.code}`,
                                      "PUT",
                                      { granted: active ? false : true },
                                      active ? "Permission retirée." : "Permission accordée.",
                                    )
                                  }
                                >
                                  {active ? "Retirer" : "Accorder"}
                                </Button>
                                {override && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-8"
                                    disabled={manageAccess.disabled || busy !== null}
                                    onClick={() =>
                                      void send(
                                        `/api/v1/access/members/${member.user_id}/permissions/${permission.code}`,
                                        "PUT",
                                        { granted: null },
                                        "Retour au droit par défaut du rôle.",
                                      )
                                    }
                                  >
                                    Défaut
                                  </Button>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Garde-fous appliqués</CardTitle>
            <CardDescription>Règles que le serveur fait respecter, quoi qu’affiche cet écran.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>• Personne ne peut modifier son propre rôle ni ses propres droits.</p>
            <p>• La station conserve toujours au moins un propriétaire actif.</p>
            <p>
              • Les permissions sensibles (gestion des utilisateurs, paramètres, abonnement,
              remboursement) ne sont jamais déléguées.
            </p>
            <p>• Un changement de rôle annule les exceptions accordées pour l’ancien rôle.</p>
            <p>• Chaque modification, et chaque tentative refusée, est enregistrée dans le journal d’audit.</p>
          </CardContent>
        </Card>
      </div>
    </BaseLayout>
  )
}
