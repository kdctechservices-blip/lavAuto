import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Équipes : présences, attribution du travail, rendement (module Équipes)
//
// Ces tests portent surtout sur ce que le module **refuse** de dire :
//
//   • il ne déduit pas une absence d'un silence ;
//   • il ne déclare personne en retard sans horaire de référence ;
//   • il ne transforme pas un pointage incomplet en zéro heure ;
//   • il ne compte pas un lavage à trois comme trois lavages.
//
// Chacun de ces refus est un chiffre que le responsable ne lira pas à tort.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let vehicleCategoryId: string
let cashSessionId: string
let serviceId: string

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()

async function api(path: string, options: { as?: string; method?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.as) {
    const cookie = sessions.get(options.as)
    if (cookie) headers.Cookie = cookie
  }
  if (options.key) headers["Idempotency-Key"] = options.key
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  assert.equal(response.status, 200, `connexion ${email}`)
  const cookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
  sessions.set(email, cookie)
}

async function setPlan(code: string) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId, code],
  )
  invalidateSubscriptionCache(orgId)
}

/** Crée un laveur directement en base : les quotas de forfait ne sont pas le sujet ici. */
async function creerLaveur(prenom: string): Promise<string> {
  const q = await pool.query(
    `INSERT INTO workers(organization_id, site_id, first_name, last_name, role, status)
     VALUES($1::uuid,$2::uuid,$3,'Test','car_washer','active') RETURNING id`,
    [orgId, siteId, prenom],
  )
  return String(q.rows[0].id)
}

async function supprimerLaveur(id: string) {
  await pool.query("DELETE FROM attendance_records WHERE worker_id=$1::uuid", [id])
  await pool.query("DELETE FROM wash_assignments WHERE worker_id=$1::uuid", [id])
  await pool.query("DELETE FROM work_schedules WHERE worker_id=$1::uuid", [id])
  await pool.query("DELETE FROM workers WHERE id=$1::uuid", [id])
}

const JOUR = "2026-06-10" // un mercredi
function instant(heure: string): string {
  return `${JOUR}T${heure}:00.000Z`
}

async function poserHoraire(corps: Record<string, unknown>) {
  const response = await api("/api/v1/work-schedules", { as: "demo@washpilot.ci", method: "POST", body: corps })
  assert.equal(response.status, 201, "création de l'horaire")
  return String((await response.json()).id)
}

async function retirerHoraire(id: string) {
  await api(`/api/v1/work-schedules/${id}`, { as: "demo@washpilot.ci", method: "DELETE" })
}

interface LigneJour {
  worker_id: string
  state: string
  late_minutes: number | null
  worked_minutes: number | null
  scheduled_start_minute: number | null
}

