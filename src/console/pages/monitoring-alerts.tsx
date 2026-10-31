import * as React from "react"
import { BellRing, Mail, MessageCircle, Send } from "lucide-react"
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
  CFormSwitch,
  CFormTextarea,
  CRow,
  CSpinner,
} from "@coreui/react"

import { consoleRequest, formatDateTime } from "../api"
import { ConsoleAdminOnly } from "../auth"
import type { AlertDelivery, AlertEvent, AlertSettings } from "../types"

interface AlertsResponse {
  settings: AlertSettings
  events: AlertEvent[]
  channels: { email_configured: boolean; whatsapp_configured: boolean }
}

function deliveryBadges(deliveries: AlertDelivery[]) {
  if (!deliveries?.length) return <span className="small text-body-secondary">Aucune remise</span>
  return deliveries.map((delivery, index) => (
    <CBadge key={`${delivery.channel}-${delivery.recipient}-${index}`} color={delivery.delivered ? "success" : "danger"} className="me-1" title={delivery.error ?? undefined}>
      {delivery.channel === "email" ? "E-mail" : "WhatsApp"} · {delivery.delivered ? "remis" : "échec"}
    </CBadge>
  ))
}

export function MonitoringAlerts() {
  const [settings, setSettings] = React.useState<AlertSettings | null>(null)
  const [events, setEvents] = React.useState<AlertEvent[]>([])
  const [channels, setChannels] = React.useState({ email_configured: false, whatsapp_configured: false })
  const [emails, setEmails] = React.useState("")
  const [phones, setPhones] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const payload = await consoleRequest<AlertsResponse>("/monitoring/alerts")
      setSettings(payload.settings)
      setEvents(payload.events)
      setChannels(payload.channels)
      setEmails(payload.settings.email_recipients.join("\n"))
      setPhones(payload.settings.whatsapp_recipients.join("\n"))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de charger les alertes.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void (async () => { await load() })()
  }, [load])

  function updateNumber(key: "error_rate_percent" | "min_requests" | "slow_request_count" | "window_minutes" | "cooldown_minutes", value: string) {
    setSettings((current) => current ? { ...current, [key]: Number(value) } : current)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!settings) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const recipients = (value: string) => value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean)
      const payload = await consoleRequest<{ settings: AlertSettings }>("/monitoring/alerts/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: settings.enabled,
          error_rate_percent: settings.error_rate_percent,
          min_requests: settings.min_requests,
          slow_request_count: settings.slow_request_count,
          window_minutes: settings.window_minutes,
          cooldown_minutes: settings.cooldown_minutes,
          email_recipients: recipients(emails),
          whatsapp_recipients: recipients(phones),
        }),
      })
      setSettings(payload.settings)
      setNotice("Réglages des alertes enregistrés.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enregistrement impossible.")
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await consoleRequest<{ deliveries: AlertDelivery[] }>("/monitoring/alerts/test", { method: "POST" })
      const delivered = result.deliveries.filter((item) => item.delivered).length
      setNotice(`Test terminé : ${delivered}/${result.deliveries.length} remise(s) confirmée(s).`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test impossible.")
    } finally {
      setTesting(false)
    }
  }

  return (
    <CCard>
      <CCardHeader className="d-flex flex-wrap align-items-center gap-2">
        <BellRing size={18} /><strong>Alertes proactives</strong>
        <span className="small text-body-secondary">E-mail et WhatsApp sortants</span>
        <div className="ms-auto d-flex gap-1">
          <CBadge color={channels.email_configured ? "success" : "secondary"}><Mail size={12} className="me-1" />E-mail</CBadge>
          <CBadge color={channels.whatsapp_configured ? "success" : "secondary"}><MessageCircle size={12} className="me-1" />WhatsApp</CBadge>
        </div>
      </CCardHeader>
      <CCardBody>
        {loading ? <div className="text-center py-4"><CSpinner /></div> : settings ? (
          <div className="d-grid gap-4">
            {error && <CAlert color="danger" className="mb-0">{error}</CAlert>}
            {notice && <CAlert color="success" className="mb-0">{notice}</CAlert>}
            <ConsoleAdminOnly fallback={<CAlert color="secondary" className="mb-0">Votre profil support peut consulter les remises, mais seuls les administrateurs modifient les alertes.</CAlert>}>
              <CForm onSubmit={(event) => void save(event)}>
                <CRow className="g-3">
                  <CCol xs={12}>
                    <CFormSwitch label="Activer l'évaluation et les envois planifiés" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
                  </CCol>
                  <CCol sm={6} lg={2}>
                    <CFormLabel htmlFor="alert-error-rate">Erreurs 5xx (%)</CFormLabel>
                    <CFormInput id="alert-error-rate" type="number" min={0.01} max={100} step={0.01} required value={settings.error_rate_percent} onChange={(event) => updateNumber("error_rate_percent", event.target.value)} />
                  </CCol>
                  <CCol sm={6} lg={2}>
                    <CFormLabel htmlFor="alert-min-requests">Trafic minimum</CFormLabel>
                    <CFormInput id="alert-min-requests" type="number" min={1} required value={settings.min_requests} onChange={(event) => updateNumber("min_requests", event.target.value)} />
                  </CCol>
                  <CCol sm={6} lg={2}>
                    <CFormLabel htmlFor="alert-slow-count">Requêtes lentes</CFormLabel>
                    <CFormInput id="alert-slow-count" type="number" min={1} required value={settings.slow_request_count} onChange={(event) => updateNumber("slow_request_count", event.target.value)} />
                  </CCol>
                  <CCol sm={6} lg={3}>
                    <CFormLabel htmlFor="alert-window">Fenêtre (minutes)</CFormLabel>
                    <CFormInput id="alert-window" type="number" min={5} max={1440} required value={settings.window_minutes} onChange={(event) => updateNumber("window_minutes", event.target.value)} />
                  </CCol>
                  <CCol sm={6} lg={3}>
                    <CFormLabel htmlFor="alert-cooldown">Silence entre alertes (min)</CFormLabel>
                    <CFormInput id="alert-cooldown" type="number" min={5} required value={settings.cooldown_minutes} onChange={(event) => updateNumber("cooldown_minutes", event.target.value)} />
                  </CCol>
                  <CCol md={6}>
                    <CFormLabel htmlFor="alert-emails">Destinataires e-mail</CFormLabel>
                    <CFormTextarea id="alert-emails" rows={3} value={emails} onChange={(event) => setEmails(event.target.value)} placeholder={"alertes@exemple.ci\nadmin@exemple.ci"} />
                    <small className="text-body-secondary">Une adresse par ligne, ou séparées par des virgules.</small>
                  </CCol>
                  <CCol md={6}>
                    <CFormLabel htmlFor="alert-phones">Destinataires WhatsApp</CFormLabel>
                    <CFormTextarea id="alert-phones" rows={3} value={phones} onChange={(event) => setPhones(event.target.value)} placeholder={"+2250700000000"} />
                    <small className="text-body-secondary">Numéros internationaux. Un modèle approuvé Meta est requis.</small>
                  </CCol>
                  <CCol xs={12} className="d-flex flex-wrap gap-2">
                    <CButton type="submit" color="primary" disabled={saving}>{saving ? <CSpinner size="sm" className="me-2" /> : null}{saving ? "Enregistrement…" : "Enregistrer les réglages"}</CButton>
                    <CButton type="button" color="secondary" variant="outline" disabled={testing} onClick={() => void test()}><Send size={16} className="me-2" />{testing ? "Envoi…" : "Envoyer un test"}</CButton>
                  </CCol>
                </CRow>
              </CForm>
            </ConsoleAdminOnly>

            <div>
              <h3 className="h6">Historique des remises</h3>
              {events.length === 0 ? <p className="text-body-secondary mb-0">Aucune alerte déclenchée.</p> : (
                <div className="d-grid gap-2">
                  {events.slice(0, 12).map((event) => (
                    <div key={event.id} className="border rounded p-3">
                      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2">
                        <div><strong>{event.title}</strong><div className="small text-body-secondary">{formatDateTime(event.triggered_at)}</div></div>
                        <CBadge color={event.severity === "critical" ? "danger" : event.severity === "warning" ? "warning" : "info"}>{event.kind === "test" ? "Test" : event.severity}</CBadge>
                      </div>
                      <p className="small my-2">{event.message}</p>
                      <div>{deliveryBadges(event.deliveries)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : <CAlert color="danger" className="mb-0">{error || "Réglages indisponibles."}</CAlert>}
      </CCardBody>
    </CCard>
  )
}

export default MonitoringAlerts
