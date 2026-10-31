import type { Request, Response, NextFunction } from "express"
import { z } from "zod"
import { HttpError } from "./auth.ts"
import { deniedMessage, type Permission } from "./permissions.ts"
import { describeIssues } from "./validation-messages.ts"

export { HttpError } from "./auth.ts"

/** Wrap an async Express handler so rejections reach the error middleware. */
export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => unknown) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next)
}

/** Validate a request body against a zod schema, raising a 400 on failure. */
export function body<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new HttpError(400, "invalid_data", describeIssues(result.error.issues, value))
  }
  return result.data
}

/** Return the tenant context attached by requireTenantContext, or raise a 401. */
export function tenant(req: Request) {
  if (!req.tenant) throw new HttpError(401, "tenant_required", "Organisation active requise.")
  return req.tenant
}

/**
 * Exige une permission pour atteindre la route.
 *
 * Suppose que `requireSession` puis `requireTenantContext` ont déjà renseigné
 * `req.tenant` : ce middleware ne vérifie pas l'identité, il vérifie le droit.
 * Sans session → 401 ; avec session mais sans droit → 403.
 *
 * C'est le seul point de contrôle des autorisations côté serveur : masquer un
 * bouton dans l'interface ne protège rien, cette fonction si.
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) {
      return next(new HttpError(401, "authentication_required", "Connectez-vous pour continuer."))
    }
    const missing = permissions.find((permission) => !req.tenant!.can(permission))
    if (missing) {
      return next(new HttpError(403, "forbidden", deniedMessage(missing)))
    }
    next()
  }
}

/**
 * Vérifie une permission à l'intérieur d'un gestionnaire, lorsque le droit
 * dépend des données (par exemple : modifier un lavage déjà clôturé).
 */
export function assertPermission(req: Request, permission: Permission) {
  if (!req.tenant) throw new HttpError(401, "authentication_required", "Connectez-vous pour continuer.")
  if (!req.tenant.can(permission)) throw new HttpError(403, "forbidden", deniedMessage(permission))
}

/** Parse a route parameter as a UUID, raising a 400 on failure. */
export function parseId(value: string | string[] | undefined) {
  if (typeof value !== "string") throw new HttpError(400, "invalid_id", "Identifiant invalide.")
  const result = z.string().uuid().safeParse(value)
  if (!result.success) throw new HttpError(400, "invalid_id", "Identifiant invalide.")
  return result.data
}

/** Extract pagination parameters (?page, ?limit) with sane bounds. */
export function pageParams(req: Request) {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25))
  return { page, limit, offset: (page - 1) * limit }
}
