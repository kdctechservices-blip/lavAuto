import type { Pool, PoolClient } from "pg"

import { env } from "./env.ts"
import { isMailerConfigured, sendMail, type MailMessage } from "./mailer.ts"

type Queryable = Pick<Pool | PoolClient, "query">

export interface MonitoringAlertSettings {
  enabled: boolean
  error_rate_percent: number
  min_requests: number
  slow_request_count: number
  window_minutes: number
  cooldown_minutes: number
  email_recipients: string[]
  whatsapp_recipients: string[]
  updated_at: string
}

export interface AlertMetrics {
  requests: number
  server_errors: number
  slow_requests: number
  error_rate_percent: number
  window_minutes: number
}

export interface AlertCandidate {
  fingerprint: string
  kind: "error_rate" | "slow_requests" | "test"
  severity: "info" | "warning" | "critical"
  title: string
  message: string
  metrics: Record<string, unknown>
}

export interface AlertDelivery {
  channel: "email" | "whatsapp"
  recipient: string
  delivered: boolean
  error: string | null
}

interface SettingsRow {
  enabled: boolean
  error_rate_percent: string | number
  min_requests: number
  slow_request_count: number
  window_minutes: number
  cooldown_minutes: number
  email_recipients: string[] | null
  whatsapp_recipients: string[] | null
  updated_at: string
}

function mapSettings(row: SettingsRow): MonitoringAlertSettings {
  return {
    enabled: row.enabled,
    error_rate_percent: Number(row.error_rate_percent),
    min_requests: Number(row.min_requests),
    slow_request_count: Number(row.slow_request_count),
    window_minutes: Number(row.window_minutes),
    cooldown_minutes: Number(row.cooldown_minutes),
    email_recipients: row.email_recipients ?? [],
    whatsapp_recipients: row.whatsapp_recipients ?? [],
    updated_at: row.updated_at,
  }
}

export async function getMonitoringAlertSettings(pool: Queryable): Promise<MonitoringAlertSettings> {
  const q = await pool.query<SettingsRow>("SELECT * FROM platform_alert_settings WHERE id = 1")
  if (!q.rows[0]) throw new Error("Les réglages d'alerte ne sont pas initialisés.")
  return mapSettings(q.rows[0])
}

export async function saveMonitoringAlertSettings(
  pool: Queryable,
  input: Omit<MonitoringAlertSettings, "updated_at">,
  operatorId: string,
): Promise<MonitoringAlertSettings> {
  const q = await pool.query<SettingsRow>(
    `UPDATE platform_alert_settings SET
       enabled = $1, error_rate_percent = $2, min_requests = $3,
       slow_request_count = $4, window_minutes = $5, cooldown_minutes = $6,
       email_recipients = $7::text[], whatsapp_recipients = $8::text[],
       updated_by = $9::uuid, updated_at = now()
     WHERE id = 1 RETURNING *`,
    [
      input.enabled,
      input.error_rate_percent,
      input.min_requests,
      input.slow_request_count,
      input.window_minutes,
      input.cooldown_minutes,
      input.email_recipients,
      input.whatsapp_recipients,
      operatorId,
    ],
  )
  return mapSettings(q.rows[0])
}

/**
 * Évalue des compteurs exacts, jamais une moyenne sur une fenêtre trop petite.
 * Le minimum de requêtes évite l'alerte « 100 % d'erreurs » sur un seul appel.
 */
