import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto"
import { promisify } from "node:util"
import type { NextFunction, Request, Response } from "express"
import type pg from "pg"
import { getPool } from "./db.ts"
import type { Permission } from "./permissions.ts"

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}

export interface AuthContext {
  userId: string
  email: string
  sessionId: string
}

// Express request augmentation requires a namespace declaration by design.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext
      tenant?: {
        organizationId: string
        userId: string
        role: string
        siteId?: string
        /** Permissions effectives (rôle + exceptions), calculées par requireTenantContext. */
        permissions: Set<Permission>
        /** Raccourci de lecture, équivalent à `permissions.has(p)`. */
        can: (permission: Permission) => boolean
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, Node built-in — no external dependency)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN)
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const [scheme, saltHex, hashHex] = stored.split(":")
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, "hex")
  const expected = Buffer.from(hashHex, "hex")
  const derived = await scrypt(password, salt, expected.length)
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

// ---------------------------------------------------------------------------
// Sessions (opaque token in an httpOnly cookie; only its SHA-256 is stored)
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "washpilot_session"
export const SESSION_TTL_DAYS = 30

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export async function createSession(pool: pg.Pool, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + make_interval(days => $3))`,
    [userId, hashSessionToken(token), SESSION_TTL_DAYS],
  )
  return token
}

export async function destroySession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [hashSessionToken(token)])
}

// ---------------------------------------------------------------------------
// Password reset tokens (single-use, short-lived; only the SHA-256 is stored)
// ---------------------------------------------------------------------------

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Crée un jeton de réinitialisation à usage unique et invalide les jetons
 * encore actifs de l'utilisateur (un seul lien valide à la fois).
 */
export async function createPasswordResetToken(
  pool: pg.Pool,
  userId: string,
  ttlMinutes: number,
  requestedIp?: string | null,
): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await pool.query(
    "UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL",
    [userId],
  )
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, NOW() + make_interval(mins => $3), $4)`,
    [userId, hashResetToken(token), ttlMinutes, requestedIp ?? null],
  )
  return token
}

/**
 * Consomme un jeton de réinitialisation : l'opération est atomique, un jeton
 * expiré ou déjà utilisé renvoie null (aucun indice sur la cause).
 */
export async function consumePasswordResetToken(
  pool: pg.Pool,
  token: string,
): Promise<string | null> {
  if (!token) return null
  const q = await pool.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [hashResetToken(token)],
  )
  const row = q.rows[0] as { user_id: string } | undefined
  return row?.user_id ?? null
}

/** Vérifie qu'un jeton est encore exploitable sans le consommer (pré-affichage du formulaire). */
export async function isPasswordResetTokenValid(pool: pg.Pool, token: string): Promise<boolean> {
  if (!token) return false
  const q = await pool.query(
    `SELECT 1 FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [hashResetToken(token)],
  )
  return Boolean(q.rowCount)
}

/** The preview/production proxy serves HTTPS: cross-site iframes then require SameSite=None; Secure. */
function cookieSecurity(req: Request): { secure: boolean; sameSite: "none" | "lax" } {
  const secure = req.secure || req.get("x-forwarded-proto") === "https"
  return { secure, sameSite: secure ? "none" : "lax" }
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const { secure, sameSite } = cookieSecurity(req)
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  })
}

export function clearSessionCookie(req: Request, res: Response): void {
  const { secure, sameSite } = cookieSecurity(req)
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite, secure, path: "/" })
}

/**
 * Read the session token from the cookie, or from the Authorization header
 * (fallback for embedded previews where third-party cookies are blocked).
 */
export function readSessionToken(req: Request): string | null {
  const header = req.get("cookie")
  if (header) {
    for (const part of header.split(";")) {
      const separator = part.indexOf("=")
      if (separator === -1) continue
      const name = part.slice(0, separator).trim()
      if (name !== SESSION_COOKIE) continue
      const value = part.slice(separator + 1).trim()
      if (value) return decodeURIComponent(value)
    }
  }
  const authorization = req.get("authorization") || ""
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  if (match) return match[1].trim()
  // Dernier recours : certains proxys consomment l'en-tête Authorization.
  const custom = req.get("x-session-token")
  return custom ? custom.trim() : null
}

export interface SessionUser {
  sessionId: string
  userId: string
  email: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  avatarUrl: string | null
  status: string
}

/** Resolve the active user for the request's session cookie, or null. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const token = readSessionToken(req)
  if (!token) return null
  const pool = getPool()
  if (!pool) return null

  const q = await pool.query(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, u.first_name, u.last_name, u.phone, u.avatar_url, u.status
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()
     LIMIT 1`,
    [hashSessionToken(token)],
  )
  const row = q.rows[0] as {
    session_id: string; user_id: string; email: string; first_name: string | null
    last_name: string | null; phone: string | null; avatar_url: string | null; status: string
  } | undefined
  if (!row || row.status !== "active") return null
  // Sliding expiration: refresh the window on activity (best effort).
  void pool.query(
    `UPDATE auth_sessions SET last_used_at = NOW(), expires_at = NOW() + make_interval(days => $2) WHERE id = $1`,
    [row.session_id, SESSION_TTL_DAYS],
  ).catch(() => {})
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    status: row.status,
  }
}

/** Require a valid session cookie; attach the authenticated user to the request. */
export async function requireSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const pool = getPool()
    if (!pool) throw new HttpError(503, "database_not_configured", "La base de données n'est pas configurée.")
    const user = await getSessionUser(req)
    if (!user) throw new HttpError(401, "authentication_required", "Connectez-vous pour continuer.")
    req.auth = { userId: user.userId, email: user.email, sessionId: user.sessionId }
    next()
  } catch (error) {
    if (error instanceof HttpError) return next(error)
    next(new HttpError(401, "invalid_session", "Votre session a expiré ou n'est pas valide. Reconnectez-vous."))
  }
}
