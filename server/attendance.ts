// ---------------------------------------------------------------------------
// Équipes : présences, horaires, attribution du travail et rendement.
//
// Ce module ne calcule rien lui-même : tout le raisonnement est dans
// `attendance-rules.ts`, éprouvé sans base. Ici on lit, on écrit, on vérifie
// les droits et on compose.
//
// Deux décisions structurent le module, et elles découlent du produit tel
// qu'il est, pas du module tel qu'on l'imaginerait.
//
//   • **Un lavage est enregistré après coup.** WashPilot est une caisse
//     enregistreuse : le lavage naît « terminé ». Il n'y a donc ni tâche en
//     cours, ni heure de début, ni durée de réalisation. Tout indicateur qui
//     en dépendrait serait vide à jamais : on ne le construit pas, et on le
//     dit à l'écran plutôt que d'afficher une colonne perpétuellement à zéro.
//
//   • **La personne qui définit l'heure prévue et celle qui peut réécrire un
//     pointage exercent le même pouvoir** : elles décident de ce qui servira
//     peut-être à juger quelqu'un. Les horaires et les corrections sont donc
//     derrière la même permission, `attendance:correct`.
// ---------------------------------------------------------------------------

import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"
import { requireCapability } from "./entitlements.ts"
import {
  ATTENDANCE_STATUSES,
  dayState,
  evaluateLateness,
  isCoherent,
  perPresentDay,
  perWorkedHour,
  resolveSchedule,
  shareMilli,
  workedMinutes,
  type ScheduleRow,
} from "./attendance-rules.ts"

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ.")
const minuteOfDaySchema = z.number().int().min(0).max(1439)

export const attendanceValidators = {
  schedule: z
    .object({
      site_id: z.string().uuid().nullable().optional(),
      worker_id: z.string().uuid().nullable().optional(),
      day_of_week: z.number().int().min(0).max(6).nullable().optional(),
      specific_date: isoDate.nullable().optional(),
      start_minute: minuteOfDaySchema,
      end_minute: minuteOfDaySchema,
      break_duration_minutes: z.number().int().min(0).max(600).default(0),
      late_tolerance_minutes: z.number().int().min(0).max(240).default(15),
      valid_from: isoDate.optional(),
      valid_to: isoDate.nullable().optional(),
    })
    .strip(),
  checkIn: z
    .object({
      worker_id: z.string().uuid(),
      work_date: isoDate.optional(),
      at: z.string().datetime().optional(),
    })
    .strip(),
  checkOut: z
    .object({
      worker_id: z.string().uuid(),
      work_date: isoDate.optional(),
      at: z.string().datetime().optional(),
      break_minutes: z.number().int().min(0).max(600).optional(),
    })
    .strip(),
  absence: z
    .object({
      worker_id: z.string().uuid(),
      work_date: isoDate.optional(),
      // On ne peut *déclarer* qu'une absence ou un congé. Qualifier une
      // absence de justifiée ou non justifiée est une décision, pas une
      // saisie : elle passe par la correction, qui exige un motif et laisse
      // une trace nominative.
      status: z.enum(["absent_declared", "leave"]),
      reason: z.string().trim().max(500).optional(),
    })
    .strip(),
  correction: z
    .object({
      status: z.enum(ATTENDANCE_STATUSES).optional(),
      check_in_at: z.string().datetime().nullable().optional(),
      check_out_at: z.string().datetime().nullable().optional(),
      break_minutes: z.number().int().min(0).max(600).nullable().optional(),
      absence_reason: z.string().trim().max(500).nullable().optional(),
      reason: z.string().trim().min(3).max(500),
    })
    .strip(),
}

/**
 * Minute du jour d'un horodatage.
 *
 * La Côte d'Ivoire est à UTC+0 toute l'année, sans heure d'été : l'heure
 * locale d'une station et l'heure UTC coïncident. Une station hors de ce
 * fuseau demanderait de porter le fuseau sur la station et de convertir ici.
 */
