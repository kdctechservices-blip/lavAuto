/**
 * La santé du service, vue de la console.
 *
 * Ce que cet écran remplace : rien. Avant lui, un incident se découvrait par
 * l'appel d'un client, et une erreur 500 n'existait que le temps d'une ligne
 * de `console.error` dans un terminal que personne ne lisait.
 *
 * Trois questions, trois niveaux de détail :
 *
 *   1. « Est-ce que ça va ? »      → `GET /monitoring` : taux d'erreur, latence,
 *                                     courbe, et les routes qui souffrent.
 *   2. « Qu'est-ce qui casse ? »   → `GET /monitoring/errors` : les incidents,
 *                                     **regroupés**, parce que vingt fois la
 *                                     même panne est un problème et non vingt.
 *   3. « Pourquoi ? »              → `GET /monitoring/errors/:id` : la pile
 *                                     d'appel et le corps de la requête.
 *
 * ## Le corps des requêtes est une donnée de client
 *
 * Conserver les corps a été décidé en connaissance de cause : c'est ce qui
 * permet de reproduire un bug sans redemander au client ce qu'il a tapé. Mais
 * un corps contient des montants et des noms de clients, et deux garde-fous
 * l'encadrent :
 *
 *   - les identifiants de connexion n'y entrent jamais (voir `redactBody`) ;
 *   - **ouvrir un corps laisse une trace** dans `platform_audit_logs`, au même
 *     titre que n'importe quelle autre lecture de données client par
 *     l'éditeur. Le niveau 3 est le seul à journaliser : consulter des
 *     compteurs agrégés n'engage personne, lire ce qu'un gérant a saisi, si.
 */

import type { Router } from "express"
import { z } from "zod"
import { asyncRoute, body, parseId } from "./http.ts"
import { HttpError } from "./auth.ts"
import { adminDb } from "./platform-admin.ts"
import { logConsoleAction, requireConsoleAdmin } from "./console-auth.ts"
import {
  ERROR_RETENTION_DAYS,
  METRICS_RETENTION_DAYS,
  SLOW_REQUEST_MS,
  errorGroups,
  getErrorEvent,
  listErrorEvents,
  monitoringOverview,
} from "./monitoring.ts"
import {
  getMonitoringAlertSettings,
  listMonitoringAlertEvents,
  monitoringAlertChannels,
  saveMonitoringAlertSettings,
  sendTestMonitoringAlert,
} from "./monitoring-alerts.ts"

function hoursParam(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.min(Math.round(n), 24 * 30)
}

