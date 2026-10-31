import { createHash } from "node:crypto"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { HttpError } from "./auth.ts"

/** Serialize a value with object keys sorted so logically equal payloads hash identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
}

/** Hash a request payload to detect key reuse with a different body. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

/** Validate the Idempotency-Key header: required, printable, bounded length. */
export function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim()
  if (!key || key.length > 200 || hasControlCharacters(key)) {
    throw new HttpError(400, "idempotency_key_required", "En-tête Idempotency-Key requis et valide.")
  }
  return key
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

export interface IdempotentResult {
  status: number
  body: unknown
}

/**
 * Run `handler` at most once per (organization, Idempotency-Key).
 * Replays return the stored response with the Idempotency-Replayed header.
 * Reusing a key with a different payload is rejected (409).
 */
export async function withIdempotency(
  pool: Pool,
  req: Request,
  res: Response,
  organizationId: string,
  payloadFingerprint: string,
  handler: () => Promise<IdempotentResult>,
): Promise<void> {
  const key = requireIdempotencyKey(req.get("Idempotency-Key") ?? undefined)

  const existing = await pool.query(
    "SELECT fingerprint, response_status, response_body FROM idempotency_keys WHERE organization_id=$1::uuid AND key=$2",
    [organizationId, key],
  )
  if (existing.rowCount) {
    const row = existing.rows[0]
    if (row.fingerprint !== payloadFingerprint) {
      throw new HttpError(409, "idempotency_key_conflict", "Cette clé d’idempotence a déjà été utilisée avec un contenu différent.")
    }
    if (row.response_status == null) {
      throw new HttpError(409, "idempotency_in_progress", "Une requête identique est déjà en cours de traitement.")
    }
    res.setHeader("Idempotency-Replayed", "true")
    res.status(row.response_status).json(row.response_body)
    return
  }

  // Reserve the key first so a concurrent duplicate sees it and backs off.
  const reserved = await pool.query(
    "INSERT INTO idempotency_keys(organization_id,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT (organization_id,key) DO NOTHING RETURNING id",
    [organizationId, key, payloadFingerprint],
  )
  if (!reserved.rowCount) {
    throw new HttpError(409, "idempotency_in_progress", "Une requête identique est déjà en cours de traitement.")
  }

  try {
    const result = await handler()
    await pool.query(
      "UPDATE idempotency_keys SET response_status=$3, response_body=$4 WHERE organization_id=$1::uuid AND key=$2",
      [organizationId, key, result.status, JSON.stringify(result.body ?? null)],
    )
    res.status(result.status).json(result.body)
  } catch (error) {
    // Free the key so the caller can retry after a failure.
    await pool.query("DELETE FROM idempotency_keys WHERE organization_id=$1::uuid AND key=$2 AND response_status IS NULL", [organizationId, key]).catch(() => {})
    throw error
  }
}
