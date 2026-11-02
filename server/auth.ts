import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto"
import { hash as argon2Hash, parseOptions, verify as argon2Verify } from "@node-rs/argon2"
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
// Password hashing (Argon2id primary, scrypt accepted for gradual migration)
// ---------------------------------------------------------------------------

const ARGON2ID_ALGORITHM = 2 // @node-rs/argon2 Algorithm.Argon2id
const ARGON2_VERSION_13 = 1 // @node-rs/argon2 Version.V0x13
const ARGON2ID_POLICY = {
  algorithm: ARGON2ID_ALGORITHM,
  version: ARGON2_VERSION_13,
  memoryCost: 19_456, // KiB (19 MiB); OWASP-recommended baseline
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

// A fixed dummy PHC hash makes missing-account login attempts pay roughly the
// same Argon2 cost as a real account. Its password is not associated with any
// account and the hash is deliberately not a secret.
const DUMMY_ARGON2ID_HASH = "$argon2id$v=19$m=19456,t=2,p=1$H1D/Rl26gBji0oFANDs9DQ$vGqdzmDwdjZSi3objenYY+N+hpclzfBvOkSXIZlEI+E"
const MAX_VERIFY_MEMORY_KIB = 262_144
const MAX_VERIFY_TIME_COST = 10
const MAX_VERIFY_PARALLELISM = 8

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2ID_POLICY)
}

/** True for a verified legacy or weaker hash that should be upgraded at login. */
export function needsPasswordRehash(stored: string | null | undefined): boolean {
  if (!stored) return false
  if (stored.startsWith("scrypt:")) return true
  if (!stored.startsWith("$argon2")) return false

  try {
    const parsed = parseOptions(stored)
    return (
      parsed.algorithm !== ARGON2ID_POLICY.algorithm ||
      parsed.version !== ARGON2ID_POLICY.version ||
      parsed.memoryCost < ARGON2ID_POLICY.memoryCost ||
      parsed.timeCost < ARGON2ID_POLICY.timeCost ||
      parsed.parallelism < ARGON2ID_POLICY.parallelism ||
      parsed.outputLen < ARGON2ID_POLICY.outputLen ||
      parsed.saltLen < 16
    )
  } catch {
    return false
  }
}

function isSafeArgon2Hash(stored: string): boolean {
  try {
    const parsed = parseOptions(stored)
    return (
      parsed.memoryCost <= MAX_VERIFY_MEMORY_KIB &&
      parsed.timeCost <= MAX_VERIFY_TIME_COST &&
      parsed.parallelism <= MAX_VERIFY_PARALLELISM &&
      parsed.outputLen >= 16 &&
      parsed.outputLen <= 64 &&
      parsed.saltLen >= 8 &&
      parsed.saltLen <= 64
    )
  } catch {
    return false
  }
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    try {
      await argon2Verify(DUMMY_ARGON2ID_HASH, password)
    } catch {
      // A malformed candidate should not turn a login refusal into a 500.
    }
    return false
  }

  if (stored.startsWith("$argon2")) {
    if (!isSafeArgon2Hash(stored)) return false
    try {
      return await argon2Verify(stored, password)
    } catch {
      return false
    }
  }

  const [scheme, saltHex, hashHex] = stored.split(":")
  if (
    scheme !== "scrypt" ||
    !saltHex || !hashHex ||
    !/^(?:[0-9a-f]{2})+$/i.test(saltHex) ||
    !/^(?:[0-9a-f]{2})+$/i.test(hashHex)
  ) return false

  const salt = Buffer.from(saltHex, "hex")
  const expected = Buffer.from(hashHex, "hex")
  if (salt.length < 8 || salt.length > 64 || expected.length < 16 || expected.length > 128) return false
  try {
    const derived = await scrypt(password, salt, expected.length)
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
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