export function evaluateMonitoringAlerts(
  metrics: AlertMetrics,
  settings: Pick<MonitoringAlertSettings, "error_rate_percent" | "min_requests" | "slow_request_count">,
): AlertCandidate[] {
  if (metrics.requests < settings.min_requests) return []
  const alerts: AlertCandidate[] = []
  if (metrics.error_rate_percent >= settings.error_rate_percent) {
    alerts.push({
      fingerprint: "monitoring:error_rate",
      kind: "error_rate",
      severity: "critical",
      title: "Taux d'erreurs serveur élevé",
      message: `${metrics.error_rate_percent.toFixed(2)} % d'erreurs 5xx sur ${metrics.requests} requêtes pendant les ${metrics.window_minutes} dernières minutes (${metrics.server_errors} erreurs). Seuil : ${settings.error_rate_percent} %.`,
      metrics: { ...metrics, threshold_percent: settings.error_rate_percent },
    })
  }
  if (metrics.slow_requests >= settings.slow_request_count) {
    alerts.push({
      fingerprint: "monitoring:slow_requests",
      kind: "slow_requests",
      severity: "warning",
      title: "Requêtes anormalement lentes",
      message: `${metrics.slow_requests} requêtes lentes pendant les ${metrics.window_minutes} dernières minutes. Seuil : ${settings.slow_request_count}.`,
      metrics: { ...metrics, threshold_slow_requests: settings.slow_request_count },
    })
  }
  return alerts
}

async function recentMetrics(pool: Queryable, now: Date, windowMinutes: number): Promise<AlertMetrics> {
  const q = await pool.query(
    `SELECT coalesce(sum(requests),0)::bigint AS requests,
            coalesce(sum(requests) FILTER (WHERE status_class = '5xx'),0)::bigint AS errors,
            coalesce(sum(slow_requests),0)::bigint AS slow
       FROM request_metrics
      WHERE bucket_start >= $1::timestamptz - make_interval(mins => $2)
        AND bucket_start <= $1::timestamptz`,
    [now.toISOString(), windowMinutes],
  )
  const requests = Number(q.rows[0]?.requests ?? 0)
  const serverErrors = Number(q.rows[0]?.errors ?? 0)
  return {
    requests,
    server_errors: serverErrors,
    slow_requests: Number(q.rows[0]?.slow ?? 0),
    error_rate_percent: requests > 0 ? Math.round((serverErrors / requests) * 10000) / 100 : 0,
    window_minutes: windowMinutes,
  }
}

export function monitoringAlertMessage(candidate: AlertCandidate, recipient: string): MailMessage {
  const base = env.APP_URL.replace(/\/+$/, "")
  return {
    to: recipient,
    subject: `[WashPilot ${candidate.severity === "critical" ? "CRITIQUE" : "ALERTE"}] ${candidate.title}`,
    text: [candidate.title, "", candidate.message, "", `Ouvrir la surveillance : ${base ? `${base}/console/surveillance` : "/console/surveillance"}`].join("\n"),
  }
}

/**
 * WhatsApp Cloud API. Une alerte proactive sort du fenêtrage de 24 h : elle
 * utilise donc un modèle approuvé à deux variables (titre puis détail), et non
 * un message libre que Meta refuserait. Les secrets restent hors de la base.
 */
export async function sendWhatsAppMonitoringAlert(
  recipient: string,
  candidate: AlertCandidate,
  fetchImpl: typeof fetch = fetch,
): Promise<{ delivered: boolean; error: string | null }> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ALERT_TEMPLATE) {
    return { delivered: false, error: "WhatsApp Cloud API ou modèle d'alerte non configuré." }
  }
  try {
    const response = await fetchImpl(
      `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipient.replace(/\D/g, ""),
          type: "template",
          template: {
            name: env.WHATSAPP_ALERT_TEMPLATE,
            language: { code: env.WHATSAPP_ALERT_TEMPLATE_LANGUAGE },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: candidate.title.slice(0, 200) },
                { type: "text", text: candidate.message.slice(0, 900) },
              ],
            }],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return { delivered: false, error: `WhatsApp a refusé l'envoi (${response.status}) : ${detail.slice(0, 250)}` }
    }
    return { delivered: true, error: null }
  } catch (error) {
    return { delivered: false, error: error instanceof Error ? error.message : "Erreur WhatsApp inconnue" }
  }
}