function minuteFrom(value: Date | string | null): number | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function isoFrom(value: Date | string | null): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function dateKey(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value)
  return d.toISOString().slice(0, 10)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function loadSchedules(pool: Pool, organizationId: string): Promise<ScheduleRow[]> {
  const q = await pool.query(
    `SELECT site_id, worker_id, day_of_week, specific_date, start_minute, end_minute,
            break_duration_minutes, late_tolerance_minutes, valid_from, valid_to
     FROM work_schedules WHERE organization_id=$1::uuid`,
    [organizationId],
  )
  return q.rows.map((r) => ({
    siteId: r.site_id === null ? null : String(r.site_id),
    workerId: r.worker_id === null ? null : String(r.worker_id),
    dayOfWeek: r.day_of_week === null ? null : Number(r.day_of_week),
    specificDate: r.specific_date === null ? null : dateKey(r.specific_date as Date),
    startMinute: Number(r.start_minute),
    endMinute: Number(r.end_minute),
    breakDurationMinutes: Number(r.break_duration_minutes),
    lateToleranceMinutes: Number(r.late_tolerance_minutes),
    validFrom: dateKey(r.valid_from as Date),
    validTo: r.valid_to === null ? null : dateKey(r.valid_to as Date),
  }))
}

/** Vérifie que le laveur appartient bien à l'organisation de l'appelant. */
async function assertWorker(
  pool: Pool,
  organizationId: string,
  workerId: string,
): Promise<{ id: string; site_id: string | null; status: string }> {
  const q = await pool.query(
    "SELECT id, site_id, status FROM workers WHERE id=$1::uuid AND organization_id=$2::uuid",
    [workerId, organizationId],
  )
  if (!q.rowCount) throw new HttpError(404, "worker_not_found", "Laveur introuvable.")
  return q.rows[0] as { id: string; site_id: string | null; status: string }
}

