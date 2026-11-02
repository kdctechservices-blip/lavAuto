import * as React from "react"
import { KeyRound, Plus, ShieldCheck, UserRoundCog } from "lucide-react"
import {
  CAlert,
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CSpinner,
} from "@coreui/react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@lavauto/shared-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SortableHead, TableEmptyRow, TablePagination, TableToolbar, useDataTable } from "@/components/ui/data-table"
import { consoleRequest, formatDateTime } from "../api"
import { useConsoleAuth } from "../auth"
import type { ConsoleOperatorAccount } from "../types"

const ROLE_LABELS = {
  admin: "Administrateur",
  supervisor: "Superviseur",
  support: "Support · lecture seule",
} as const

type ModalKind = "create" | "edit" | "reset" | "revoke" | null

function roleColor(role: ConsoleOperatorAccount["role"]) {
  if (role === "admin") return "danger"
  if (role === "supervisor") return "primary"
  return "secondary"
}

const operatorNameCollator = new Intl.Collator("fr", { sensitivity: "base" })

function searchOperator(row: ConsoleOperatorAccount) {
  return [row.full_name, row.email, ROLE_LABELS[row.role], row.managed_by, row.status].join(" ")
}

const operatorSorters = {
  operator: (a: ConsoleOperatorAccount, b: ConsoleOperatorAccount) => operatorNameCollator.compare(a.full_name, b.full_name),
  role: (a: ConsoleOperatorAccount, b: ConsoleOperatorAccount) => operatorNameCollator.compare(ROLE_LABELS[a.role], ROLE_LABELS[b.role]),
  last_login: (a: ConsoleOperatorAccount, b: ConsoleOperatorAccount) => (a.last_login_at ?? "").localeCompare(b.last_login_at ?? ""),
  sessions: (a: ConsoleOperatorAccount, b: ConsoleOperatorAccount) => a.active_sessions - b.active_sessions,
  status: (a: ConsoleOperatorAccount, b: ConsoleOperatorAccount) => a.status.localeCompare(b.status),
}