async function dispatchAlert(
  pool: Pool,
  eventId: string,
  candidate: AlertCandidate,
  settings: MonitoringAlertSettings,
  fetchImpl: typeof fetch,
): Promise<AlertDelivery[]> {
  const deliveries: AlertDelivery[] = []
  for (const recipient of settings.email_recipients) {
    const delivered = await sendMail(monitoringAlertMessage(candidate, recipient))
    deliveries.push({
      channel: "email",
      recipient,
      delivered,
      error: delivered ? null : "E-mail non remis : fournisseur absent ou envoi refusé.",
    })
  }
  for (const recipient of settings.whatsapp_recipients) {
    const result = await sendWhatsAppMonitoringAlert(recipient, candidate, fetchImpl)
    deliveries.push({ channel: "whatsapp", recipient, delivered: result.delivered, error: result.error })
  }
  await pool.query("UPDATE platform_alert_events SET deliveries = $2::jsonb WHERE id = $1::uuid", [
    eventId,
    JSON.stringify(deliveries),
  ])
  return deliveries
}

async function reserveAlert(
  pool: Pool,
  candidate: AlertCandidate,
  cooldownMinutes: number,
  now: Date,
  bypassCooldown: boolean,
): Promise<string | null> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [candidate.fingerprint])
    if (!bypassCooldown) {
      const recent = await client.query(
        `SELECT 1 FROM platform_alert_events
         WHERE fingerprint = $1 AND triggered_at > $2::timestamptz - make_interval(mins => $3)
         LIMIT 1`,
        [candidate.fingerprint, now.toISOString(), cooldownMinutes],
      )
      if (recent.rowCount) {
        await client.query("ROLLBACK")
        return null
      }
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO platform_alert_events(fingerprint, kind, severity, title, message, metrics, triggered_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) RETURNING id`,
      [
        candidate.fingerprint,
        candidate.kind,
        candidate.severity,
        candidate.title,
        candidate.message,
        JSON.stringify(candidate.metrics),
        now.toISOString(),
      ],
    )
    await client.query("COMMIT")
    return inserted.rows[0].id
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function runMonitoringAlerts(
  pool: Pool,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
) {
  const settings = await getMonitoringAlertSettings(pool)
  if (!settings.enabled) return []
  const now = options.now ?? new Date()
  const metrics = await recentMetrics(pool, now, settings.window_minutes)
  const candidates = evaluateMonitoringAlerts(metrics, settings)
  const outcomes: Array<{ event_id: string; kind: string; deliveries: AlertDelivery[] }> = []
  for (const candidate of candidates) {
    const eventId = await reserveAlert(pool, candidate, settings.cooldown_minutes, now, false)
    if (!eventId) continue
    const deliveries = await dispatchAlert(pool, eventId, candidate, settings, options.fetchImpl ?? fetch)
    outcomes.push({ event_id: eventId, kind: candidate.kind, deliveries })
  }
  return outcomes
}

export async function sendTestMonitoringAlert(
  pool: Pool,
  options: { fetchImpl?: typeof fetch } = {},
) {
  const settings = await getMonitoringAlertSettings(pool)
  const now = new Date()
  const candidate: AlertCandidate = {
    fingerprint: `monitoring:test:${now.toISOString()}`,
    kind: "test",
    severity: "info",
    title: "Test des alertes WashPilot CI",
    message: "Ce message confirme que les destinataires et le fournisseur d'alerte sont correctement configurés.",
    metrics: { test: true },
  }
  const eventId = await reserveAlert(pool, candidate, 0, now, true)
  if (!eventId) throw new Error("Impossible de réserver l'alerte de test.")
  const deliveries = await dispatchAlert(pool, eventId, candidate, settings, options.fetchImpl ?? fetch)
  return { event_id: eventId, deliveries }
}

export async function listMonitoringAlertEvents(pool: Queryable, limit = 30) {
  const q = await pool.query(
    "SELECT * FROM platform_alert_events ORDER BY triggered_at DESC LIMIT $1",
    [Math.min(Math.max(limit, 1), 100)],
  )
  return q.rows
}

export function monitoringAlertChannels() {
  return {
    email_configured: isMailerConfigured(),
    whatsapp_configured: Boolean(
      env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ALERT_TEMPLATE,
    ),
  }
}
