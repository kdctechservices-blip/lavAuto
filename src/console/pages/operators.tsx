import * as React from "react"
import { KeyRound, Plus, ShieldCheck, UserRoundCog } from "lucide-react"
import {
  CAlert,
  CBadge,
  CButton,
  CCard,
  CCardBody,
  CCardHeader,
  CCol,
  CForm,
  CFormInput,
  CFormLabel,
  CFormSelect,
  CFormTextarea,
  CModal,
  CModalBody,
  CModalFooter,
  CModalHeader,
  CModalTitle,
  CRow,
  CSpinner,
  CTable,
  CTableBody,
  CTableDataCell,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from "@coreui/react"

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
            <CTable responsive hover align="middle" className="mb-0">
              <CTableHead>
                <CTableRow>
                  <CTableHeaderCell>Opérateur</CTableHeaderCell>
                  <CTableHeaderCell>Rôle</CTableHeaderCell>
                  <CTableHeaderCell>Origine</CTableHeaderCell>
                  <CTableHeaderCell>Dernière connexion</CTableHeaderCell>
                  <CTableHeaderCell>Sessions</CTableHeaderCell>
                  <CTableHeaderCell>État</CTableHeaderCell>
                  <CTableHeaderCell className="text-end">Actions</CTableHeaderCell>
                </CTableRow>
              </CTableHead>
              <CTableBody>
                {rows.map((row) => (
                  <CTableRow key={row.id}>
                    <CTableDataCell>
                      <div className="fw-semibold">{row.full_name}</div>
                      <div className="small text-body-secondary">{row.email}</div>
                      {row.id === current?.id && <CBadge color="info" className="mt-1">Compte connecté</CBadge>}
                    </CTableDataCell>
                    <CTableDataCell><CBadge color={roleColor(row.role)}>{ROLE_LABELS[row.role]}</CBadge></CTableDataCell>
                    <CTableDataCell>{row.managed_by === "bootstrap" ? "Amorçage" : "Console"}</CTableDataCell>
                    <CTableDataCell>{row.last_login_at ? formatDateTime(row.last_login_at) : "Jamais"}</CTableDataCell>
                    <CTableDataCell>{row.active_sessions}</CTableDataCell>
                    <CTableDataCell>
                      <CBadge color={row.status === "active" ? "success" : "secondary"}>
                        {row.status === "active" ? "Actif" : "Désactivé"}
                      </CBadge>
                    </CTableDataCell>
                    <CTableDataCell className="text-end">
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
                    </CTableDataCell>
                  </CTableRow>
                ))}
              </CTableBody>
            </CTable>
          )}
        </CCardBody>
      </CCard>

      <CModal visible={modal !== null} onClose={closeModal} alignment="center" backdrop="static">
        <CModalHeader>
          <CModalTitle>
            {modal === "create" && "Créer un opérateur"}
            {modal === "edit" && `Modifier ${selected?.email ?? "l'opérateur"}`}
            {modal === "reset" && `Réinitialiser le mot de passe`}
            {modal === "revoke" && "Révoquer les sessions"}
          </CModalTitle>
        </CModalHeader>
        <CForm id="operator-form" onSubmit={(event) => void submit(event)}>
          <CModalBody>
            <CRow className="g-3">
              {(modal === "create" || modal === "edit") && (
                <>
                  <CCol xs={12}>
                    <CFormLabel htmlFor="operator-name">Nom complet</CFormLabel>
                    <CFormInput id="operator-name" required minLength={2} value={fullName} onChange={(event) => setFullName(event.target.value)} />
                  </CCol>
                  {modal === "create" && (
                    <CCol xs={12}>
                      <CFormLabel htmlFor="operator-email">Adresse e-mail</CFormLabel>
                      <CFormInput id="operator-email" type="email" autoComplete="off" required value={email} onChange={(event) => setEmail(event.target.value)} />
                    </CCol>
                  )}
                  <CCol md={6}>
                    <CFormLabel htmlFor="operator-role">Rôle</CFormLabel>
                    <CFormSelect id="operator-role" value={role} onChange={(event) => setRole(event.target.value as ConsoleOperatorAccount["role"])}>
                      <option value="support">Support · lecture seule</option>
                      <option value="supervisor">Superviseur</option>
                      <option value="admin">Administrateur</option>
                    </CFormSelect>
                  </CCol>
                  {modal === "edit" && (
                    <CCol md={6}>
                      <CFormLabel htmlFor="operator-status">Accès</CFormLabel>
                      <CFormSelect id="operator-status" value={status} onChange={(event) => setStatus(event.target.value as ConsoleOperatorAccount["status"])}>
                        <option value="active">Actif</option>
                        <option value="disabled">Désactivé</option>
                      </CFormSelect>
                    </CCol>
                  )}
                </>
              )}
              {modal !== "create" && (
                <CCol xs={12}>
                  <CFormLabel htmlFor="operator-reason">Motif de l'intervention</CFormLabel>
                  <CFormTextarea id="operator-reason" required minLength={5} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ce motif sera inscrit dans le journal de la Console." />
                </CCol>
              )}
              {modal === "reset" && (
                <CCol xs={12}><CAlert color="warning" className="mb-0"><KeyRound className="me-2" size={17} />Un nouveau mot de passe provisoire sera généré et toutes les sessions du compte seront fermées.</CAlert></CCol>
              )}
              {modal === "revoke" && (
                <CCol xs={12}><p className="mb-0">Le compte restera actif, mais toutes ses sessions Console seront immédiatement fermées.</p></CCol>
              )}
              {actionError && <CCol xs={12}><CAlert color="danger" className="mb-0">{actionError}</CAlert></CCol>}
            </CRow>
          </CModalBody>
          <CModalFooter>
            <CButton type="button" color="secondary" variant="ghost" disabled={saving} onClick={closeModal}>Annuler</CButton>
            <CButton type="submit" color={modal === "revoke" ? "danger" : "primary"} disabled={saving}>
              {saving ? <CSpinner size="sm" className="me-2" /> : modal === "create" ? <ShieldCheck size={17} className="me-2" /> : null}
              {saving ? "Enregistrement…" : modal === "create" ? "Créer le compte" : "Confirmer"}
            </CButton>
          </CModalFooter>
        </CForm>
      </CModal>
    </div>
  )
}

export default ConsoleOperators
