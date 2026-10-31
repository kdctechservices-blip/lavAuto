import * as React from "react"
import { ArrowLeftRight, CheckCircle2, FileUp, Play, TriangleAlert } from "lucide-react"
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
import { ConsoleWrite } from "../auth"
import type {
  ReconciliationBatch,
  ReconciliationDiscrepancy,
  ReconciliationRun,
  StatementEntry,
} from "../types"

interface BatchDetail {
  batch: ReconciliationBatch
  entries: StatementEntry[]
  discrepancies: ReconciliationDiscrepancy[]
}

interface ReconciliationOverview {
  batches: ReconciliationBatch[]
  runs: ReconciliationRun[]
  configuration: {
    enabled: boolean
    provider: string | null
    configured: boolean
    lookback_hours: number
  }
}

const DISCREPANCY_LABELS: Record<ReconciliationDiscrepancy["kind"], string> = {
  amount_mismatch: "Montant différent",
  missing_in_register: "Absent du registre",
  missing_in_statement: "Absent du relevé",
  duplicate_reference: "Référence ambiguë",
}

function amount(cents: number | null) {
  return cents === null ? "—" : `${Math.round(cents / 100).toLocaleString("fr-FR")} F`
}

function isoDay(offset: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function ConsoleReconciliation() {
  const [data, setData] = React.useState<ReconciliationOverview | null>(null)
  const [detail, setDetail] = React.useState<BatchDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [provider, setProvider] = React.useState("wave")
  const [from, setFrom] = React.useState(() => isoDay(-7))
  const [to, setTo] = React.useState(() => isoDay(0))
  const [sourceName, setSourceName] = React.useState("")
  const [file, setFile] = React.useState<File | null>(null)
  const [fileKey, setFileKey] = React.useState(0)
  const [importing, setImporting] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [resolving, setResolving] = React.useState<ReconciliationDiscrepancy | null>(null)
  const [resolutionNote, setResolutionNote] = React.useState("")
  const [savingResolution, setSavingResolution] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const payload = await consoleRequest<ReconciliationOverview>("/reconciliation")
      setData(payload)
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

  async function openBatch(id: string) {
    setDetailLoading(true)
    try {
      setDetail(await consoleRequest<BatchDetail>(`/reconciliation/batches/${id}`))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible d'ouvrir ce lot.")
    } finally {
      setDetailLoading(false)
    }
  }

  async function importStatement(event: React.FormEvent) {
    event.preventDefault()
    if (!file) {
      setError("Sélectionnez un relevé CSV ou JSON.")
      return
    }
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const text = await file.text()
      let payload: { entries?: Array<Record<string, unknown>>; csv?: string }
      if (file.name.toLowerCase().endsWith(".json") || /^\s*(?:\[|\{)/.test(text)) {
        const parsed = JSON.parse(text) as unknown
        const entries = Array.isArray(parsed)
          ? parsed
          : (parsed as { entries?: unknown; data?: unknown }).entries ?? (parsed as { data?: unknown }).data
        if (!Array.isArray(entries)) throw new Error("Le JSON doit contenir un tableau entries ou data.")
        payload = { entries: entries as Array<Record<string, unknown>> }
      } else {
        payload = { csv: text }
      }
      const result = await consoleRequest<{ batch_id: string; matched_rows: number; discrepancy_rows: number }>(
        "/reconciliation/batches",
        {
          method: "POST",
          body: JSON.stringify({
            provider, from, to, source_name: sourceName || file.name, ...payload,
          }),
        },
      )
      setNotice(`Lot importé : ${result.matched_rows} correspondance(s), ${result.discrepancy_rows} écart(s).`)
      setFile(null)
      setFileKey((key) => key + 1)
      await load()
      await openBatch(result.batch_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import impossible.")
    } finally {
      setImporting(false)
    }
  }

  async function runConnector() {
    setRunning(true)
    setError(null)
    try {
      const result = await consoleRequest<{ status: string; batch_id?: string; error?: string }>("/reconciliation/run", { method: "POST" })
      if (result.status !== "success") throw new Error(result.error || "Le connecteur n'a pas produit de lot.")
      setNotice("Le relevé distant a été rapproché.")
      await load()
      if (result.batch_id) await openBatch(result.batch_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le connecteur a échoué.")
    } finally {
      setRunning(false)
    }
  }

  async function resolveDiscrepancy(event: React.FormEvent) {
    event.preventDefault()
    if (!resolving) return
    setSavingResolution(true)
    setError(null)
    try {
      await consoleRequest(`/reconciliation/discrepancies/${resolving.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note: resolutionNote }),
      })
      const batchId = resolving.batch_id
      setResolving(null)
      setResolutionNote("")
      setNotice("Écart résolu et motif journalisé. Les montants du registre n'ont pas été modifiés.")
      await load()
      await openBatch(batchId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Résolution impossible.")
    } finally {
      setSavingResolution(false)
    }
  }

  return (
    <div className="d-grid gap-4">
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-3">
        <div>
          <h1 className="h3 mb-1">Rapprochement automatique</h1>
          <p className="text-body-secondary mb-0">Relevés des agrégateurs comparés au registre des encaissements.</p>
        </div>
        <ConsoleWrite>
          <CButton color="primary" variant="outline" disabled={running || !data?.configuration.configured} onClick={() => void runConnector()}>
            {running ? <CSpinner size="sm" className="me-2" /> : <Play size={17} className="me-2" />}
            Exécuter le connecteur
          </CButton>
        </ConsoleWrite>
      </div>

      <CAlert color="info" className="mb-0">
        Le rapprochement ne valide jamais une activation et ne change aucun montant. Une ligne payée du relevé
        sans preuve dans le registre reste un écart à examiner ; l'activation manuelle conserve sa procédure.
      </CAlert>
      {data && !data.configuration.configured && (
        <CAlert color="secondary" className="mb-0">
          Connecteur planifié non configuré. Les imports manuels restent disponibles. Renseignez l'URL du relevé,
          son jeton et le fournisseur dans l'environnement pour l'exécution automatique.
        </CAlert>
      )}
      {notice && <CAlert color="success" className="mb-0">{notice}</CAlert>}
      {error && <CAlert color="danger" className="mb-0">{error}</CAlert>}

      <ConsoleWrite>
        <CCard>
          <CCardHeader><FileUp size={18} className="me-2" /><strong>Importer un relevé</strong></CCardHeader>
          <CCardBody>
            <CForm onSubmit={(event) => void importStatement(event)}>
              <CRow className="g-3 align-items-end">
                <CCol md={6} lg={2}>
                  <CFormLabel htmlFor="reconciliation-provider">Fournisseur</CFormLabel>
                  <CFormSelect id="reconciliation-provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
                    <option value="wave">Wave</option>
                    <option value="orange_money">Orange Money</option>
                    <option value="mtn_momo">MTN MoMo</option>
                    <option value="moov_money">Moov Money</option>
                    <option value="cinetpay">CinetPay</option>
                    <option value="paydunya">PayDunya</option>
                    <option value="bank_transfer">Virement</option>
                  </CFormSelect>
                </CCol>
                <CCol sm={6} lg={2}>
                  <CFormLabel htmlFor="reconciliation-from">Du</CFormLabel>
                  <CFormInput id="reconciliation-from" type="date" required value={from} onChange={(event) => setFrom(event.target.value)} />
                </CCol>
                <CCol sm={6} lg={2}>
                  <CFormLabel htmlFor="reconciliation-to">Au (inclus)</CFormLabel>
                  <CFormInput id="reconciliation-to" type="date" required min={from} value={to} onChange={(event) => setTo(event.target.value)} />
                </CCol>
                <CCol md={6} lg={2}>
                  <CFormLabel htmlFor="reconciliation-source">Source</CFormLabel>
                  <CFormInput id="reconciliation-source" value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="Nom du relevé" />
                </CCol>
                <CCol md={6} lg={3}>
                  <CFormLabel htmlFor="reconciliation-file">Fichier CSV ou JSON</CFormLabel>
                  <CFormInput key={fileKey} id="reconciliation-file" type="file" accept=".csv,.json,text/csv,application/json" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                </CCol>
                <CCol xs={12} lg={1} className="d-grid">
                  <CButton type="submit" color="primary" disabled={importing}>
                    {importing ? <CSpinner size="sm" /> : "Importer"}
                  </CButton>
                </CCol>
                <CCol xs={12}>
                  <small className="text-body-secondary">
                    Colonnes reconnues : <code>reference</code>, <code>transaction_id</code>, <code>amount</code> ou <code>amount_cents</code>, <code>currency</code>, <code>status</code>, <code>paid_at</code>. Limite : 2 000 lignes.
                  </small>
                </CCol>
              </CRow>
            </CForm>
          </CCardBody>
        </CCard>
      </ConsoleWrite>

      <CCard>
        <CCardHeader className="d-flex align-items-center">
          <ArrowLeftRight size={18} className="me-2" /><strong>Lots de rapprochement</strong>
          {loading && <CSpinner size="sm" className="ms-auto" />}
        </CCardHeader>
        <CCardBody className="p-0">
          <CTable responsive hover align="middle" className="mb-0">
            <CTableHead><CTableRow>
              <CTableHeaderCell>Date</CTableHeaderCell><CTableHeaderCell>Fournisseur</CTableHeaderCell>
              <CTableHeaderCell>Période</CTableHeaderCell><CTableHeaderCell>Lignes</CTableHeaderCell>
              <CTableHeaderCell>Correspondances</CTableHeaderCell><CTableHeaderCell>Écarts</CTableHeaderCell>
              <CTableHeaderCell className="text-end">Détail</CTableHeaderCell>
            </CTableRow></CTableHead>
            <CTableBody>
              {data?.batches.map((batch) => (
                <CTableRow key={batch.id} active={detail?.batch.id === batch.id}>
                  <CTableDataCell>{formatDateTime(batch.created_at)}<div className="small text-body-secondary">{batch.source_name || "Import"}</div></CTableDataCell>
                  <CTableDataCell><CBadge color="secondary">{batch.provider}</CBadge></CTableDataCell>
                  <CTableDataCell className="small">{formatDateTime(batch.period_start)}<br />{formatDateTime(batch.period_end)}</CTableDataCell>
                  <CTableDataCell>{batch.total_rows}</CTableDataCell>
                  <CTableDataCell className="text-success fw-semibold">{batch.matched_rows}</CTableDataCell>
                  <CTableDataCell><CBadge color={batch.discrepancy_rows ? "warning" : "success"}>{batch.open_discrepancies ?? batch.discrepancy_rows} ouvert(s)</CBadge></CTableDataCell>
                  <CTableDataCell className="text-end"><CButton size="sm" color="primary" variant="ghost" onClick={() => void openBatch(batch.id)}>Examiner</CButton></CTableDataCell>
                </CTableRow>
              ))}
              {!loading && data?.batches.length === 0 && (
                <CTableRow><CTableDataCell colSpan={7} className="text-center text-body-secondary py-5">Aucun relevé importé.</CTableDataCell></CTableRow>
              )}
            </CTableBody>
          </CTable>
        </CCardBody>
      </CCard>

      {detailLoading && <div className="text-center py-3"><CSpinner /></div>}
      {detail && (
        <CCard>
          <CCardHeader className="d-flex flex-wrap align-items-center gap-2">
            <TriangleAlert size={18} /><strong>Écarts du lot {detail.batch.id.slice(0, 8)}</strong>
            <CBadge color={detail.batch.status === "matched" ? "success" : "warning"} className="ms-auto">
              {detail.discrepancies.filter((item) => item.status === "open").length} ouvert(s)
            </CBadge>
          </CCardHeader>
          <CCardBody>
            <CRow className="g-3 mb-3">
              <CCol sm={4}><div className="border rounded p-3"><div className="small text-body-secondary">Lignes du relevé</div><strong className="fs-4">{detail.entries.length}</strong></div></CCol>
              <CCol sm={4}><div className="border rounded p-3"><div className="small text-body-secondary">Correspondances</div><strong className="fs-4 text-success">{detail.batch.matched_rows}</strong></div></CCol>
              <CCol sm={4}><div className="border rounded p-3"><div className="small text-body-secondary">Ignorées (non payées)</div><strong className="fs-4">{detail.batch.ignored_rows}</strong></div></CCol>
            </CRow>
            {detail.discrepancies.length === 0 ? (
              <CAlert color="success" className="mb-0"><CheckCircle2 size={18} className="me-2" />Aucun écart sur ce lot.</CAlert>
            ) : (
              <div className="d-grid gap-3">
                {detail.discrepancies.map((item) => (
                  <div key={item.id} className="border rounded p-3">
                    <div className="d-flex flex-wrap align-items-start justify-content-between gap-3">
                      <div>
                        <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                          <CBadge color={item.status === "open" ? "warning" : "success"}>{item.status === "open" ? "À examiner" : "Résolu"}</CBadge>
                          <strong>{DISCREPANCY_LABELS[item.kind]}</strong>
                        </div>
                        <div className="small text-body-secondary">{item.reference || "Sans référence"}{item.organization_name ? ` · ${item.organization_name}` : ""}</div>
                      </div>
                      {item.status === "open" && (
                        <ConsoleWrite><CButton size="sm" color="primary" variant="outline" onClick={() => { setResolving(item); setResolutionNote("") }}>Résoudre</CButton></ConsoleWrite>
                      )}
                    </div>
                    <p className="my-2">{item.details}</p>
                    <div className="d-flex flex-wrap gap-4 small">
                      <span>Attendu : <strong>{amount(item.expected_amount_cents)}</strong></span>
                      <span>Sur le relevé : <strong>{amount(item.actual_amount_cents)}</strong></span>
                    </div>
                    {item.resolution_note && <CAlert color="success" className="small mt-3 mb-0">{item.resolution_note}<br />{item.resolved_by_email} · {item.resolved_at ? formatDateTime(item.resolved_at) : ""}</CAlert>}
                  </div>
                ))}
              </div>
            )}
          </CCardBody>
        </CCard>
      )}

      <CCard>
        <CCardHeader><strong>Dernières exécutions</strong></CCardHeader>
        <CCardBody className="p-0">
          <CTable responsive className="mb-0">
            <CTableHead><CTableRow><CTableHeaderCell>Début</CTableHeaderCell><CTableHeaderCell>Déclencheur</CTableHeaderCell><CTableHeaderCell>État</CTableHeaderCell><CTableHeaderCell>Message</CTableHeaderCell></CTableRow></CTableHead>
            <CTableBody>
              {data?.runs.slice(0, 8).map((run) => (
                <CTableRow key={run.id}>
                  <CTableDataCell>{formatDateTime(run.started_at)}</CTableDataCell>
                  <CTableDataCell>{run.trigger_kind === "scheduled" ? "Planifié" : "Manuel"}</CTableDataCell>
                  <CTableDataCell><CBadge color={run.status === "success" ? "success" : run.status === "failed" ? "danger" : "secondary"}>{run.status}</CBadge></CTableDataCell>
                  <CTableDataCell className="small">{run.error || (run.batch_id ? `Lot ${run.batch_id.slice(0, 8)}` : "—")}</CTableDataCell>
                </CTableRow>
              ))}
              {!loading && data?.runs.length === 0 && <CTableRow><CTableDataCell colSpan={4} className="text-center text-body-secondary py-4">Aucune exécution.</CTableDataCell></CTableRow>}
            </CTableBody>
          </CTable>
        </CCardBody>
      </CCard>

      <CModal visible={resolving !== null} onClose={() => { if (!savingResolution) setResolving(null) }} alignment="center">
        <CForm onSubmit={(event) => void resolveDiscrepancy(event)}>
          <CModalHeader><CModalTitle>Résoudre l'écart</CModalTitle></CModalHeader>
          <CModalBody>
            <p>Expliquez la vérification effectuée. Cette action clôt l'écart sans modifier le registre comptable.</p>
            <CFormLabel htmlFor="resolution-note">Motif et contrôle réalisé</CFormLabel>
            <CFormTextarea id="resolution-note" required minLength={5} rows={4} value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} />
          </CModalBody>
          <CModalFooter>
            <CButton type="button" color="secondary" variant="ghost" onClick={() => setResolving(null)}>Annuler</CButton>
            <CButton type="submit" color="primary" disabled={savingResolution}>{savingResolution ? "Enregistrement…" : "Clôturer l'écart"}</CButton>
          </CModalFooter>
        </CForm>
      </CModal>
    </div>
  )
}

export default ConsoleReconciliation