export function createAttendanceRouter() {
  const r = Router()

  // -------------------------------------------------------------------------
  // Horaires
  // -------------------------------------------------------------------------

  r.get(
    "/work-schedules",
    requirePermission("attendance:read"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT s.id, s.site_id, s.worker_id, s.day_of_week, s.specific_date, s.start_minute, s.end_minute,
                s.break_duration_minutes, s.late_tolerance_minutes, s.valid_from, s.valid_to,
                w.first_name, w.last_name
         FROM work_schedules s
         LEFT JOIN workers w ON w.id = s.worker_id AND w.organization_id = s.organization_id
         WHERE s.organization_id=$1::uuid
         ORDER BY s.worker_id NULLS FIRST, s.day_of_week NULLS FIRST`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/work-schedules",
    requirePermission("attendance:correct"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(attendanceValidators.schedule, req.body)
      const pool = db()

      if (input.end_minute <= input.start_minute) {
        throw new HttpError(400, "invalid_schedule", "L'heure de fin doit suivre l'heure de début.")
      }
      if (input.worker_id) await assertWorker(pool, t.organizationId, input.worker_id)
      if (input.site_id) {
        const site = await pool.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [
          input.site_id,
          t.organizationId,
        ])
        if (!site.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")
      }

      const q = await pool.query(
        `INSERT INTO work_schedules(organization_id, site_id, worker_id, day_of_week, specific_date,
           start_minute, end_minute, break_duration_minutes, late_tolerance_minutes, valid_from, valid_to, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, CURRENT_DATE),$11,$12)
         RETURNING id, site_id, worker_id, day_of_week, specific_date, start_minute, end_minute,
                   break_duration_minutes, late_tolerance_minutes, valid_from, valid_to`,
        [
          t.organizationId,
          input.site_id ?? null,
          input.worker_id ?? null,
          input.day_of_week ?? null,
          input.specific_date ?? null,
          input.start_minute,
          input.end_minute,
          input.break_duration_minutes,
          input.late_tolerance_minutes,
          input.valid_from ?? null,
          input.valid_to ?? null,
          t.userId,
        ],
      )
      await pool.query(
        "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'schedule.created','work_schedule',$3)",
        [t.organizationId, t.userId, q.rows[0].id],
      )
      res.status(201).json(q.rows[0])
    }),
  )

  r.delete(
    "/work-schedules/:id",
    requirePermission("attendance:correct"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const pool = db()
      const q = await pool.query("DELETE FROM work_schedules WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING id", [
        id,
        t.organizationId,
      ])
      if (!q.rowCount) throw new HttpError(404, "schedule_not_found", "Horaire introuvable.")
      await pool.query(
        "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'schedule.deleted','work_schedule',$3)",
        [t.organizationId, t.userId, id],
      )
      res.json({ id, deleted: true })
    }),
  )

  // -------------------------------------------------------------------------
  // L'équipe du jour
  // -------------------------------------------------------------------------

  r.get(
    "/attendance",
    requirePermission("attendance:read"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : today()
      const pool = db()

      const [workersQ, schedules] = await Promise.all([
        pool.query(
          `SELECT w.id, w.first_name, w.last_name, w.site_id, w.role, w.custom_role, w.status AS worker_status,
                  a.id AS record_id, a.check_in_at, a.check_out_at, a.break_minutes, a.status AS record_status,
                  a.absence_reason, a.comment, a.corrected_at, a.correction_reason,
                  cu.first_name AS corrected_by_first_name, cu.last_name AS corrected_by_last_name
           FROM workers w
           LEFT JOIN attendance_records a
             ON a.worker_id = w.id AND a.work_date = $2::date AND a.organization_id = w.organization_id
           LEFT JOIN users cu ON cu.id = a.corrected_by
           WHERE w.organization_id=$1::uuid AND w.status <> 'inactive'
           ORDER BY w.first_name, w.last_name`,
          [t.organizationId, date],
        ),
        loadSchedules(pool, t.organizationId),
      ])

      const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
      const lignes = workersQ.rows.map((row) => {
        const siteId = row.site_id === null ? null : String(row.site_id)
        const schedule = resolveSchedule(schedules, String(row.id), siteId, date, dow)
        const checkInMinute = minuteFrom(row.check_in_at as Date | null)
        const checkOutMinute = minuteFrom(row.check_out_at as Date | null)
        const record = row.record_id
          ? { status: row.record_status as never, checkInMinute, checkOutMinute }
          : null
        const retard = evaluateLateness(checkInMinute, schedule)
        return {
          worker_id: String(row.id),
          first_name: row.first_name,
          last_name: row.last_name,
          site_id: siteId,
          role: row.custom_role || row.role,
          worker_status: row.worker_status,
          record_id: row.record_id ? String(row.record_id) : null,
          check_in_at: isoFrom(row.check_in_at as Date | null),
          check_out_at: isoFrom(row.check_out_at as Date | null),
          break_minutes: row.break_minutes === null ? null : Number(row.break_minutes),
          absence_reason: row.absence_reason,
          comment: row.comment,
          corrected_at: isoFrom(row.corrected_at as Date | null),
          correction_reason: row.correction_reason,
          corrected_by:
            row.corrected_by_first_name === null
              ? null
              : `${row.corrected_by_first_name} ${row.corrected_by_last_name ?? ""}`.trim(),
          // L'état affiché, calculé par le cœur de règles. `not_recorded` n'est
          // pas une absence : il dit que personne n'a rien saisi.
          state: dayState(record, schedule),
          /** `null` quand aucun horaire ne s'applique : il n'y a alors pas de retard possible. */
          late_minutes: retard.unknown ? null : retard.lateMinutes,
          scheduled_start_minute: schedule?.startMinute ?? null,
          scheduled_end_minute: schedule?.endMinute ?? null,
          worked_minutes: workedMinutes(checkInMinute, checkOutMinute, row.break_minutes === null ? null : Number(row.break_minutes)),
        }
      })

      const compte = (etat: string) => lignes.filter((l) => l.state === etat).length
      res.json({
        date,
        workers: lignes,
        summary: {
          expected: lignes.length,
          present: compte("present") + compte("late") + compte("left"),
          late: compte("late"),
          left: compte("left"),
          absent_declared: compte("absent_declared"),
          absent_justified: compte("absent_justified"),
          absent_unjustified: compte("absent_unjustified"),
          leave: compte("leave"),
          // Comptés à part, et jamais rangés parmi les absents : un trou dans
          // la saisie n'est pas une information sur la personne.
          not_recorded: compte("not_recorded"),
          incomplete: compte("incomplete"),
          /** Vrai quand aucun horaire n'est configuré : l'écran doit alors taire la notion de retard. */
          no_schedule: lignes.every((l) => l.scheduled_start_minute === null),
        },
      })
    }),
  )

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  r.post(
    "/attendance/check-in",
    requirePermission("attendance:manage"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(attendanceValidators.checkIn, req.body)
      const pool = db()
      const worker = await assertWorker(pool, t.organizationId, input.worker_id)
      if (worker.status !== "active") {
        throw new HttpError(409, "worker_inactive", "Ce laveur n'est pas en service. Réactivez sa fiche pour le pointer.")
      }
      const workDate = input.work_date ?? today()
      const at = input.at ?? new Date().toISOString()

      const existing = await pool.query(
        "SELECT id, check_in_at, status FROM attendance_records WHERE worker_id=$1::uuid AND work_date=$2::date",
        [input.worker_id, workDate],
      )
      if (existing.rowCount) {
        const row = existing.rows[0]
        if (row.check_in_at) {
          throw new HttpError(409, "already_checked_in", "Ce laveur est déjà pointé pour cette journée.")
        }
        // Un relevé existe sans arrivée : c'était une absence déclarée. La
        // personne est finalement venue. On n'écrase pas en silence — la
        // requalification passe par une correction, qui laisse une trace.
        throw new HttpError(
          409,
          "absence_recorded",
          "Une absence est déjà enregistrée pour ce laveur aujourd'hui. Corrigez-la pour enregistrer son arrivée.",
        )
      }

      const q = await pool.query(
        `INSERT INTO attendance_records(organization_id, site_id, worker_id, work_date, check_in_at, status, recorded_by)
         VALUES($1,$2,$3,$4::date,$5::timestamptz,'present',$6)
         RETURNING id, worker_id, work_date, check_in_at, check_out_at, status`,
        [t.organizationId, worker.site_id, input.worker_id, workDate, at, t.userId],
      )
      res.status(201).json(q.rows[0])
    }),
  )

  r.post(
    "/attendance/check-out",
    requirePermission("attendance:manage"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(attendanceValidators.checkOut, req.body)
      const pool = db()
      await assertWorker(pool, t.organizationId, input.worker_id)
      const workDate = input.work_date ?? today()
      const at = input.at ?? new Date().toISOString()

      const existing = await pool.query(
        `SELECT id, check_in_at, check_out_at FROM attendance_records
         WHERE worker_id=$1::uuid AND work_date=$2::date AND organization_id=$3::uuid`,
        [input.worker_id, workDate, t.organizationId],
      )
      if (!existing.rowCount) {
        throw new HttpError(409, "not_checked_in", "Ce laveur n'a pas pointé son arrivée : il n'y a pas de départ à enregistrer.")
      }
      const row = existing.rows[0]
      if (row.check_out_at) throw new HttpError(409, "already_checked_out", "Le départ est déjà enregistré.")
      if (!row.check_in_at) {
        throw new HttpError(409, "not_checked_in", "Ce laveur n'a pas pointé son arrivée : il n'y a pas de départ à enregistrer.")
      }
      if (!isCoherent(minuteFrom(row.check_in_at as Date), minuteFrom(at))) {
        throw new HttpError(400, "incoherent_times", "L'heure de départ précède l'heure d'arrivée.")
      }

      const q = await pool.query(
        `UPDATE attendance_records SET check_out_at=$2::timestamptz,
           break_minutes = COALESCE($3, break_minutes), updated_at=now()
         WHERE id=$1::uuid
         RETURNING id, worker_id, work_date, check_in_at, check_out_at, break_minutes, status`,
        [row.id, at, input.break_minutes ?? null],
      )
      res.json(q.rows[0])
    }),
  )

  r.post(
    "/attendance/absence",
    requirePermission("attendance:manage"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(attendanceValidators.absence, req.body)
      const pool = db()
      const worker = await assertWorker(pool, t.organizationId, input.worker_id)
      const workDate = input.work_date ?? today()

      const existing = await pool.query(
        "SELECT id FROM attendance_records WHERE worker_id=$1::uuid AND work_date=$2::date",
        [input.worker_id, workDate],
      )
      if (existing.rowCount) {
        throw new HttpError(409, "attendance_already_recorded", "Un relevé existe déjà pour ce laveur ce jour-là. Corrigez-le plutôt.")
      }

      const q = await pool.query(
        `INSERT INTO attendance_records(organization_id, site_id, worker_id, work_date, status, absence_reason, recorded_by)
         VALUES($1,$2,$3,$4::date,$5,$6,$7)
         RETURNING id, worker_id, work_date, status, absence_reason`,
        [t.organizationId, worker.site_id, input.worker_id, workDate, input.status, input.reason || null, t.userId],
      )
      await pool.query(
        "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES($1,$2,'attendance.absence','attendance_record',$3,$4)",
        [t.organizationId, t.userId, q.rows[0].id, JSON.stringify({ status: input.status, work_date: workDate })],
      )
      res.status(201).json(q.rows[0])
    }),
  )

  r.patch(
    "/attendance/:id",
    requirePermission("attendance:correct"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(attendanceValidators.correction, req.body)
      const pool = db()

      const existing = await pool.query(
        "SELECT * FROM attendance_records WHERE id=$1::uuid AND organization_id=$2::uuid",
        [id, t.organizationId],
      )
      if (!existing.rowCount) throw new HttpError(404, "attendance_not_found", "Relevé de présence introuvable.")
      const avant = existing.rows[0]

      const nouveauIn = input.check_in_at === undefined ? avant.check_in_at : input.check_in_at
      const nouveauOut = input.check_out_at === undefined ? avant.check_out_at : input.check_out_at
      if (!isCoherent(minuteFrom(nouveauIn as Date | string | null), minuteFrom(nouveauOut as Date | string | null))) {
        throw new HttpError(400, "incoherent_times", "L'heure de départ précède l'heure d'arrivée.")
      }

      const q = await pool.query(
        `UPDATE attendance_records SET
           status = COALESCE($3, status),
           check_in_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE check_in_at END,
           check_out_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE check_out_at END,
           break_minutes = CASE WHEN $8::boolean THEN $9::smallint ELSE break_minutes END,
           absence_reason = CASE WHEN $10::boolean THEN $11 ELSE absence_reason END,
           corrected_by=$12, corrected_at=now(), correction_reason=$13, updated_at=now()
         WHERE id=$1::uuid AND organization_id=$2::uuid
         RETURNING id, worker_id, work_date, check_in_at, check_out_at, break_minutes, status,
                   absence_reason, corrected_at, correction_reason`,
        [
          id,
          t.organizationId,
          input.status ?? null,
          input.check_in_at !== undefined,
          input.check_in_at ?? null,
          input.check_out_at !== undefined,
          input.check_out_at ?? null,
          input.break_minutes !== undefined,
          input.break_minutes ?? null,
          input.absence_reason !== undefined,
          input.absence_reason ?? null,
          t.userId,
          input.reason,
        ],
      )

      // Une correction de présence est une opération sensible : elle réécrit
      // ce qui pourra servir à juger quelqu'un. L'ancienne valeur part au
      // journal avec la nouvelle, sans quoi la trace ne prouverait rien.
      await pool.query(
        `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES($1,$2,'attendance.corrected','attendance_record',$3,$4)`,
        [
          t.organizationId,
          t.userId,
          id,
          JSON.stringify({
            reason: input.reason,
            avant: {
              status: avant.status,
              check_in_at: isoFrom(avant.check_in_at as Date | null),
              check_out_at: isoFrom(avant.check_out_at as Date | null),
              break_minutes: avant.break_minutes,
            },
            apres: {
              status: q.rows[0].status,
              check_in_at: isoFrom(q.rows[0].check_in_at as Date | null),
              check_out_at: isoFrom(q.rows[0].check_out_at as Date | null),
              break_minutes: q.rows[0].break_minutes,
            },
          }),
        ],
      )
      res.json(q.rows[0])
    }),
  )

  r.get(
    "/attendance/history",
    requirePermission("attendance:read"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : today()
      const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today()
      const workerId = typeof req.query.worker_id === "string" ? parseId(req.query.worker_id) : null

      const q = await db().query(
        `SELECT a.id, a.worker_id, a.work_date, a.check_in_at, a.check_out_at, a.break_minutes,
                a.status, a.absence_reason, a.comment, a.corrected_at, a.correction_reason,
                w.first_name, w.last_name
         FROM attendance_records a
         JOIN workers w ON w.id = a.worker_id AND w.organization_id = a.organization_id
         WHERE a.organization_id=$1::uuid AND a.work_date BETWEEN $2::date AND $3::date
           AND ($4::uuid IS NULL OR a.worker_id = $4::uuid)
         ORDER BY a.work_date DESC, w.first_name LIMIT 500`,
        [t.organizationId, from, to, workerId],
      )
      res.json(q.rows.map((row) => ({ ...row, work_date: dateKey(row.work_date as Date) })))
    }),
  )

  // -------------------------------------------------------------------------
  // Rendement
  // -------------------------------------------------------------------------

  r.get(
    "/team-performance",
    requirePermission("attendance:read"),
    requireCapability("team.tracking"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today()
      const from =
        typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
          ? req.query.from
          : new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10)
      const pool = db()

      const [workersQ, assignQ, attendanceQ, stationQ, serieQ, schedules] = await Promise.all([
        pool.query(
          `SELECT id, first_name, last_name, site_id, role, custom_role, status
           FROM workers WHERE organization_id=$1::uuid ORDER BY first_name, last_name`,
          [t.organizationId],
        ),
        // Les lavages annulés sont exclus : une prestation annulée n'a pas
        // été rendue, et la compter récompenserait un travail défait.
        pool.query(
          `SELECT a.worker_id, a.wash_id, a.assignment_role,
                  (SELECT count(*) FROM wash_assignments x WHERE x.wash_id = a.wash_id)::int AS participant_count
           FROM wash_assignments a
           JOIN washes w ON w.id = a.wash_id
           WHERE w.organization_id=$1::uuid AND w.status='completed'
             AND w.created_at >= $2::date AND w.created_at < ($3::date + 1)`,
          [t.organizationId, from, to],
        ),
        pool.query(
          `SELECT worker_id, work_date, status, check_in_at, check_out_at, break_minutes
           FROM attendance_records
           WHERE organization_id=$1::uuid AND work_date BETWEEN $2::date AND $3::date`,
          [t.organizationId, from, to],
        ),
        // Le total de la station se lit sur les lavages, JAMAIS en sommant
        // les quote-parts individuelles. C'est la seule façon de garantir
        // qu'aucun arrondi ni aucune double affectation ne le gonfle.
        pool.query(
          `SELECT count(*)::int AS completed,
                  count(*) FILTER (WHERE NOT EXISTS (
                    SELECT 1 FROM wash_assignments a WHERE a.wash_id = w.id))::int AS unassigned
           FROM washes w
           WHERE w.organization_id=$1::uuid AND w.status='completed'
             AND w.created_at >= $2::date AND w.created_at < ($3::date + 1)`,
          [t.organizationId, from, to],
        ),
        pool.query(
          `SELECT to_char(w.created_at,'YYYY-MM-DD') AS jour, count(*)::int AS washes
           FROM washes w
           WHERE w.organization_id=$1::uuid AND w.status='completed'
             AND w.created_at >= $2::date AND w.created_at < ($3::date + 1)
           GROUP BY 1 ORDER BY 1`,
          [t.organizationId, from, to],
        ),
        loadSchedules(pool, t.organizationId),
      ])

      const parWorker = new Map<
        string,
        { participations: Set<string>; principal: number; shareMilli: number }
      >()
      for (const row of assignQ.rows) {
        const key = String(row.worker_id)
        const courant = parWorker.get(key) ?? { participations: new Set<string>(), principal: 0, shareMilli: 0 }
        const washId = String(row.wash_id)
        if (!courant.participations.has(washId)) {
          courant.participations.add(washId)
          if (row.assignment_role === "principal") courant.principal += 1
          courant.shareMilli += shareMilli(Number(row.participant_count))
        }
        parWorker.set(key, courant)
      }

      const presences = new Map<
        string,
        { presentDays: number; lateDays: number; absences: number; leaves: number; workedMinutes: number; incomplete: number }
      >()
      for (const row of attendanceQ.rows) {
        const key = String(row.worker_id)
        const courant =
          presences.get(key) ?? { presentDays: 0, lateDays: 0, absences: 0, leaves: 0, workedMinutes: 0, incomplete: 0 }
        const statut = String(row.status)
        if (statut === "present") {
          courant.presentDays += 1
          const jour = dateKey(row.work_date as Date)
          const dow = new Date(`${jour}T00:00:00Z`).getUTCDay()
          const worker = workersQ.rows.find((w) => String(w.id) === key)
          const schedule = resolveSchedule(
            schedules,
            key,
            worker?.site_id ? String(worker.site_id) : null,
            jour,
            dow,
          )
          if (evaluateLateness(minuteFrom(row.check_in_at as Date | null), schedule).late) courant.lateDays += 1
          const minutes = workedMinutes(
            minuteFrom(row.check_in_at as Date | null),
            minuteFrom(row.check_out_at as Date | null),
            row.break_minutes === null ? null : Number(row.break_minutes),
          )
          if (minutes === null) courant.incomplete += 1
          else courant.workedMinutes += minutes
        } else if (statut === "leave") courant.leaves += 1
        else courant.absences += 1
        presences.set(key, courant)
      }

      const lignes = workersQ.rows.map((row) => {
        const key = String(row.id)
        const travail = parWorker.get(key)
        const presence = presences.get(key)
        const partMilli = travail?.shareMilli ?? 0
        // Un rendement horaire ne se calcule que si des heures ont été
        // pointées ET qu'aucun pointage de la période n'est resté incomplet :
        // un total amputé d'une journée gonflerait mécaniquement le ratio.
        const minutesFiables = presence && presence.incomplete === 0 && presence.workedMinutes > 0 ? presence.workedMinutes : null
        return {
          worker_id: key,
          first_name: row.first_name,
          last_name: row.last_name,
          role: row.custom_role || row.role,
          status: row.status,
          participations: travail?.participations.size ?? 0,
          as_principal: travail?.principal ?? 0,
          /** Quote-part du travail de la station, en millièmes de lavage. */
          share_milli: partMilli,
          present_days: presence?.presentDays ?? 0,
          late_days: presence?.lateDays ?? 0,
          absences: presence?.absences ?? 0,
          leaves: presence?.leaves ?? 0,
          worked_minutes: presence?.workedMinutes ?? 0,
          incomplete_records: presence?.incomplete ?? 0,
          per_present_day_milli: perPresentDay(partMilli, presence?.presentDays ?? 0),
          per_worked_hour_milli: perWorkedHour(partMilli, minutesFiables),
        }
      })

      res.json({
        from,
        to,
        station: {
          completed_washes: Number(stationQ.rows[0].completed),
          unassigned_washes: Number(stationQ.rows[0].unassigned),
          /** Vrai si personne n'a jamais pointé : les colonnes de temps sont alors sans objet. */
          no_attendance: attendanceQ.rowCount === 0,
          /** Vrai si aucun horaire n'est configuré : la notion de retard ne s'applique pas. */
          no_schedule: schedules.length === 0,
        },
        workers: lignes,
        daily: serieQ.rows.map((row) => ({ day: String(row.jour), washes: Number(row.washes) })),
      })
    }),
  )

  return r
}
