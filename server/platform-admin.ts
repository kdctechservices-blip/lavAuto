import type { Pool, PoolClient } from "pg"
import { getPool } from "./db.ts"
import { HttpError } from "./auth.ts"

// ---------------------------------------------------------------------------
// Administration de plateforme — accès à la base et trace chez le client
//
// L'identité de l'opérateur et sa session vivent dans `console-auth.ts`. Ce
// module ne garde que ce qui touche aux données des clients.
//
// Le reste de l'API repose sur `requireTenantContext` : l'organisation vient
// de l'appartenance en base et jamais du navigateur, ce qui rend structurelle
// l'isolation entre stations. L'administration doit précisément traverser
// cette frontière — pour activer le forfait d'un client, il faut écrire chez
// lui. Elle est donc isolée dans son propre module et montée **avant**
// `requireSession` (voir `server/app.ts`), derrière sa propre authentification.
// ---------------------------------------------------------------------------

export function adminDb(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

/**
 * Journalise une action d'administration **dans le journal de la station
 * concernée**, en plus du registre de l'éditeur.
 *
 * C'est délibéré : le propriétaire doit voir dans son propre historique que
 * son forfait a été activé, par qui et quand. Une intervention de l'éditeur
 * invisible du client serait une porte dérobée.
 *
 * `actor_user_id` reste NULL : depuis la séparation des comptes, un opérateur
 * n'est plus une ligne de `users` et la clé étrangère n'aurait rien à viser.
 * L'adresse de l'opérateur est donc portée par les métadonnées.
 */
export async function auditPlatformAction(
  client: Pool | PoolClient,
  organizationId: string,
  operatorEmail: string,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES($1::uuid, NULL, $2, 'subscription', $3::text, $4::jsonb)`,
    [
      organizationId,
      action,
      entityId,
      JSON.stringify({ ...metadata, by: "platform_admin", operator_email: operatorEmail }),
    ],
  )
}