export function registerMonitoringRoutes(r: Router): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/console/monitoring — l'état du service.
  // -------------------------------------------------------------------------
  r.get(
    "/monitoring",
    asyncRoute(async (req, res) => {
      const hours = hoursParam(req.query.hours)
      const pool = adminDb()
      const [overview, groups] = await Promise.all([
        monitoringOverview(pool, { hours }),
        errorGroups(pool, { hours }),
      ])
      res.json({
        ...overview,
        error_groups: groups,
        // Les seuils sont renvoyés avec les chiffres : un écran qui affiche
        // « 3 requêtes lentes » sans dire à partir de quand une requête est
        // lente n'informe de rien.
        thresholds: {
          slow_request_ms: SLOW_REQUEST_MS,
          error_retention_days: ERROR_RETENTION_DAYS,
          metrics_retention_days: METRICS_RETENTION_DAYS,
        },
      })
    }),
  )

  // Alertes proactives : les réglages sont lisibles par le support, mais leur
  // modification et les envois de test passent par le garde admin global.
  r.get(
    "/monitoring/alerts",
    asyncRoute(async (_req, res) => {
      const pool = adminDb()
      const [settings, events] = await Promise.all([
        getMonitoringAlertSettings(pool),
        listMonitoringAlertEvents(pool),
      ])
      res.json({ settings, events, channels: monitoringAlertChannels() })
    }),
  )

  const alertSettingsSchema = z.object({
    enabled: z.boolean(),
    error_rate_percent: z.number().min(0.01).max(100),
    min_requests: z.number().int().min(1).max(1_000_000),
    slow_request_count: z.number().int().min(1).max(100_000),
    window_minutes: z.number().int().min(5).max(1440),
    cooldown_minutes: z.number().int().min(5).max(10_080),
    email_recipients: z.array(z.string().trim().toLowerCase().email()).max(20),
    whatsapp_recipients: z.array(
      z.string().trim().regex(/^\+?[0-9 ()-]{8,24}$/, "Numéro WhatsApp international invalide."),
    ).max(20),
  }).strip().refine(
    (value) => !value.enabled || value.email_recipients.length + value.whatsapp_recipients.length > 0,
    { message: "Ajoutez au moins un destinataire avant d'activer les alertes." },
  )

  r.put(
    "/monitoring/alerts/settings",
    requireConsoleAdmin,
    asyncRoute(async (req, res) => {
      const input = body(alertSettingsSchema, req.body)
      const pool = adminDb()
      const settings = await saveMonitoringAlertSettings(pool, {
        ...input,
        email_recipients: [...new Set(input.email_recipients)],
        whatsapp_recipients: [...new Set(input.whatsapp_recipients)],
      }, req.operator!.operatorId)
      await logConsoleAction(pool, req.operator!, "monitoring.alerts.configured", null, null, {
        enabled: settings.enabled,
        error_rate_percent: settings.error_rate_percent,
        min_requests: settings.min_requests,
        slow_request_count: settings.slow_request_count,
        window_minutes: settings.window_minutes,
        cooldown_minutes: settings.cooldown_minutes,
        email_recipients: settings.email_recipients.length,
        whatsapp_recipients: settings.whatsapp_recipients.length,
      })
      res.json({ settings })
    }),
  )

  r.post(
    "/monitoring/alerts/test",
    requireConsoleAdmin,
    asyncRoute(async (req, res) => {
      const pool = adminDb()
      const settings = await getMonitoringAlertSettings(pool)
      if (settings.email_recipients.length + settings.whatsapp_recipients.length === 0) {
        throw new HttpError(400, "alert_recipient_required", "Ajoutez un destinataire avant l'envoi de test.")
      }
      const result = await sendTestMonitoringAlert(pool)
      await logConsoleAction(pool, req.operator!, "monitoring.alerts.tested", null, null, {
        event_id: result.event_id,
        deliveries: result.deliveries.map(({ channel, recipient, delivered }) => ({ channel, recipient, delivered })),
      })
      res.json(result)
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/v1/console/monitoring/errors — la liste brute.
  //
  // Sans corps ni pile d'appel : c'est une liste de repérage. Le détail se
  // demande explicitement, et c'est lui qui est journalisé.
  // -------------------------------------------------------------------------
  r.get(
    "/monitoring/errors",
    asyncRoute(async (req, res) => {
      const kind = typeof req.query.kind === "string" ? req.query.kind : null
      if (kind && kind !== "error" && kind !== "slow") {
        throw new HttpError(400, "invalid_data", "Type d'incident inconnu.")
      }
      const events = await listErrorEvents(adminDb(), {
        kind,
        route: typeof req.query.route === "string" ? req.query.route : null,
        limit: Number(req.query.limit) || undefined,
      })
      res.json({ events, server_time: new Date().toISOString() })
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/v1/console/monitoring/errors/:id — le détail, et sa trace.
  // -------------------------------------------------------------------------
  r.get(
    "/monitoring/errors/:id",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const pool = adminDb()
      const event = await getErrorEvent(pool, id)
      if (!event) throw new HttpError(404, "not_found", "Cet incident n'existe pas.")

      // Journalisé avant la réponse : si l'écriture de la trace échoue, la
      // lecture échoue aussi. Une consultation non tracée vaudrait moins que
      // pas de consultation du tout.
      await logConsoleAction(
        pool,
        req.operator!,
        "monitoring.error.read",
        event.organization_id ?? null,
        event.organization_name ?? null,
        { error_id: id, route: event.route, status: event.status, code: event.code },
      )

      res.json({ event })
    }),
  )
}
