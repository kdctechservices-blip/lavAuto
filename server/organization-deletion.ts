import type { Pool } from "pg"

// ---------------------------------------------------------------------------
// Suppression d'une station, en deux temps
//
// Pourquoi deux temps plutôt qu'un `DELETE` : une suppression se décide sur
// une information, et l'information peut être fausse. Un paiement cru perdu
// qui arrive le lendemain, un homonyme, un client qui se ravise. Effacer
// aussitôt transforme chacune de ces erreurs en perte définitive, alors
// qu'aucune d'elles ne justifiait d'aller si vite.
//
//   1. `schedule` — l'accès est coupé immédiatement et la station sort des
//      listes. Pour le client, c'est déjà fini. Pour l'éditeur, c'est encore
//      réparable d'un clic.
//   2. `purge` — l'effacement physique, à l'échéance seulement, ou déclenché
//      à la main en connaissance de cause.
//
// Le délai de grâce par défaut est de 30 jours. Il est suffisant pour qu'une
// réclamation arrive, et assez court pour ne pas garder indéfiniment les
// données de quelqu'un qui a demandé à partir.
// ---------------------------------------------------------------------------

export const DEFAULT_GRACE_DAYS = 30

/**
 * Ordre d'effacement : des feuilles vers les racines.
 *
 * Ni `ON DELETE CASCADE` ni `TRUNCATE` ne sont utilisés. Le premier n'est pas
 * déclaré sur ces tables ; le second effacerait tout le monde. On énumère
 * donc, et l'énumération est vérifiée par un test qui compare cette liste au
 * schéma réel : une table ajoutée plus tard et oubliée ici laisserait des
 * orphelins derrière chaque purge.
 */
const PURGE_ORDER: { table: string; where: string }[] = [
  // Dépendances des lavages, qui ne portent pas d'organization_id.
  { table: "receipt_issues", where: "organization_id = $1::uuid" },
  { table: "wash_items", where: "wash_id IN (SELECT id FROM washes WHERE organization_id = $1::uuid)" },
  { table: "wash_assignments", where: "wash_id IN (SELECT id FROM washes WHERE organization_id = $1::uuid)" },
  // Puis tout ce qui porte directement l'organisation.
  // Stock : les mouvements référencent les produits, qui référencent les
  // catégories — l'ordre inverse de création est le seul qui tienne. La
  // recette des prestations vient en tête : elle pointe à la fois vers les
  // produits et vers les services.
  { table: "service_consumables", where: "organization_id = $1::uuid" },
  { table: "stock_movements", where: "organization_id = $1::uuid" },
  // Les lignes d'achat pointent vers les produits : elles partent avant eux.
  { table: "purchase_items", where: "organization_id = $1::uuid" },
  { table: "products", where: "organization_id = $1::uuid" },
  { table: "product_categories", where: "organization_id = $1::uuid" },
  { table: "cash_movements", where: "organization_id = $1::uuid" },
  { table: "payments", where: "organization_id = $1::uuid" },
  { table: "washes", where: "organization_id = $1::uuid" },
  { table: "notifications", where: "organization_id = $1::uuid" },
  { table: "expenses", where: "organization_id = $1::uuid" },
  { table: "utility_reading_photos", where: "organization_id = $1::uuid" },
  { table: "utility_readings", where: "organization_id = $1::uuid" },
  { table: "utility_meters", where: "organization_id = $1::uuid" },
  { table: "cash_sessions", where: "organization_id = $1::uuid" },
  // Les achats sont référencés par les mouvements de stock et par les
  // dépenses, tous deux déjà purgés ci-dessus. Les fournisseurs ferment la
  // marche, puisque les achats les désignent.
  { table: "purchases", where: "organization_id = $1::uuid" },
  { table: "suppliers", where: "organization_id = $1::uuid" },
  { table: "services", where: "organization_id = $1::uuid" },
  { table: "service_categories", where: "organization_id = $1::uuid" },
  { table: "vehicle_categories", where: "organization_id = $1::uuid" },
  // Présences et horaires pointent vers les laveurs : ils partent avant eux.
  { table: "attendance_records", where: "organization_id = $1::uuid" },
  { table: "work_schedules", where: "organization_id = $1::uuid" },
  { table: "workers", where: "organization_id = $1::uuid" },
  { table: "customers", where: "organization_id = $1::uuid" },
  { table: "sites", where: "organization_id = $1::uuid" },
  { table: "onboarding_progress", where: "organization_id = $1::uuid" },
  { table: "idempotency_keys", where: "organization_id = $1::uuid" },
  { table: "member_permissions", where: "organization_id = $1::uuid" },
  { table: "subscription_reminders", where: "organization_id = $1::uuid" },
  { table: "payment_intents", where: "organization_id = $1::uuid" },
  // La demande de clôture part avec la station qu'elle visait : l'éditeur en
  // garde la trace dans son propre registre, qui survit à la purge.
  { table: "closure_requests", where: "organization_id = $1::uuid" },
  // Les corps de requete captures appartiennent au client : les conserver
  // apres sa suppression viderait la suppression de son sens.
  { table: "error_events", where: "organization_id = $1::uuid" },
  { table: "support_messages", where: "request_id IN (SELECT id FROM support_requests WHERE organization_id = $1::uuid)" },
  { table: "support_requests", where: "organization_id = $1::uuid" },
  { table: "audit_logs", where: "organization_id = $1::uuid" },
  { table: "subscriptions", where: "organization_id = $1::uuid" },
  { table: "organization_members", where: "organization_id = $1::uuid" },
]