export function ConsoleOperators() {
  const { operator: current } = useConsoleAuth()
  const [rows, setRows] = React.useState<ConsoleOperatorAccount[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [modal, setModal] = React.useState<ModalKind>(null)
  const [selected, setSelected] = React.useState<ConsoleOperatorAccount | null>(null)
  const [fullName, setFullName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<ConsoleOperatorAccount["role"]>("support")
  const [status, setStatus] = React.useState<ConsoleOperatorAccount["status"]>("active")
  const [reason, setReason] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [temporaryPassword, setTemporaryPassword] = React.useState<string | null>(null)
  const table = useDataTable({
    storageKey: "lavauto:console:operators",
    rows,
    searchText: searchOperator,
    sorters: operatorSorters,
    initialSort: { column: "operator", direction: "asc" },
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const payload = await consoleRequest<{ operators: ConsoleOperatorAccount[] }>("/operators")
      setRows(payload.operators)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chargement impossible.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void (async () => { await load() })()
  }, [load])

  function closeModal() {
    if (saving) return
    setModal(null)
    setSelected(null)
    setActionError(null)
  }

  function open(kind: Exclude<ModalKind, null>, row?: ConsoleOperatorAccount) {
    setModal(kind)
    setSelected(row ?? null)
    setActionError(null)
    setNotice(null)
    setReason("")
    if (row) {
      setFullName(row.full_name)
      setEmail(row.email)
      setRole(row.role)
      setStatus(row.status)
    } else {
      setFullName("")
      setEmail("")
      setRole("support")
      setStatus("active")
    }
  }

  async function run(action: () => Promise<void>) {
    setSaving(true)
    setActionError(null)
    try {
      await action()
      closeModal()
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "L'opération a échoué.")
    } finally {
      setSaving(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!modal) return
    await run(async () => {
      if (modal === "create") {
        const result = await consoleRequest<{ temporary_password: string }>("/operators", {
          method: "POST",
          body: JSON.stringify({ email, full_name: fullName, role }),
        })
        setTemporaryPassword(result.temporary_password)
        setNotice(`Compte ${email} créé. Transmettez le mot de passe provisoire par un canal privé.`)
      } else if (modal === "edit" && selected) {
        await consoleRequest(`/operators/${selected.id}`, {
          method: "PATCH",
          body: JSON.stringify({ full_name: fullName, role, status, reason: reason || undefined }),
        })
        setNotice(`Les accès de ${selected.email} ont été mis à jour.`)
      } else if (modal === "reset" && selected) {
        const result = await consoleRequest<{ temporary_password: string; sessions_revoked: number }>(
          `/operators/${selected.id}/reset-password`,
          { method: "POST", body: JSON.stringify({ reason }) },
        )
        setTemporaryPassword(result.temporary_password)
        setNotice(`Mot de passe de ${selected.email} réinitialisé ; ${result.sessions_revoked} session(s) révoquée(s).`)
      } else if (modal === "revoke" && selected) {
        const result = await consoleRequest<{ sessions_revoked: number }>(
          `/operators/${selected.id}/revoke-sessions`,
          { method: "POST", body: JSON.stringify({ reason }) },
        )
        setNotice(`${result.sessions_revoked} session(s) de ${selected.email} révoquée(s).`)
      }
    })
  }

  return (
    <div className="d-grid gap-4">
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-3">
        <div>
          <h1 className="h3 mb-1">Opérateurs</h1>
          <p className="text-body-secondary mb-0">Comptes de la Console, rôles, mots de passe et sessions.</p>
        </div>
        <CButton color="primary" onClick={() => open("create")}>
          <Plus className="me-2" size={17} />Nouvel opérateur
        </CButton>
      </div>

      <CAlert color="info" className="mb-0">
        <strong>Trois niveaux, appliqués par le serveur.</strong> Le support consulte les tickets et diagnostics,
        mais ne peut modifier ni les stations, ni les paiements, ni les réglages. Le superviseur administre
        l'exploitation ; seul l'administrateur gère les opérateurs et les alertes.
      </CAlert>

      {notice && <CAlert color="success" className="mb-0">{notice}</CAlert>}
      {temporaryPassword && (
        <CAlert color="warning" className="mb-0" dismissible onClose={() => setTemporaryPassword(null)}>
          <div className="fw-semibold mb-2">Mot de passe provisoire — affiché une seule fois</div>
          <div className="d-flex flex-wrap align-items-center gap-2">
            <code className="user-select-all fs-6 text-body">{temporaryPassword}</code>
            <CButton size="sm" color="warning" variant="outline" onClick={() => void navigator.clipboard?.writeText(temporaryPassword)}>
              Copier
            </CButton>
          </div>
          <small className="d-block mt-2">Il n'est ni conservé en clair ni disponible dans la liste ou le journal.</small>
        </CAlert>
      )}
      {error && <CAlert color="danger" className="mb-0">{error}</CAlert>}

      <CCard>
        <CCardHeader className="d-flex align-items-center gap-2">
          <UserRoundCog size={18} /><strong>Comptes de la Console</strong>
          <CBadge color="secondary" className="ms-auto">{rows.length}</CBadge>
        </CCardHeader>
        <CCardBody className="p-0">
          {loading ? (
            <div className="text-center py-5"><CSpinner /><span className="visually-hidden">Chargement</span></div>
          ) : (
            <>
              <TableToolbar
                search={table.search}
                onSearchChange={table.setSearch}
                placeholder="Rechercher un opérateur…"
                searchLabel="Rechercher un opérateur"
                total={table.total}
                filtered={table.filtered.length}
                activeFilterCount={table.activeFilterCount}
                onReset={table.reset}
              />
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead label="Opérateur" column="operator" sort={table.sort} onSort={table.toggleSort} />
                    <SortableHead label="Rôle" column="role" sort={table.sort} onSort={table.toggleSort} />
                    <TableHead>Origine</TableHead>
                    <SortableHead label="Dernière connexion" column="last_login" sort={table.sort} onSort={table.toggleSort} />
                    <SortableHead label="Sessions" column="sessions" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <SortableHead label="État" column="status" sort={table.sort} onSort={table.toggleSort} />
                    <TableHead className="text-end">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.pageRows.length === 0 ? (
                    <TableEmptyRow
                      colSpan={7}
                      icon={UserRoundCog}
                      title={table.total === 0 ? "Aucun opérateur" : "Aucun résultat"}
                      description={table.total === 0 ? "Les comptes de la Console apparaîtront ici." : "Modifiez votre recherche pour afficher des opérateurs."}
                    />
                  ) : table.pageRows.map((row) => (
                    <TableRow key={row.id}>
                    <TableCell>
                      <div className="fw-semibold">{row.full_name}</div>
                      <div className="small text-body-secondary">{row.email}</div>
                      {row.id === current?.id && <CBadge color="info" className="mt-1">Compte connecté</CBadge>}
                    </TableCell>
                    <TableCell><CBadge color={roleColor(row.role)}>{ROLE_LABELS[row.role]}</CBadge></TableCell>
                    <TableCell>{row.managed_by === "bootstrap" ? "Amorçage" : "Console"}</TableCell>
                    <TableCell>{row.last_login_at ? formatDateTime(row.last_login_at) : "Jamais"}</TableCell>
                    <TableCell>{row.active_sessions}</TableCell>
                    <TableCell>
                      <CBadge color={row.status === "active" ? "success" : "secondary"}>
                        {row.status === "active" ? "Actif" : "Désactivé"}
                      </CBadge>
                    </TableCell>
                    <TableCell className="text-end">
                      {row.id === current?.id ? (
                        <span className="small text-body-secondary">Accès protégé</span>
                      ) : (
                        <div className="d-inline-flex flex-wrap justify-content-end gap-1">
                          <CButton size="sm" color="primary" variant="ghost" onClick={() => open("edit", row)}>Modifier</CButton>
                          <CButton size="sm" color="warning" variant="ghost" onClick={() => open("reset", row)}>Mot de passe</CButton>
                          {row.active_sessions > 0 && (
                            <CButton size="sm" color="secondary" variant="ghost" onClick={() => open("revoke", row)}>Révoquer</CButton>
                          )}
                        </div>
                      )}
                    </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <TablePagination
                page={table.page}
                pageCount={table.pageCount}
                pageSize={table.pageSize}
                pageSizeOptions={table.pageSizeOptions}
                total={table.total}
                filtered={table.filtered.length}
                onPage={table.setPage}
                onPageSize={table.setPageSize}
              />
            </>
          )}
        </CCardBody>
      </CCard>

      <Dialog
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open) closeModal()
        }}
      >
        <DialogContent className="max-w-xl p-0 sm:max-w-xl" showCloseButton>
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>
              {modal === "create" && "Créer un opérateur"}
              {modal === "edit" && `Modifier ${selected?.email ?? "l'opérateur"}`}
              {modal === "reset" && "Réinitialiser le mot de passe"}
              {modal === "revoke" && "Révoquer les sessions"}
            </DialogTitle>
            <DialogDescription>
              {modal === "create" && "Créez un compte opérateur et choisissez son niveau d'accès à la Console."}
              {modal === "edit" && "Modifiez le rôle ou l'état du compte. Le motif sera consigné dans le journal."}
              {modal === "reset" && "Un nouveau mot de passe provisoire sera créé et les sessions actuelles seront fermées."}
              {modal === "revoke" && "Toutes les sessions actives de cet opérateur seront immédiatement fermées."}
            </DialogDescription>
          </DialogHeader>
          <form id="operator-form" onSubmit={(event) => void submit(event)}>
            <div className="max-h-[70vh] overflow-y-auto px-6 pb-6">
              <div className="grid gap-3 sm:grid-cols-2">
                {(modal === "create" || modal === "edit") && (
                  <>
                    <FormField htmlFor="operator-name" label="Nom complet" required className="sm:col-span-2">
                      <Input id="operator-name" required minLength={2} value={fullName} onChange={(event) => setFullName(event.target.value)} />
                    </FormField>
                    {modal === "create" && (
                      <FormField htmlFor="operator-email" label="Adresse e-mail" required className="sm:col-span-2">
                        <Input id="operator-email" type="email" autoComplete="off" required value={email} onChange={(event) => setEmail(event.target.value)} />
                      </FormField>
                    )}
                    <FormField htmlFor="operator-role" label="Rôle">
                      <select id="operator-role" value={role} onChange={(event) => setRole(event.target.value as ConsoleOperatorAccount["role"])} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <option value="support">Support · lecture seule</option>
                        <option value="supervisor">Superviseur</option>
                        <option value="admin">Administrateur</option>
                      </select>
                    </FormField>
                    {modal === "edit" && (
                      <FormField htmlFor="operator-status" label="Accès">
                        <select id="operator-status" value={status} onChange={(event) => setStatus(event.target.value as ConsoleOperatorAccount["status"])} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <option value="active">Actif</option>
                          <option value="disabled">Désactivé</option>
                        </select>
                      </FormField>
                    )}
                  </>
                )}
                {modal !== "create" && (
                  <FormField htmlFor="operator-reason" label="Motif de l'intervention" required className="sm:col-span-2">
                    <Textarea id="operator-reason" required minLength={5} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ce motif sera inscrit dans le journal de la Console." />
                  </FormField>
                )}
                {modal === "reset" && (
                  <div className="sm:col-span-2">
                    <CAlert color="warning" className="mb-0">
                      <KeyRound className="me-2" size={17} />Un nouveau mot de passe provisoire sera généré et toutes les sessions du compte seront fermées.
                    </CAlert>
                  </div>
                )}
                {modal === "revoke" && (
                  <div className="sm:col-span-2">
                    <p className="mb-0">Le compte restera actif, mais toutes ses sessions Console seront immédiatement fermées.</p>
                  </div>
                )}
                {actionError && (
                  <div className="sm:col-span-2">
                    <CAlert color="danger" className="mb-0">{actionError}</CAlert>
                  </div>
                )}
              </div>
            </div>
            <DialogFooter className="mx-0 mb-0 rounded-b-xl px-6 py-4">
              <Button type="button" variant="outline" disabled={saving} onClick={closeModal}>Annuler</Button>
              <Button type="submit" variant={modal === "revoke" ? "destructive" : "default"} disabled={saving}>
                {saving ? <CSpinner size="sm" className="me-2" /> : modal === "create" ? <ShieldCheck size={17} className="me-2" /> : null}
                {saving ? "Enregistrement…" : modal === "create" ? "Créer le compte" : "Confirmer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ConsoleOperators
