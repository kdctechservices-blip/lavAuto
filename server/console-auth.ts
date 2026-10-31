import { randomBytes, createHash } from "node:crypto"
import { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import type { Pool, PoolClient } from "pg"
import { z } from "zod"

import { getPool } from "./db.ts"
import { HttpError, hashPassword, verifyPassword } from "./auth.ts"
import { asyncRoute, body } from "./http.ts"
import { env } from "./env.ts"

// ---------------------------------------------------------------------------
// Console de l'éditeur — identité et session
//
// La console ne partage RIEN avec l'authentification des stations : ni table
// de comptes, ni table de sessions, ni cookie.
//
// Le modèle précédent posait un drapeau `platform_admin` sur un compte de
// station. Il avait trois défauts, et c'est pour eux qu'il a été abandonné :
//
//   1. Une session ouverte sur une station ouvrait aussi le parc entier. Un
//      poste laissé déverrouillé dans un box de lavage donnait accès à tous
//      les clients.
//   2. Le compte de l'éditeur apparaissait dans la liste des membres d'une
//      organisation, et comptait dans les limites du forfait de ce client.
//   3. Révoquer l'administration obligeait à toucher un compte qui servait
//      par ailleurs à exploiter un lavage.
//
// Deux cookies distincts (`washpilot_session` et `washpilot_console`)
// cohabitent donc sans se voir. Posséder l'un ne donne jamais l'autre.
// ---------------------------------------------------------------------------

export const CONSOLE_COOKIE = "washpilot_console"

// Volontairement plus court que les 30 jours d'une station : cette session
// ouvre le parc entier, elle ne doit pas survivre une semaine à un oubli.
export const CONSOLE_SESSION_TTL_DAYS = 2

export const CONSOLE_OPERATOR_ROLES = ["admin", "supervisor", "support"] as const
export type ConsoleOperatorRole = (typeof CONSOLE_OPERATOR_ROLES)[number]

export interface OperatorContext {
  operatorId: string
  email: string
  fullName: string
  role: ConsoleOperatorRole
  sessionId: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operator?: OperatorContext
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function consoleDb(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

function cookieSecurity(req: Request): { secure: boolean; sameSite: "none" | "lax" } {
  const secure = req.secure || req.get("x-forwarded-proto") === "https"
  return { secure, sameSite: secure ? "none" : "lax" }
}

export function setConsoleCookie(req: Request, res: Response, token: string): void {
  const { secure, sameSite } = cookieSecurity(req)
  res.cookie(CONSOLE_COOKIE, token, {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: CONSOLE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  })
}

export function clearConsoleCookie(req: Request, res: Response): void {
  const { secure, sameSite } = cookieSecurity(req)
  res.clearCookie(CONSOLE_COOKIE, { httpOnly: true, sameSite, secure, path: "/" })
}

/**
 * Lit le jeton de console.
 *
 * L'en-tête `Authorization` est accepté en repli, comme pour les stations :
 * l'aperçu s'affiche dans une iframe, où les cookies tiers sont parfois
 * bloqués. Le préfixe est distinct (`Console`) pour qu'un jeton de station
 * envoyé par erreur dans cet en-tête ne soit jamais lu ici.
 */
function readConsoleToken(req: Request): string | null {
  const header = req.get("cookie")
  if (header) {
    for (const part of header.split(";")) {
      const separator = part.indexOf("=")
      if (separator === -1) continue
      if (part.slice(0, separator).trim() !== CONSOLE_COOKIE) continue
      const value = part.slice(separator + 1).trim()
      if (value) return decodeURIComponent(value)
    }
  }
  const authorization = req.get("authorization") || ""
  const match = /^Console\s+(.+)$/i.exec(authorization)
  return match ? match[1].trim() : null
}

export async function createOperatorSession(pool: Pool, operatorId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await pool.query(
    `INSERT INTO platform_operator_sessions (operator_id, token_hash, expires_at)
     VALUES ($1::uuid, $2, NOW() + make_interval(days => $3))`,
    [operatorId, hashToken(token), CONSOLE_SESSION_TTL_DAYS],
  )
  return token
}

export async function destroyOperatorSession(pool: Pool, token: string): Promise<void> {
  await pool.query("DELETE FROM platform_operator_sessions WHERE token_hash = $1", [hashToken(token)])
}

async function resolveOperator(req: Request): Promise<OperatorContext | null> {
  const token = readConsoleToken(req)
  if (!token) return null
  const pool = getPool()
  if (!pool) return null
  const q = await pool.query(
    `SELECT s.id AS session_id, o.id, o.email, o.full_name, o.status, o.role
     FROM platform_operator_sessions s
     JOIN platform_operators o ON o.id = s.operator_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()
     LIMIT 1`,
    [hashToken(token)],
  )
  const row = q.rows[0] as
    | { session_id: string; id: string; email: string; full_name: string; status: string; role: ConsoleOperatorRole }
    | undefined
  if (!row || row.status !== "active") return null

  void pool
    .query("UPDATE platform_operator_sessions SET last_used_at = NOW() WHERE id = $1::uuid", [row.session_id])
    .catch(() => {})

  return {
    operatorId: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    sessionId: row.session_id,
  }
}

/**
 * Exige une session de console valide.
 *
 * Répond `404` et non `401`/`403` quand la session manque ou n'est pas celle
 * d'un opérateur : pour qui n'a rien à faire ici, la console n'existe pas.
 * Un 403 confirmerait l'adresse à sonder.
 */
export async function requireOperator(req: Request, _res: Response, next: NextFunction) {
  try {
    const operator = await resolveOperator(req)
    if (!operator) {
      throw new HttpError(404, "not_found", "Cette route API n'existe pas.")
    }
    req.operator = operator
    next()
  } catch (error) {
    next(error)
  }
}

/** Seul un administrateur gère les opérateurs et leurs accès. */
export function requireConsoleAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.operator?.role !== "admin") {
    next(new HttpError(403, "console_admin_required", "Cette action est réservée à un administrateur de la Console."))
    return
  }
  next()
}

/**
 * Profil support : consultation seule, sur toutes les routes de la Console.
 * Le garde est appliqué côté serveur, pas seulement en masquant les boutons.
 */
export function requireConsoleWrite(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.operator?.role !== "support") {
    next()
    return
  }
  next(new HttpError(403, "console_read_only", "Le profil support est limité à la consultation."))
}