/** Tables à `organization_id` que la purge laisse volontairement intactes. */
export const PURGE_EXEMPT = new Set([
  // Le registre de l'éditeur : c'est précisément la trace que cette station a
  // existé et qu'on l'a supprimée. L'effacer effacerait la preuve de l'acte.
  "platform_audit_logs",
  // Les comptes sont traités à part : un utilisateur peut appartenir à une
  // autre station, auquel cas il survit (voir `purgeOrganization`).
  "users",
  // Le registre des encaissements. Supprimer une station ne doit pas
  // supprimer le chiffre d'affaires qu'elle a payé : l'argent a bien été
  // reçu, il reste dû au fisc et au bilan. La ligne est conservée, son
  // `organization_id` est effacé, et le nom recopié à l'écriture la garde
  // lisible (voir `purgeOrganization`).
  "subscription_payments",
])

export function purgeTables(): string[] {
  return PURGE_ORDER.map((step) => step.table)
}

/**
 * Programme la suppression : coupe l'accès maintenant, efface plus tard.
 *
 * L'abonnement passe en `cancelled` dans le même mouvement. Sans cela, la
 * station resterait exploitable jusqu'à la purge — on aurait annoncé une
 * suppression sans rien suspendre.
 */
export async function scheduleDeletion(
  pool: Pool,
  organizationId: string,
  reason: string,
  graceDays: number = DEFAULT_GRACE_DAYS,
): Promise<{ scheduled_for: string }> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const updated = await client.query(
      `UPDATE organizations
          SET deletion_requested_at = now(),
              deletion_scheduled_for = now() + make_interval(days => $2),
              deletion_reason = $3,
              updated_at = now()
        WHERE id = $1::uuid AND deletion_requested_at IS NULL
      RETURNING deletion_scheduled_for`,
      [organizationId, graceDays, reason],
    )
    if (!updated.rowCount) {
      await client.query("ROLLBACK")
      throw new Error("not_scheduled")
    }
    await client.query(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE organization_id = $1::uuid",
      [organizationId],
    )
    // Les sessions ouvertes survivraient à la coupure : on les ferme.
    await client.query(
      `DELETE FROM auth_sessions WHERE user_id IN (
         SELECT user_id FROM organization_members WHERE organization_id = $1::uuid)`,
      [organizationId],
    )
    await client.query("COMMIT")
    return { scheduled_for: (updated.rows[0] as { deletion_scheduled_for: string }).deletion_scheduled_for }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Annule une suppression programmée et rouvre la station en lecture seule. */