async function journee(date = JOUR): Promise<{ workers: LigneJour[]; summary: Record<string, number | boolean> }> {
  const response = await api(`/api/v1/attendance?date=${date}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  return (await response.json()) as { workers: LigneJour[]; summary: Record<string, number | boolean> }
}

async function ligneDe(workerId: string, date = JOUR): Promise<LigneJour> {
  const j = await journee(date)
  const ligne = j.workers.find((w) => w.worker_id === workerId)
  assert.ok(ligne, "le laveur figure dans l'équipe du jour")
  return ligne
}

async function enregistrerLavage(workerIds: string[], principal?: string) {
  const response = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: vehicleCategoryId,
      cash_session_id: cashSessionId,
      items: [{ service_id: serviceId, quantity: 1 }],
      worker_ids: workerIds,
      ...(principal ? { principal_worker_id: principal } : {}),
      payment_method: "cash",
      amount_received_cents: 200_000,
    },
  })
  return response
}

interface Rendement {
  station: { completed_washes: number; unassigned_washes: number; no_attendance: boolean; no_schedule: boolean }
  workers: {
    worker_id: string
    participations: number
    as_principal: number
    share_milli: number
    present_days: number
    late_days: number
    absences: number
    worked_minutes: number
    incomplete_records: number
    per_present_day_milli: number | null
    per_worked_hour_milli: number | null
  }[]
  daily: { day: string; washes: number }[]
}

async function rendement(from = "2026-01-01", to = "2026-12-31"): Promise<Rendement> {
  const response = await api(`/api/v1/team-performance?from=${from}&to=${to}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  return (await response.json()) as Rendement
}

before(async () => {
  const ready = await initDatabaseSchema()
  assert.ok(ready, "base de test initialisée")
  pool = getPool() as Pool

  const app = createApiApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`

  for (const email of ["demo@washpilot.ci", "gerant@washpilot.ci", "caisse@washpilot.ci", "laveur@washpilot.ci"]) {
    await login(email)
  }

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  siteId = (await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid LIMIT 1", [orgId])).rows[0].id
  vehicleCategoryId = (
    await pool.query("SELECT id FROM vehicle_categories WHERE organization_id=$1::uuid LIMIT 1", [orgId])
  ).rows[0].id

  await setPlan("pro")
  const svc = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      name: `Lavage équipe ${randomUUID().slice(0, 6)}`,
      duration_minutes: 30,
      vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 200_000 }],
    },
  })
  serviceId = String((await svc.json()).id)

  await api("/api/v1/cash-sessions/open", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: { site_id: siteId, opening_amount_cents: 0 },
  })
  cashSessionId = String((await (await api("/api/v1/cash-sessions/current", { as: "demo@washpilot.ci" })).json()).id)
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// Ne pas déduire une absence d'un silence
// ---------------------------------------------------------------------------

test("un laveur sans relevé n'est pas absent : il n'est pas pointé", async () => {
  const id = await creerLaveur(`Konan${randomUUID().slice(0, 4)}`)
  try {
    const ligne = await ligneDe(id)
    assert.equal(ligne.state, "not_recorded")
    const j = await journee()
    assert.ok((j.summary.not_recorded as number) >= 1)
    assert.equal(j.summary.absent_declared, 0, "aucune absence ne doit être inventée")
  } finally {
    await supprimerLaveur(id)
  }
})

test("une absence déclarée ne devient jamais non justifiée toute seule", async () => {
  const id = await creerLaveur(`Yao${randomUUID().slice(0, 4)}`)
  try {
    const response = await api("/api/v1/attendance/absence", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { worker_id: id, work_date: JOUR, status: "absent_declared", reason: "A prévenu par téléphone" },
    })
    assert.equal(response.status, 201)
    assert.equal((await ligneDe(id)).state, "absent_declared")

    // Seule une correction explicite, motivée et tracée peut requalifier.
    const recordId = String((await pool.query(
      "SELECT id FROM attendance_records WHERE worker_id=$1::uuid AND work_date=$2::date", [id, JOUR])).rows[0].id)
    const correction = await api(`/api/v1/attendance/${recordId}`, {
      as: "demo@washpilot.ci",
      method: "PATCH",
      body: { status: "absent_unjustified", reason: "N'a donné aucune nouvelle de la journée" },
    })
    assert.equal(correction.status, 200)
    assert.equal((await ligneDe(id)).state, "absent_unjustified")
  } finally {
    await supprimerLaveur(id)
  }
})

test("le module refuse de déclarer directement une absence non justifiée", async () => {
  const id = await creerLaveur(`Bamba${randomUUID().slice(0, 4)}`)
  try {
    const response = await api("/api/v1/attendance/absence", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { worker_id: id, work_date: JOUR, status: "absent_unjustified" },
    })
    assert.equal(response.status, 400, "qualifier une absence est une décision, pas une saisie")
  } finally {
    await supprimerLaveur(id)
  }
})

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

test("arrivée puis départ : les heures travaillées se calculent", async () => {
  const id = await creerLaveur(`Traore${randomUUID().slice(0, 4)}`)
  try {
    const arrivee = await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:00") },
    })
    assert.equal(arrivee.status, 201)
    assert.equal((await ligneDe(id)).state, "present")

    const depart = await api("/api/v1/attendance/check-out", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("17:00") },
    })
    assert.equal(depart.status, 200)

    const ligne = await ligneDe(id)
    assert.equal(ligne.state, "left")
    assert.equal(ligne.worked_minutes, 600)
  } finally {
    await supprimerLaveur(id)
  }
})

test("une pause relevée se retranche, une pause seulement prévue ne se retranche pas", async () => {
  const id = await creerLaveur(`Kone${randomUUID().slice(0, 4)}`)
  // L'horaire prévoit une heure de pause ; elle ne doit rien retirer tant
  // qu'elle n'a pas été relevée.
  const horaire = await poserHoraire({
    worker_id: id,
    start_minute: 420,
    end_minute: 1080,
    break_duration_minutes: 60,
    valid_from: "2026-01-01",
  })
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:00") },
    })
    await api("/api/v1/attendance/check-out", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("17:00") },
    })
    assert.equal((await ligneDe(id)).worked_minutes, 600, "la pause prévue ne se déduit pas d'office")

    const recordId = String((await pool.query(
      "SELECT id FROM attendance_records WHERE worker_id=$1::uuid AND work_date=$2::date", [id, JOUR])).rows[0].id)
    await api(`/api/v1/attendance/${recordId}`, {
      as: "demo@washpilot.ci", method: "PATCH",
      body: { break_minutes: 45, reason: "Pause relevée après coup" },
    })
    assert.equal((await ligneDe(id)).worked_minutes, 555, "la pause relevée, elle, se retranche")
  } finally {
    await retirerHoraire(horaire)
    await supprimerLaveur(id)
  }
})

test("un pointage sans départ ne vaut pas zéro heure : il vaut inconnu", async () => {
  const id = await creerLaveur(`Diaby${randomUUID().slice(0, 4)}`)
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("08:00") },
    })
    const ligne = await ligneDe(id)
    assert.equal(ligne.worked_minutes, null, "un zéro se moyennerait et se reprocherait")
  } finally {
    await supprimerLaveur(id)
  }
})

test("les pointages incohérents et répétés sont refusés", async () => {
  const id = await creerLaveur(`Sanogo${randomUUID().slice(0, 4)}`)
  try {
    const sansArrivee = await api("/api/v1/attendance/check-out", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("17:00") },
    })
    assert.equal(sansArrivee.status, 409)
    assert.equal((await sansArrivee.json()).error.code, "not_checked_in")

    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("09:00") },
    })
    const deuxFois = await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("09:30") },
    })
    assert.equal(deuxFois.status, 409)
    assert.equal((await deuxFois.json()).error.code, "already_checked_in")

    const avantArrivee = await api("/api/v1/attendance/check-out", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("08:00") },
    })
    assert.equal(avantArrivee.status, 400)
    assert.equal((await avantArrivee.json()).error.code, "incoherent_times")
  } finally {
    await supprimerLaveur(id)
  }
})

// ---------------------------------------------------------------------------
// Le retard, et son absence
// ---------------------------------------------------------------------------

test("sans horaire configuré, un pointage tardif n'est pas un retard", async () => {
  const id = await creerLaveur(`Ouattara${randomUUID().slice(0, 4)}`)
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("11:30") },
    })
    const ligne = await ligneDe(id)
    assert.equal(ligne.state, "present", "aucune station n'a d'heure d'ouverture universelle")
    assert.equal(ligne.late_minutes, null)
    assert.equal(ligne.scheduled_start_minute, null)
  } finally {
    await supprimerLaveur(id)
  }
})

test("avec un horaire, le retard est détecté et chiffré depuis l'heure prévue", async () => {
  const id = await creerLaveur(`Fofana${randomUUID().slice(0, 4)}`)
  const horaire = await poserHoraire({
    worker_id: id, start_minute: 420, end_minute: 1080, late_tolerance_minutes: 15, valid_from: "2026-01-01",
  })
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:40") },
    })
    const ligne = await ligneDe(id)
    assert.equal(ligne.state, "late")
    assert.equal(ligne.late_minutes, 40, "40 minutes après 7 h, et non 25 après la tolérance")
  } finally {
    await retirerHoraire(horaire)
    await supprimerLaveur(id)
  }
})

test("arriver dans la tolérance n'est pas un retard", async () => {
  const id = await creerLaveur(`Cisse${randomUUID().slice(0, 4)}`)
  const horaire = await poserHoraire({
    worker_id: id, start_minute: 420, end_minute: 1080, late_tolerance_minutes: 15, valid_from: "2026-01-01",
  })
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:12") },
    })
    assert.equal((await ligneDe(id)).state, "present")
  } finally {
    await retirerHoraire(horaire)
    await supprimerLaveur(id)
  }
})

// ---------------------------------------------------------------------------
// Compter le travail sans le gonfler
// ---------------------------------------------------------------------------

test("un lavage fait à trois reste un lavage pour la station", async () => {
  const a = await creerLaveur(`Eq1${randomUUID().slice(0, 4)}`)
  const b = await creerLaveur(`Eq2${randomUUID().slice(0, 4)}`)
  const c = await creerLaveur(`Eq3${randomUUID().slice(0, 4)}`)
  try {
    const avant = (await rendement()).station.completed_washes
    const response = await enregistrerLavage([a, b, c], a)
    assert.equal(response.status, 201)

    const apres = await rendement()
    assert.equal(apres.station.completed_washes, avant + 1, "un lavage, pas trois")

    const ligneA = apres.workers.find((w) => w.worker_id === a)
    const ligneB = apres.workers.find((w) => w.worker_id === b)
    assert.ok(ligneA && ligneB)
    assert.equal(ligneA.participations, 1, "chacun a participé à un lavage")
    assert.equal(ligneB.participations, 1)
    assert.equal(ligneA.as_principal, 1, "un seul en était responsable")
    assert.equal(ligneB.as_principal, 0)
    assert.equal(ligneA.share_milli, 333, "la quote-part est le tiers")
    assert.equal(ligneB.share_milli, 333)

    const sommeParts = [a, b, c]
      .map((id) => apres.workers.find((w) => w.worker_id === id)?.share_milli ?? 0)
      .reduce((s, v) => s + v, 0)
    assert.ok(sommeParts <= 1000, `la somme des parts (${sommeParts}) ne gonfle jamais le lavage unique`)
  } finally {
    for (const id of [a, b, c]) await supprimerLaveur(id)
  }
})

test("un lavage seul vaut une quote-part entière", async () => {
  const id = await creerLaveur(`Solo${randomUUID().slice(0, 4)}`)
  try {
    await enregistrerLavage([id], id)
    const ligne = (await rendement()).workers.find((w) => w.worker_id === id)
    assert.equal(ligne?.share_milli, 1000)
    assert.equal(ligne?.participations, 1)
  } finally {
    await supprimerLaveur(id)
  }
})

test("un lavage annulé sort des services effectués", async () => {
  const id = await creerLaveur(`Annul${randomUUID().slice(0, 4)}`)
  try {
    const response = await enregistrerLavage([id], id)
    const wash = (await response.json()) as { id: string }

    const avant = (await rendement()).workers.find((w) => w.worker_id === id)
    assert.equal(avant?.participations, 1)

    const annulation = await api(`/api/v1/washes/${wash.id}/cancel`, {
      as: "demo@washpilot.ci", method: "POST", body: { reason: "Client parti sans payer" },
    })
    assert.equal(annulation.status, 200)

    const apres = (await rendement()).workers.find((w) => w.worker_id === id)
    assert.equal(apres?.participations, 0, "un travail défait ne se comptabilise pas")
    assert.equal(apres?.share_milli, 0)
  } finally {
    await supprimerLaveur(id)
  }
})

test("le responsable principal doit faire partie de l'équipe du lavage", async () => {
  const a = await creerLaveur(`Dedans${randomUUID().slice(0, 4)}`)
  const b = await creerLaveur(`Dehors${randomUUID().slice(0, 4)}`)
  try {
    const response = await enregistrerLavage([a], b)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, "invalid_principal")
  } finally {
    for (const id of [a, b]) await supprimerLaveur(id)
  }
})

test("la base refuse deux responsables principaux sur un même lavage", async () => {
  const a = await creerLaveur(`Chef1${randomUUID().slice(0, 4)}`)
  const b = await creerLaveur(`Chef2${randomUUID().slice(0, 4)}`)
  try {
    const response = await enregistrerLavage([a, b], a)
    const wash = (await response.json()) as { id: string }
    await assert.rejects(
      pool.query("UPDATE wash_assignments SET assignment_role='principal' WHERE wash_id=$1::uuid AND worker_id=$2::uuid", [
        wash.id, b,
      ]),
      "l'index unique doit interdire le second responsable",
    )
  } finally {
    for (const id of [a, b]) await supprimerLaveur(id)
  }
})

test("les lavages sans aucun laveur affecté sont signalés, pas dissimulés", async () => {
  const avant = (await rendement()).station.unassigned_washes
  const response = await enregistrerLavage([])
  assert.equal(response.status, 201)
  const apres = (await rendement()).station.unassigned_washes
  assert.equal(apres, avant + 1, "le responsable doit pouvoir repérer le travail non attribué")
})

// ---------------------------------------------------------------------------
// Rendement : ne rien calculer sur du vide
// ---------------------------------------------------------------------------

test("aucun rendement horaire n'est affiché sans pointage", async () => {
  const id = await creerLaveur(`Sanspointage${randomUUID().slice(0, 4)}`)
  try {
    await enregistrerLavage([id], id)
    const ligne = (await rendement()).workers.find((w) => w.worker_id === id)
    assert.equal(ligne?.per_worked_hour_milli, null, "sans heures pointées, pas de rendement horaire")
    assert.equal(ligne?.per_present_day_milli, null, "sans jour de présence, pas de moyenne journalière")
    assert.equal(ligne?.participations, 1, "le travail fait, lui, est bien compté")
  } finally {
    await supprimerLaveur(id)
  }
})

test("un pointage incomplet dans la période suspend le rendement horaire", async () => {
  // Un total d'heures amputé d'une journée gonflerait mécaniquement le ratio :
  // on préfère ne rien afficher plutôt qu'un chiffre flatteur et faux.
  const id = await creerLaveur(`Incomplet${randomUUID().slice(0, 4)}`)
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:00") },
    })
    await enregistrerLavage([id], id)
    const ligne = (await rendement()).workers.find((w) => w.worker_id === id)
    assert.equal(ligne?.incomplete_records, 1)
    assert.equal(ligne?.per_worked_hour_milli, null)
    assert.equal(ligne?.present_days, 1, "la journée de présence, elle, est bien comptée")
  } finally {
    await supprimerLaveur(id)
  }
})

test("le rendement se calcule quand les données sont complètes", async () => {
  const id = await creerLaveur(`Complet${randomUUID().slice(0, 4)}`)
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:00") },
    })
    await api("/api/v1/attendance/check-out", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("15:00") },
    })
    await enregistrerLavage([id], id)
    await enregistrerLavage([id], id)

    const ligne = (await rendement()).workers.find((w) => w.worker_id === id)
    assert.equal(ligne?.worked_minutes, 480)
    assert.equal(ligne?.share_milli, 2000, "deux lavages entiers")
    assert.equal(ligne?.per_present_day_milli, 2000, "deux lavages sur une journée")
    assert.equal(ligne?.per_worked_hour_milli, 250, "deux lavages en huit heures : un quart par heure")
  } finally {
    await supprimerLaveur(id)
  }
})

// ---------------------------------------------------------------------------
// Droits, forfait, cloisonnement, traçabilité
// ---------------------------------------------------------------------------

test("le gérant pointe mais ne corrige pas", async () => {
  const id = await creerLaveur(`Gere${randomUUID().slice(0, 4)}`)
  try {
    const pointage = await api("/api/v1/attendance/check-in", {
      as: "gerant@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:00") },
    })
    assert.equal(pointage.status, 201, "c'est lui qui est sur place quand les gens arrivent")

    const recordId = String((await pool.query(
      "SELECT id FROM attendance_records WHERE worker_id=$1::uuid AND work_date=$2::date", [id, JOUR])).rows[0].id)
    const correction = await api(`/api/v1/attendance/${recordId}`, {
      as: "gerant@washpilot.ci", method: "PATCH",
      body: { check_in_at: instant("06:30"), reason: "Il était là plus tôt" },
    })
    assert.equal(correction.status, 403, "réécrire une heure d'arrivée reste au propriétaire")
  } finally {
    await supprimerLaveur(id)
  }
})

test("le caissier et l'agent de lavage n'ont pas accès aux présences", async () => {
  for (const qui of ["caisse@washpilot.ci", "laveur@washpilot.ci"]) {
    const response = await api("/api/v1/attendance", { as: qui })
    assert.equal(response.status, 403, `${qui} doit être refusé par défaut`)
  }
})

test("sur Starter, le suivi des équipes est fermé", async () => {
  await setPlan("starter")
  try {
    for (const chemin of ["/api/v1/attendance", "/api/v1/team-performance", "/api/v1/work-schedules"]) {
      const response = await api(chemin, { as: "demo@washpilot.ci" })
      assert.equal(response.status, 402, `${chemin} doit demander une montée en forfait`)
      assert.equal((await response.json()).error.code, "plan_upgrade_required")
    }
  } finally {
    await setPlan("pro")
  }
})

test("le rôle prime sur le forfait : le caissier reste en 403", async () => {
  await setPlan("starter")
  try {
    const response = await api("/api/v1/attendance", { as: "caisse@washpilot.ci" })
    assert.equal(response.status, 403, "on ne vend pas un forfait à qui n'aura pas le droit ensuite")
  } finally {
    await setPlan("pro")
  }
})

test("un laveur d'une autre station est introuvable", async () => {
  const autreOrg = (
    await pool.query("INSERT INTO organizations(name, slug) VALUES('Voisin équipes',$1) RETURNING id", [
      `voisin-eq-${randomUUID().slice(0, 8)}`,
    ])
  ).rows[0].id
  const autreLaveur = (
    await pool.query(
      "INSERT INTO workers(organization_id, first_name, last_name, role) VALUES($1::uuid,'Voisin','Laveur','car_washer') RETURNING id",
      [autreOrg],
    )
  ).rows[0].id

  const response = await api("/api/v1/attendance/check-in", {
    as: "demo@washpilot.ci", method: "POST",
    body: { worker_id: String(autreLaveur), work_date: JOUR, at: instant("07:00") },
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "worker_not_found")

  const ecrits = await pool.query("SELECT 1 FROM attendance_records WHERE worker_id=$1::uuid", [autreLaveur])
  assert.equal(ecrits.rowCount, 0, "aucun relevé n'a été écrit chez le voisin")
})

test("une correction laisse une trace nominative avec l'avant et l'après", async () => {
  const id = await creerLaveur(`Trace${randomUUID().slice(0, 4)}`)
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("09:00") },
    })
    const recordId = String((await pool.query(
      "SELECT id FROM attendance_records WHERE worker_id=$1::uuid AND work_date=$2::date", [id, JOUR])).rows[0].id)

    await api(`/api/v1/attendance/${recordId}`, {
      as: "demo@washpilot.ci", method: "PATCH",
      body: { check_in_at: instant("07:00"), reason: "Pointeuse en panne, arrivée constatée à 7 h" },
    })

    const journal = await pool.query(
      "SELECT actor_user_id, metadata FROM audit_logs WHERE action='attendance.corrected' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1",
      [recordId],
    )
    assert.equal(journal.rowCount, 1, "la correction est journalisée")
    assert.ok(journal.rows[0].actor_user_id, "l'auteur est nommé")
    const meta = journal.rows[0].metadata as { reason: string; avant: { check_in_at: string }; apres: { check_in_at: string } }
    assert.match(meta.reason, /Pointeuse/)
    assert.match(meta.avant.check_in_at, /T09:00/, "l'ancienne valeur est conservée")
    assert.match(meta.apres.check_in_at, /T07:00/, "sans l'avant, la trace ne prouverait rien")

    // Et la correction se voit à l'écran, elle n'est pas seulement au journal.
    const ligne = await api(`/api/v1/attendance?date=${JOUR}`, { as: "demo@washpilot.ci" })
    const w = ((await ligne.json()) as { workers: { worker_id: string; corrected_at: string | null }[] }).workers.find(
      (x) => x.worker_id === id,
    )
    assert.ok(w?.corrected_at, "un relevé corrigé doit se signaler")
  } finally {
    await supprimerLaveur(id)
  }
})

test("l'historique des présences est filtrable par laveur", async () => {
  const id = await creerLaveur(`Histo${randomUUID().slice(0, 4)}`)
  try {
    await api("/api/v1/attendance/check-in", {
      as: "demo@washpilot.ci", method: "POST",
      body: { worker_id: id, work_date: JOUR, at: instant("07:00") },
    })
    const response = await api(`/api/v1/attendance/history?from=2026-01-01&to=2026-12-31&worker_id=${id}`, {
      as: "demo@washpilot.ci",
    })
    assert.equal(response.status, 200)
    const lignes = (await response.json()) as { worker_id: string; work_date: string }[]
    assert.equal(lignes.length, 1)
    assert.equal(lignes[0].work_date, JOUR)
  } finally {
    await supprimerLaveur(id)
  }
})