/**
 * Journalise une action dans le registre de l'éditeur.
 *
 * Complète — et ne remplace pas — l'écriture dans le journal du client :
 * celui-ci doit voir chez lui qu'on a touché à son abonnement. Ce registre-ci
 * sert à relire les interventions de l'éditeur sans parcourir trois cents
 * journaux, et il survit à la purge d'une organisation.
 */
export async function logConsoleAction(
  pool: Pool | PoolClient,
  operator: OperatorContext,
  action: string,
  organizationId: string | null,
  organizationName: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO platform_audit_logs(operator_id, operator_email, action, organization_id, organization_name, metadata)
     VALUES($1::uuid,$2,$3,$4::uuid,$5,$6::jsonb)`,
    [operator.operatorId, operator.email, action, organizationId, organizationName, JSON.stringify(metadata)],
  )
}

// ---------------------------------------------------------------------------
// Amorçage des comptes opérateurs
// ---------------------------------------------------------------------------

/**
 * Aligne la table des opérateurs sur `PLATFORM_ADMIN_EMAILS`.
 *
 * Idempotent et réversible, comme l'ancien drapeau : retirer une adresse de la
 * variable désactive le compte au redémarrage suivant, sans intervention en
 * base. Le compte n'est pas supprimé — ses actions passées restent
 * attribuables dans le journal.
 *
 * Le mot de passe initial vient de `PLATFORM_ADMIN_PASSWORD`. À défaut, un mot
 * de passe aléatoire est tiré et affiché **une seule fois** au démarrage :
 * mieux vaut un secret qu'il faut aller chercher dans les journaux qu'un
 * compte d'administration ouvert avec un mot de passe deviné.
 */
export async function syncPlatformOperators(
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>,
): Promise<void> {
  const emails = env.PLATFORM_ADMIN_EMAILS
  if (emails.length === 0) {
    const existing = await query("SELECT count(*)::int AS n FROM platform_operators WHERE status = 'active'")
    if (((existing.rows[0] as { n: number } | undefined)?.n ?? 0) === 0) {
      console.warn(
        "[console] PLATFORM_ADMIN_EMAILS n'est pas defini et aucun operateur actif n'existe : la console sera inaccessible.",
      )
    }
    return
  }

  for (const email of emails) {
    const found = await query("SELECT id, status, managed_by FROM platform_operators WHERE email = $1", [email])
    const row = found.rows[0] as { id: string; status: string; managed_by: string } | undefined

    if (!row) {
      const generated = !env.PLATFORM_ADMIN_PASSWORD
      const password = env.PLATFORM_ADMIN_PASSWORD || randomBytes(12).toString("base64url")
      await query(
        `INSERT INTO platform_operators(email, password_hash, full_name, status, role, managed_by)
         VALUES($1, $2, $3, 'active', 'admin', 'bootstrap')`,
        [email, await hashPassword(password), email.split("@")[0]],
      )
      if (generated) {
        console.warn(
          `[console] Operateur cree : ${email} — mot de passe provisoire : ${password}\n` +
            "[console] Notez-le maintenant, il ne sera plus affiche. Definissez PLATFORM_ADMIN_PASSWORD pour en choisir un.",
        )
      } else {
        console.info(`[console] Operateur cree : ${email}`)
      }
      continue
    }

    // Un compte désormais géré depuis la Console ne dépend plus de la liste
    // d'amorçage : un redémarrage ne doit ni le réactiver ni changer son rôle.
    if (row.managed_by === "console") continue

    if (row.status !== "active") {
      await query("UPDATE platform_operators SET status = 'active', updated_at = now() WHERE id = $1::uuid", [row.id])
      console.info(`[console] Operateur reactive : ${email}`)
    }
  }

  const disabled = await query(
    `UPDATE platform_operators SET status = 'disabled', updated_at = now()
     WHERE status = 'active' AND managed_by = 'bootstrap' AND email <> ALL($1::text[]) RETURNING email`,
    [emails],
  )
  if (disabled.rowCount) {
    // Une session encore ouverte survivrait à la révocation : on la coupe.
    await query(
      `DELETE FROM platform_operator_sessions
       WHERE operator_id IN (SELECT id FROM platform_operators WHERE status = 'disabled' AND managed_by = 'bootstrap')`,
    )
    console.info(`[console] Operateurs desactives : ${disabled.rowCount}`)
  }
}

/**
 * Reprend les anciens `users.platform_admin` sous forme d'opérateurs.
 *
 * Sans cela, la bascule enfermerait dehors le créateur de l'application : son
 * droit vivait sur son compte de station, qui ne donne plus rien. Le mot de
 * passe n'est pas repris — les deux comptes sont désormais indépendants, et
 * `syncPlatformOperators` fournit le nouveau secret.
 */
export async function migrateLegacyPlatformAdmins(
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>,
): Promise<void> {
  const legacy = await query(
    `SELECT lower(email) AS email, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) AS name
     FROM users WHERE platform_admin`,
  )
  const rows = legacy.rows as { email: string; name: string }[]
  if (rows.length === 0) return

  for (const row of rows) {
    await query(
      `INSERT INTO platform_operators(email, full_name, status)
       VALUES($1, $2, 'active') ON CONFLICT (email) DO NOTHING`,
      [row.email, row.name],
    )
  }
  // Le drapeau n'autorise plus rien ; on l'éteint pour qu'aucune lecture
  // résiduelle ne rouvre la porte depuis une station.
  await query("UPDATE users SET platform_admin = false WHERE platform_admin")
  console.info(
    `[console] ${rows.length} ancien(s) administrateur(s) repris comme operateur(s) : ${rows.map((r) => r.email).join(", ")}`,
  )
}

// ---------------------------------------------------------------------------
// Routes publiques de la console (avant toute exigence de session)
// ---------------------------------------------------------------------------

export function createConsoleAuthRouter() {
  const r = Router()

  r.post(
    "/login",
    asyncRoute(async (req, res) => {
      const input = body(
        z
          .object({
            email: z.string().trim().toLowerCase().email(),
            password: z.string().min(1).max(200),
          })
          .strip(),
        req.body,
      )

      const pool = consoleDb()
      const q = await pool.query(
        "SELECT id, email, full_name, password_hash, status, role FROM platform_operators WHERE email = $1",
        [input.email],
      )
      const row = q.rows[0] as
        | { id: string; email: string; full_name: string; password_hash: string | null; status: string; role: ConsoleOperatorRole }
        | undefined

      // Message unique quelle que soit la cause : un compte d'administration
      // ne doit pas se laisser énumérer adresse par adresse.
      const refuse = () => {
        throw new HttpError(401, "invalid_credentials", "Identifiants invalides.")
      }
      if (!row || row.status !== "active") {
        // Coût de vérification comparable à celui d'un compte réel, pour ne
        // pas trahir l'existence de l'adresse par le temps de réponse.
        await verifyPassword(input.password, null)
        refuse()
        return
      }
      if (!(await verifyPassword(input.password, row.password_hash))) {
        refuse()
        return
      }

      const token = await createOperatorSession(pool, row!.id)
      await pool.query("UPDATE platform_operators SET last_login_at = now() WHERE id = $1::uuid", [row!.id])
      setConsoleCookie(req, res, token)
      res.json({
        token,
        operator: { id: row!.id, email: row!.email, full_name: row!.full_name, role: row!.role },
      })
    }),
  )

  r.post(
    "/logout",
    asyncRoute(async (req, res) => {
      const token = readConsoleToken(req)
      if (token) await destroyOperatorSession(consoleDb(), token)
      clearConsoleCookie(req, res)
      res.json({ ok: true })
    }),
  )

  r.get(
    "/me",
    asyncRoute(async (req, res) => {
      const operator = await resolveOperator(req)
      if (!operator) {
        res.status(401).json({ error: { code: "authentication_required", message: "Session de console requise." } })
        return
      }
      res.json({
        operator: { id: operator.operatorId, email: operator.email, full_name: operator.fullName, role: operator.role },
      })
    }),
  )

  return r
}