export async function cancelDeletion(pool: Pool, organizationId: string): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE organizations
        SET deletion_requested_at = NULL, deletion_scheduled_for = NULL,
            deletion_reason = NULL, updated_at = now()
      WHERE id = $1::uuid AND deletion_requested_at IS NOT NULL
    RETURNING id`,
    [organizationId],
  )
  // L'abonnement reste `cancelled` : restaurer l'accès n'est pas offrir un
  // forfait. L'opérateur réactive ensuite explicitement s'il le veut, et
  // cette réactivation-là est journalisée pour ce qu'elle est.
  return updated.rowCount === 1
}

/**
 * Efface définitivement. Irréversible.
 *
 * Tout tient dans une transaction : une purge à moitié faite laisserait une
 * organisation sans abonnement mais avec ses lavages, c'est-à-dire un état
 * qu'aucun écran ne sait afficher.
 */
export async function purgeOrganization(
  pool: Pool,
  organizationId: string,
): Promise<{ name: string; deleted: Record<string, number>; users_deleted: number }> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const nameQ = await client.query("SELECT name FROM organizations WHERE id = $1::uuid FOR UPDATE", [
      organizationId,
    ])
    if (!nameQ.rowCount) {
      await client.query("ROLLBACK")
      throw new Error("not_found")
    }
    const name = (nameQ.rows[0] as { name: string }).name

    // Les comptes qui n'appartiennent QU'à cette station disparaissent avec
    // elle. Ceux qui travaillent aussi ailleurs sont conservés : supprimer un
    // utilisateur parce qu'une de ses stations ferme lui ferait perdre l'autre.
    const soleMembers = await client.query<{ user_id: string }>(
      `SELECT m.user_id FROM organization_members m
        WHERE m.organization_id = $1::uuid
          AND NOT EXISTS (
            SELECT 1 FROM organization_members other
             WHERE other.user_id = m.user_id AND other.organization_id <> $1::uuid)`,
      [organizationId],
    )
    const userIds = soleMembers.rows.map((row) => row.user_id)

    const deleted: Record<string, number> = {}
    for (const step of PURGE_ORDER) {
      const result = await client.query(`DELETE FROM ${step.table} WHERE ${step.where}`, [organizationId])
      if (result.rowCount) deleted[step.table] = result.rowCount
    }

    let usersDeleted = 0
    if (userIds.length) {
      await client.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])", [userIds])
      await client.query("DELETE FROM password_reset_tokens WHERE user_id = ANY($1::uuid[])", [userIds])
      // `cash_movements.created_by` et consorts sont déjà partis avec les
      // lignes ci-dessus ; il ne reste que les comptes eux-mêmes.
      const removed = await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds])
      usersDeleted = removed.rowCount ?? 0
    }

    // Le registre comptable survit, mais cesse de pointer une station qui
    // n'existe plus. Le nom déjà recopié sur chaque ligne suffit à
    // l'identifier dans un export.
    await client.query(
      "UPDATE subscription_payments SET organization_id = NULL WHERE organization_id = $1::uuid",
      [organizationId],
    )

    await client.query("DELETE FROM organizations WHERE id = $1::uuid", [organizationId])
    await client.query("COMMIT")
    return { name, deleted, users_deleted: usersDeleted }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Purge les stations dont le délai de grâce est écoulé.
 *
 * Appelée par le planificateur. Chaque organisation est traitée séparément :
 * l'échec d'une purge ne doit pas empêcher les suivantes.
 */
export async function runScheduledPurges(
  pool: Pool,
): Promise<{ purged: string[]; failed: { id: string; error: string }[] }> {
  const due = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organizations
      WHERE deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= now()`,
  )
  const purged: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const row of due.rows) {
    try {
      await purgeOrganization(pool, row.id)
      await pool.query(
        `INSERT INTO platform_audit_logs(operator_email, action, organization_id, organization_name, metadata)
         VALUES('system', 'organization.purged', NULL, $1, $2::jsonb)`,
        [row.name, JSON.stringify({ trigger: "scheduled" })],
      )
      purged.push(row.id)
    } catch (error) {
      failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { purged, failed }
}
