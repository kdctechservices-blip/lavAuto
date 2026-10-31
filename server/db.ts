import pg from "pg";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { resolvePgliteLocation, describePgliteLocation } from "./pglite-location.ts";
import { buildSslConfig, chooseDatabaseTarget, describeConnection } from "./database-target.ts";
import { bindRlsGuard, probeRlsRole, type RlsPool } from "./db-rls.ts";
import { env } from "./env.ts";
import { migrateLegacyPlatformAdmins, syncPlatformOperators } from "./console-auth.ts";
import { hashPassword } from "./auth.ts";
import {
  DEFAULT_SERVICE_CATEGORY_NAMES,
  DEFAULT_VEHICLE_CATEGORIES,
  SERVICE_CATALOG_TEMPLATES,
  serviceCategoryName,
} from "./default-catalog.ts";

const { Pool } = pg;

export interface DbQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
  fields: unknown[];
  command: string;
  affectedRows?: number;
}

export interface DbClient {
  query: <R = Record<string, unknown>>(
    sqlOrConfig: string | { text?: string; sql?: string; values?: unknown[] },
    params?: unknown[],
  ) => Promise<DbQueryResult<R>>;
  release: () => void;
}

export interface DbPool {
  query: <R = Record<string, unknown>>(
    sqlOrConfig: string | { text?: string; sql?: string; values?: unknown[] },
    params?: unknown[],
  ) => Promise<DbQueryResult<R>>;
  connect: () => Promise<DbClient>;
  end: () => Promise<void>;
}

let pool: pg.Pool | null = null;
let pgliteInstance: PGlite | null = null;
let ready = false;

export function getPool(): pg.Pool | null {
  return pool;
}
export function isDatabaseReady(): boolean {
  return ready && pool !== null;
}

// ---------------------------------------------------------------------------
// Catalogue des prestations — semis à chaque démarrage
//
// La liste vit dans `default-catalog.ts`. Elle est rejouée au démarrage plutôt
// qu'écrite dans le schéma : corriger un prix ou renommer une prestation doit
// atteindre les bases déjà créées, pas seulement les neuves.
//
// Les prestations retirées de la liste ne sont pas supprimées mais désactivées :
// une station a pu les sélectionner pendant son assistant, et un
// `services.template_id` ne doit jamais pointer vers une ligne disparue.
// ---------------------------------------------------------------------------
export async function seedServiceCatalog(
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>,
): Promise<void> {
  const kept: string[] = []
  for (const [index, template] of SERVICE_CATALOG_TEMPLATES.entries()) {
    kept.push(`${template.category}|${template.name}`)
    await query(
      `INSERT INTO service_catalog(category, name, price_cents, duration_minutes, description, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (category, name) DO UPDATE
         SET price_cents = EXCLUDED.price_cents,
             duration_minutes = EXCLUDED.duration_minutes,
             description = EXCLUDED.description,
             sort_order = EXCLUDED.sort_order,
             is_active = true`,
      [
        template.category,
        template.name,
        template.price_cents,
        template.duration_minutes,
        template.description,
        index + 1,
      ],
    )
  }
  // Ce qui n'est plus dans la liste sort du catalogue proposé — sans jamais
  // être effacé, pour ne pas casser une sélection déjà enregistrée.
  await query(
    `UPDATE service_catalog SET is_active = false
      WHERE is_active AND NOT ((category || '|' || name) = ANY($1::text[]))`,
    [kept],
  )
}

// ---------------------------------------------------------------------------
// Isolation multi-station au niveau des lignes (RLS)
//
// Les `WHERE organization_id` des routes protègent ce que le code a prévu ;
// ces politiques protègent ce qu'il n'a pas prévu. Chaque table de station
// n'accepte que les lignes dont `organization_id` vaut la variable
// `app.current_org`, que la connexion soit celle de la route en cours ou
// celle d'une tâche qui aurait oublié le filtre.
//
// Le mécanique complet (rôle applicatif, propagation de la portée) est
// décrit dans `server/db-rls.ts`. Trois familles de tables :
//
//   • `RLS_DIRECT_TABLES` — portent leur `organization_id` ;
//   • `RLS_PARENT_TABLES` — tables filles sans colonne d'organisation,
//     rattachées à leur mère (une ligne de lavage ne se voit qu'à travers
//     le lavage auquel elle appartient) ;
//   • `RLS_NULLABLE_ORG_TABLES` — journaux techniques dont les lignes sans
//     organisation (erreurs publiques, actions de console) restent lisibles
//     partout, mais dont les lignes d'une station ne quittent pas la station.
//
// Sont volontairement **hors RLS** : `users`, `plans`, `service_catalog`,
// les tables d'authentification et les tables de la console éditeur. Leurs
// lectures traversent les organisations par conception ; les enfermer
// casserait la connexion, les invitations par e-mail et la console.
// `organizations`, la racine du locataire, est protégée par une politique à
// part (`id = organisation courante`) : `requireTenantContext` la lit avant
// que la portée ne soit connue — ce passage précis s'exécute hors portée,
// comme les semis et la console.
// ---------------------------------------------------------------------------

/** Tables portant leur propre `organization_id`. */
const RLS_DIRECT_TABLES = [
  "subscriptions",
  "organization_members",
  "sites",
  "onboarding_progress",
  "service_categories",
  "vehicle_categories",
  "services",
  "workers",
  "work_schedules",
  "attendance_records",
  "customers",
  "washes",
  "receipt_issues",
  "notifications",
  "product_categories",
  "products",
  "stock_movements",
  "service_consumables",
  "payments",
  "cash_sessions",
  "cash_movements",
  "expenses",
  "utility_meters",
  "utility_readings",
  "utility_reading_photos",
  "suppliers",
  "purchases",
  "purchase_items",
  "idempotency_keys",
  "member_permissions",
  "subscription_reminders",
  "payment_intents",
  "subscription_payments",
  "support_requests",
  "closure_requests",
  "audit_logs",
] as const

/** Tables filles : visibles uniquement à travers leur mère, du même client. */
const RLS_PARENT_TABLES = [
  { table: "wash_items", parent: "washes", foreignKey: "wash_id" },
  { table: "wash_assignments", parent: "washes", foreignKey: "wash_id" },
  { table: "support_messages", parent: "support_requests", foreignKey: "request_id" },
  { table: "service_vehicle_prices", parent: "services", foreignKey: "service_id" },
] as const

/** Journaux techniques : lignes sans organisation visibles de tous les clients. */
const RLS_NULLABLE_ORG_TABLES = ["error_events", "platform_audit_logs"] as const

const RLS_CURRENT_ORG = "NULLIF(current_setting('app.current_org', true), '')::uuid"

function rlsPolicy(tableName: string, predicate: string): string {
  return [
    `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS org_isolation ON ${tableName};`,
    `CREATE POLICY org_isolation ON ${tableName}`,
    `  USING (${predicate})`,
    `  WITH CHECK (${predicate});`,
  ].join("\n")
}

function rlsSchemaSql(): string {
  const blocks: string[] = [
    `-- Rôle applicatif : droits DML uniquement, ni superutilisateur ni
-- BYPASSRLS. Les politiques s'appliquent à lui, contrairement au
-- propriétaire des tables que Postgres en dispense par principe. Créé de
-- façon idempotente ; sans droits suffisants (base hébergée verrouillée),
-- les politiques restent posées et protègent les connexions non
-- propriétaires, et le démarrage continue.
DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'washpilot_app') THEN
    CREATE ROLE washpilot_app NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '[rls] rôle washpilot_app non créable (droits insuffisants).';
END $rls$;

DO $rls$
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA public TO washpilot_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO washpilot_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO washpilot_app';
EXCEPTION WHEN undefined_object OR insufficient_privilege THEN
  RAISE NOTICE '[rls] droits du rôle washpilot_app non accordés.';
END $rls$;

-- Appartenance du compte de l'application au rôle : sans elle, SET ROLE est
-- refusé (« permission denied to set role ») et chaque requête échouerait.
-- Idempotent ; sur une base hébergée qui refuse l'ajout d'appartenance, la
-- sonde au démarrage indique le GRANT à exécuter à la main.
DO $rls$
BEGIN
  EXECUTE format('GRANT washpilot_app TO %I', current_user);
EXCEPTION WHEN undefined_object OR insufficient_privilege THEN
  RAISE NOTICE '[rls] appartenance de % au rôle washpilot_app non accordée (à faire à la main : GRANT washpilot_app TO %;).', current_user, current_user;
END $rls$;`,
  ]

  // La racine du locataire : une station ne voit que la sienne.
  blocks.push(rlsPolicy("organizations", `id = ${RLS_CURRENT_ORG}`))

  for (const table of RLS_DIRECT_TABLES) {
    blocks.push(rlsPolicy(table, `organization_id = ${RLS_CURRENT_ORG}`))
  }
  for (const { table, parent, foreignKey } of RLS_PARENT_TABLES) {
    blocks.push(
      rlsPolicy(
        table,
        `EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = ${table}.${foreignKey} AND p.organization_id = ${RLS_CURRENT_ORG})`,
      ),
    )
  }
  for (const table of RLS_NULLABLE_ORG_TABLES) {
    blocks.push(rlsPolicy(table, `(organization_id IS NULL OR organization_id = ${RLS_CURRENT_ORG})`))
  }
  return blocks.join("\n\n")
}

/**
 * SQL exécuté à chaque démarrage : création des tables si absentes, puis
 * alignement du catalogue des forfaits.
 *
 * Exporté pour être rejouable en test sur une base déjà peuplée. C'est le
 * seul moyen honnête de vérifier qu'un tarif décidé en console survit à un
 * redémarrage : en test, réinitialiser le schéma crée une base neuve, ce qui
 * effacerait la question au lieu d'y répondre.
 */
export const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), clerk_user_id text UNIQUE,
 organization_id uuid, email text NOT NULL, first_name text, last_name text, phone text,
 avatar_url text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
 password_hash text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), clerk_org_id text UNIQUE,
 name text NOT NULL, slug text, onboarding_completed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin boolean NOT NULL DEFAULT false;
-- Rattachement a un compte Neon Auth (voir server/neon-auth.ts). Nul tant que
-- l'utilisateur ne s'est jamais connecte avec un jeton du fournisseur ; la
-- connexion par mot de passe continue de fonctionner sans lui. L'index est
-- partiel parce qu'une colonne unique autoriserait un seul compte sans
-- rattachement — c'est-a-dire un seul compte, tout court.
ALTER TABLE users ADD COLUMN IF NOT EXISTS neon_auth_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_neon_auth_sub ON users(neon_auth_sub) WHERE neon_auth_sub IS NOT NULL;
CREATE TABLE IF NOT EXISTS plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL,
 max_users integer, max_workers integer, max_sites integer, features jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_cents integer NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_cycle text NOT NULL DEFAULT 'monthly';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_services integer;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
-- Date de la derniere modification de prix decidee depuis la console.
--
-- Sans cette colonne, le seed ci-dessous ecraserait a chaque demarrage le
-- tarif qu'un operateur vient de changer : il se serait recouche sur la
-- valeur ecrite en dur, et personne n'aurait compris pourquoi. Tant qu'elle
-- est nulle, le forfait suit les valeurs livrees avec le produit ; des
-- qu'un operateur fixe un prix, c'est le sien qui fait foi.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_overridden_at timestamptz;
-- Migration du forfait d'entrée : « free » (0 F) devient « starter » (10 000 F),
-- pour coller à la grille publique. Le renommage se fait AVANT le seed, sinon
-- ON CONFLICT(code) insérerait un doublon en laissant « free » orphelin —
-- or les abonnements existants pointent dessus par plan_id. En renommant,
-- les abonnements en cours suivent sans la moindre réécriture.
UPDATE plans SET code='starter' WHERE code='free';
-- Chaque forfait est payant et ouvre un essai de 14 jours (voir
-- server/entitlements.ts). Prix en centimes : 10 000 F = 1 000 000.
INSERT INTO plans(code,name,description,price_cents,billing_cycle,max_users,max_workers,max_sites,max_services,sort_order,features) VALUES
 ('starter','Starter','Pour les petites stations qui veulent abandonner le cahier de caisse.',1000000,'monthly',2,3,1,10,1,'{"reports.advanced":false,"reports.export":false,"reports.consolidated":false,"audit.read":false,"sites.multiple":false,"stock.manage":false,"team.tracking":false}'::jsonb),
 ('pro','Pro','Pour les stations qui ont plusieurs laveurs et veulent mieux contrôler leurs opérations.',2000000,'monthly',10,20,1,NULL,2,'{"reports.advanced":true,"reports.export":true,"reports.consolidated":false,"audit.read":true,"sites.multiple":false,"stock.manage":true,"team.tracking":true}'::jsonb),
 ('business','Business','Pour les stations importantes ou les propriétaires qui gèrent plusieurs sites.',3500000,'monthly',NULL,NULL,NULL,NULL,3,'{"reports.advanced":true,"reports.export":true,"reports.consolidated":true,"audit.read":true,"sites.multiple":true,"stock.manage":true,"team.tracking":true}'::jsonb)
ON CONFLICT(code) DO UPDATE SET
 name=EXCLUDED.name, description=EXCLUDED.description,
 -- Un prix fixe depuis la console survit au redemarrage ; les autres suivent
 -- la grille livree avec le produit.
 price_cents=CASE WHEN plans.price_overridden_at IS NULL
                  THEN EXCLUDED.price_cents ELSE plans.price_cents END,
 billing_cycle=EXCLUDED.billing_cycle, max_users=EXCLUDED.max_users, max_workers=EXCLUDED.max_workers,
 max_sites=EXCLUDED.max_sites, max_services=EXCLUDED.max_services, sort_order=EXCLUDED.sort_order,
 features=EXCLUDED.features;
CREATE TABLE IF NOT EXISTS subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
 plan_id uuid NOT NULL REFERENCES plans(id), status text NOT NULL DEFAULT 'trialing',
 current_period_end timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_changed_at timestamptz;
UPDATE subscriptions SET plan_changed_at = created_at WHERE plan_changed_at IS NULL;
CREATE TABLE IF NOT EXISTS organization_members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL DEFAULT 'cashier',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, organization_id)
);
CREATE TABLE IF NOT EXISTS sites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, city text NOT NULL, address text, phone text, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS slug text;
CREATE TABLE IF NOT EXISTS onboarding_progress (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id), current_stage text NOT NULL DEFAULT 'station',
  station_data jsonb, services_data jsonb, workers_data jsonb, plan_code text, draft boolean NOT NULL DEFAULT false,
  completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category text NOT NULL, name text NOT NULL,
  price_cents integer, sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true
);
-- Durée et description : l'assistant créait des prestations sans durée, donc
-- tous les lavages recevaient la même heure de fin estimée, quel que soit le
-- service choisi. Ces deux colonnes viennent du catalogue et suivent la
-- prestation jusqu'à la station.
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS description text;
-- Le catalogue de référence ne doit pas se dupliquer à chaque démarrage.
-- Sans contrainte d'unicité, l'ancien « ON CONFLICT DO NOTHING » ne pouvait
-- jamais entrer en conflit : neuf lignes s'ajoutaient à chaque initialisation,
-- et l'assistant d'onboarding affichait le même lavage plusieurs fois.
-- Le nettoyage précède l'index : créer l'index sur une table déjà dupliquée
-- échouerait, et il faut bien garder une ligne par prestation.
DELETE FROM service_catalog a USING service_catalog b
 WHERE a.category = b.category AND a.name = b.name AND a.ctid > b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_category_name_unique
  ON service_catalog(category, name);
-- Les prestations du catalogue sont semées par seedServiceCatalog (voir plus
-- bas) : une seule liste, en TypeScript, partagée avec l'assistant et la
-- démonstration.
CREATE TABLE IF NOT EXISTS service_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS vehicle_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
-- Famille et rang d'affichage.
--
-- La catégorie reste l'unité que l'on choisit à la caisse, mais c'est la
-- FAMILLE qui porte le tarif : une station saisit neuf prix (« motos »,
-- « SUV », « poids lourds »…) et non soixante et un. Sans cette colonne, le
-- catalogue serait plat et la tarification différenciée ingérable.
-- Les codes de famille viennent de src/config/vehicle-taxonomy.ts ; la
-- colonne reste du texte libre pour qu'une station puisse ranger ses propres
-- catégories dans une famille connue sans migration.
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS family text;
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
-- La table jumelle service_categories avait updated_at, pas celle-ci :
-- l'API renvoyait created_at AS updated_at, c'est-à-dire une date fausse.
ALTER TABLE vehicle_categories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- Rétro-remplissage des catégories déjà en base (Berline, SUV / 4x4, Moto…).
-- L'ordre des règles compte : « Berline compacte » doit rester une berline,
-- et « SUV électrique » doit basculer côté électrique, pas côté SUV. On
-- n'écrit que sur les lignes sans famille : une famille choisie à la main
-- n'est jamais réécrite au démarrage.
UPDATE vehicle_categories SET family = CASE
  WHEN lower(name) ~ '(électrique|electrique|hybride)' THEN 'electriques'
  WHEN lower(name) ~ '(moto|scooter|cyclomoteur|tricycle|quad|deux-roues|deux roues)' THEN 'deux_roues'
  WHEN lower(name) ~ '(berline|break|monospace)' THEN 'berlines'
  WHEN lower(name) ~ '(citadine|mini|coupé|coupe|cabriolet|compacte)' THEN 'petites_voitures'
  WHEN lower(name) ~ '(suv|crossover|4x4|tout-terrain|tout terrain|pick-up|pick up)' THEN 'suv'
  WHEN lower(name) ~ '(fourgon|utilitaire|fourgonnette)' THEN 'utilitaires'
  WHEN lower(name) ~ '(camion|semi-remorque|remorque|poids lourd)' THEN 'poids_lourds'
  WHEN lower(name) ~ '(taxi|vtc|minibus|autocar|bus|car)' THEN 'transport_personnes'
  WHEN lower(name) ~ '(tracteur|pelle|chargeuse|chariot|ambulance|blindé|blinde|secours|chantier)' THEN 'speciaux'
  ELSE NULL END
WHERE family IS NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_categories_org_family
  ON vehicle_categories(organization_id, family);
CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  category_id uuid REFERENCES service_categories(id), name text NOT NULL, description text,
  price_cents integer NOT NULL CHECK(price_cents >= 0), duration_minutes integer CHECK(duration_minutes BETWEEN 1 AND 1440),
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE services ADD COLUMN IF NOT EXISTS price_by_vehicle_type jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Le type de service du catalogue choisi dans le formulaire. Le nom de la
-- prestation en découle ; la clé reste stable même si le libellé du
-- catalogue change. Une ligne de catalogue disparue laisse 'template_id'
-- à NULL — jamais un pointeur cassé.
ALTER TABLE services ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES service_catalog(id) ON DELETE SET NULL;
-- Éligibilité et tarif, enfin distincts.
--
-- L'ancien modèle mêlait les deux : 'price_by_vehicle_type' (clés UUID de
-- catégorie ou codes de famille) avec repli sur le prix de base. Une
-- catégorie sans tarif restait donc utilisable — au prix de base — et une
-- clé de famille rendait éligible toute la famille sans que personne ne
-- l'ait décidé. Ici, une ligne = « cette prestation est autorisée pour
-- cette catégorie de véhicule, à ce prix ». Pas de ligne = pas
-- d'utilisation dans un lavage ; aucun repli ne contourne l'interdiction.
--
-- 'price_cents' et 'price_by_vehicle_type' restent en place (affichage,
-- compatibilité) mais ne décident plus de l'éligibilité.
CREATE TABLE IF NOT EXISTS service_vehicle_prices (
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  vehicle_category_id uuid NOT NULL REFERENCES vehicle_categories(id) ON DELETE CASCADE,
  price_cents integer NOT NULL CHECK(price_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_id, vehicle_category_id)
);
CREATE INDEX IF NOT EXISTS idx_service_vehicle_prices_category
  ON service_vehicle_prices(vehicle_category_id);
CREATE TABLE IF NOT EXISTS workers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid REFERENCES sites(id), first_name text NOT NULL, last_name text NOT NULL, phone text,
 role text NOT NULL DEFAULT 'car_washer', custom_role text, status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS district text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS joined_at date;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS photo_url text;

-- Presences et horaires (module Equipes).
--
-- Les heures sont stockees en timestamptz. La Cote d'Ivoire est a UTC+0 toute
-- l'annee, sans heure d'ete : l'heure locale d'une station et l'heure UTC
-- coincident, et la minute du jour se derive sans conversion. Une station
-- hors de ce fuseau demanderait de porter le fuseau sur la station.
CREATE TABLE IF NOT EXISTS work_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid REFERENCES sites(id),
 -- NULL : l'horaire vaut pour toute la station. Renseigne : il ne vaut que
 -- pour cette personne et prime sur celui de la station.
 worker_id uuid REFERENCES workers(id),
 -- NULL : tous les jours. 0 = dimanche, conformement a EXTRACT(DOW).
 day_of_week smallint CHECK(day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6)),
 -- Exception ponctuelle, qui prime sur le jour de la semaine.
 specific_date date,
 start_minute smallint NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
 end_minute smallint NOT NULL CHECK(end_minute BETWEEN 0 AND 1439),
 break_duration_minutes smallint NOT NULL DEFAULT 0 CHECK(break_duration_minutes >= 0),
 late_tolerance_minutes smallint NOT NULL DEFAULT 15 CHECK(late_tolerance_minutes >= 0),
 valid_from date NOT NULL DEFAULT CURRENT_DATE, valid_to date,
 created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_schedules_org_idx ON work_schedules(organization_id, site_id, worker_id);

CREATE TABLE IF NOT EXISTS attendance_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid REFERENCES sites(id), worker_id uuid NOT NULL REFERENCES workers(id),
 work_date date NOT NULL,
 check_in_at timestamptz, check_out_at timestamptz,
 -- Pause reellement relevee, et non pause prevue par l'horaire : on ne
 -- retranche pas du temps de travail sur la foi d'un parametre.
 break_minutes smallint CHECK(break_minutes IS NULL OR break_minutes >= 0),
 status text NOT NULL DEFAULT 'present',
 absence_reason text, comment text,
 recorded_by uuid REFERENCES users(id),
 corrected_by uuid REFERENCES users(id), corrected_at timestamptz, correction_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 -- Un seul releve par personne et par jour. Une station qui ferait deux
 -- vacations dans la meme journee demanderait d'ajouter une plage a la cle ;
 -- le besoin n'existe pas et la contrainte protege des doublons de saisie.
 UNIQUE(worker_id, work_date)
);
ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check
 CHECK(status IN ('present','absent_declared','absent_justified','absent_unjustified','leave'));
CREATE INDEX IF NOT EXISTS attendance_records_org_date_idx ON attendance_records(organization_id, work_date DESC);

CREATE TABLE IF NOT EXISTS customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 full_name text NOT NULL, phone text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS washes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid NOT NULL REFERENCES sites(id), vehicle_category_id uuid REFERENCES vehicle_categories(id),
 customer_id uuid REFERENCES customers(id), status text NOT NULL DEFAULT 'completed',
 total_cents integer NOT NULL CHECK(total_cents >= 0), payment_method text NOT NULL DEFAULT 'cash',
 created_by uuid REFERENCES users(id), cancelled_at timestamptz, cancellation_reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE washes ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE washes ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending';
ALTER TABLE washes ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id);
-- Avancement operationnel du lavage.
--
-- La colonne status reste le statut COMPTABLE : un lavage est enregistre quand
-- il est rendu, il est donc ne "completed" des sa creation, et les rapports,
-- le rendement et les encaissements s'appuient sur cette valeur. La changer
-- viderait les rapports d'une station entiere le jour ou elle commence a
-- enregistrer des lavages "en attente".
--
-- operation_status suit, lui, l'avancement PHYSIQUE de l'operation :
--   pending     -> en attente : le lavage est enregistre, la voiture attend
--   in_progress -> en cours   : le laveur a commence
--   completed   -> termine    : la voiture est prete
--
-- Le defaut est "completed" : les lavages deja enregistres sont termines, et
-- une migration ne doit pas les faire repasser "en attente". Seuls les
-- nouveaux lavages naissent explicitement en "pending".
ALTER TABLE washes ADD COLUMN IF NOT EXISTS operation_status text NOT NULL DEFAULT 'completed';
ALTER TABLE washes DROP CONSTRAINT IF EXISTS washes_operation_status_check;
ALTER TABLE washes ADD CONSTRAINT washes_operation_status_check
  CHECK(operation_status IN ('pending','in_progress','completed','overtime'));
ALTER TABLE washes ADD COLUMN IF NOT EXISTS queue_position integer;
ALTER TABLE washes ADD COLUMN IF NOT EXISTS completed_at timestamptz;
-- Depart du decompte.
--
-- Le decompte du temps de lavage commence quand quelqu'un clique sur la tache
-- a l'ecran : la colonne note cet instant, et l'ecran ne fait que le
-- recomparer a l'heure de l'horloge. Elle est donc remise a zero quand la
-- tache repasse en attente, et elle n'est jamais devinee.
ALTER TABLE washes ADD COLUMN IF NOT EXISTS operation_started_at timestamptz;
-- Duree estimee du lavage, en minutes.
--
-- C'est la somme des durees des prestations choisies au moment de
-- l'enregistrement. Elle est figee a l'ecriture, parce qu'une duree qui change
-- sous les pieds du compteur fait sauter la barre de progression : le
-- laveur verrait son temps restant changer sans qu'il ait rien demande.
ALTER TABLE washes ADD COLUMN IF NOT EXISTS estimated_minutes integer;
-- Nom du client, saisi au comptoir.
--
-- Une etiquette, et rien d'autre : ni telephone, ni historique, ni fiche. Le
-- produit ne tient pas de fichier client ; il note ce que le client veut
-- etre appele pendant que sa voiture est dans la station.
ALTER TABLE washes ADD COLUMN IF NOT EXISTS customer_name text;
-- Plaque du vehicule lave.
--
-- Le produit ne tient pas de fichier client : c'est la plaque, et elle seule,
-- qui permet de reconnaitre un vehicule qui revient. Deux colonnes : la forme
-- affichee, proche de ce qui a ete tape, et la cle reduite aux lettres et aux
-- chiffres, qui sert a regrouper. Sans elle, " 1234 ab 01 " et "1234-AB-01"
-- seraient deux vehicules differents.
ALTER TABLE washes ADD COLUMN IF NOT EXISTS plate text;
ALTER TABLE washes ADD COLUMN IF NOT EXISTS plate_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_washes_org_reference ON washes(organization_id,reference);
CREATE INDEX IF NOT EXISTS idx_washes_org_plate ON washes(organization_id,plate_key,created_at DESC);
CREATE TABLE IF NOT EXISTS wash_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), wash_id uuid NOT NULL REFERENCES washes(id),
 service_id uuid REFERENCES services(id), service_name text NOT NULL, quantity integer NOT NULL CHECK(quantity > 0),
 unit_price_cents integer NOT NULL CHECK(unit_price_cents >= 0), line_total_cents integer NOT NULL CHECK(line_total_cents >= 0)
);
-- Emissions de recu.
--
-- Une ligne par impression, pas une par lavage : c'est le nombre de copies
-- qui compte. Un recu est une preuve de paiement, et deux papiers
-- indiscernables pour un seul versement permettent de justifier deux fois la
-- meme somme. La copie n.2 et les suivantes portent la mention DUPLICATA.
CREATE TABLE IF NOT EXISTS receipt_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 wash_id uuid NOT NULL REFERENCES washes(id),
 copy_number integer NOT NULL CHECK(copy_number > 0),
 issued_by uuid REFERENCES users(id),
 issued_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(wash_id, copy_number)
);
CREATE INDEX IF NOT EXISTS receipt_issues_wash_idx ON receipt_issues(wash_id, copy_number DESC);

-- Notifications persistées
CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid REFERENCES users(id),
 site_id uuid REFERENCES sites(id),
 type text NOT NULL,
 title text NOT NULL,
 message text NOT NULL,
 entity_type text,
 entity_id uuid,
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_org_user_created ON notifications(organization_id, user_id, created_at DESC);

-- ------------------------------------------------------------------ stock --
-- Regle structurelle : il n'existe NULLE PART une colonne « quantite en
-- stock ». Le stock d'un produit est toujours la somme des mouvements qui le
-- concernent. Aucune ecriture directe n'est donc possible, ni par l'API, ni
-- par une requete manuelle distraite : pour changer un stock il faut laisser
-- une trace datee, signee et motivee.
CREATE TABLE IF NOT EXISTS product_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 category_id uuid REFERENCES product_categories(id),
 name text NOT NULL,
 -- Unite de mesure affichee. Les quantites sont stockees en milliemes de
 -- cette unite (1 litre = 1000), pour la meme raison que l'argent est stocke
 -- en centimes : un entier exact plutot qu'un flottant approximatif.
 unit text NOT NULL DEFAULT 'unite' CHECK(unit IN ('unite','litre','kilogramme')),
 unit_cost_cents integer NOT NULL DEFAULT 0 CHECK(unit_cost_cents >= 0),
 low_stock_threshold_milli integer NOT NULL DEFAULT 0 CHECK(low_stock_threshold_milli >= 0),
 is_active boolean NOT NULL DEFAULT true,
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
-- Date du dernier realignement du cout de reference sur un prix reellement
-- paye. Sert a dire a l'ecran d'ou vient le chiffre : un cout saisi a la main
-- il y a six mois et un cout confirme par l'achat de mardi ne meritent pas la
-- meme confiance.
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_cost_updated_at timestamptz;
CREATE TABLE IF NOT EXISTS stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 product_id uuid NOT NULL REFERENCES products(id), site_id uuid REFERENCES sites(id),
 -- initial   : stock d'ouverture a la creation du produit
 -- entry     : entree manuelle (correction, retour)
 -- exit      : sortie manuelle (consommation, perte, casse)
 -- inventory : ecart constate lors d'un comptage physique
 -- reversal  : contrepassation d'un mouvement precedent
 kind text NOT NULL CHECK(kind IN ('initial','entry','exit','inventory','reversal')),
 -- Signe : positif pour une entree, negatif pour une sortie. Jamais zero,
 -- un mouvement nul n'aurait rien a dire.
 quantity_milli integer NOT NULL CHECK(quantity_milli <> 0),
 -- Instantane du cout unitaire au moment du mouvement, exactement comme
 -- wash_items fige le prix d'une prestation. Changer le cout d'un produit
 -- demain ne doit pas reecrire la valeur des sorties d'hier.
 unit_cost_cents integer NOT NULL DEFAULT 0 CHECK(unit_cost_cents >= 0),
 reason text, reference text,
 reverses_movement_id uuid REFERENCES stock_movements(id),
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements(organization_id, product_id, created_at DESC);
-- Un mouvement ne peut etre contrepasse qu'une seule fois.
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_reversal_idx ON stock_movements(reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;

-- En Cote d'Ivoire les stations achetent de la lessive en sachets : l'unite
-- reelle de comptage est le sachet, pas le litre. Les contraintes posees a la
-- creation des tables sont elargies ici, pour que les bases deja en service
-- soient migrees au demarrage au lieu de refuser les nouvelles valeurs.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_unit_check;
ALTER TABLE products ADD CONSTRAINT products_unit_check
  CHECK (unit IN ('unite','sachet','litre','kilogramme'));

-- Genre << consumption >> : sortie automatique declenchee par l'enregistrement d'un
-- lavage. Elle se distingue d'une sortie manuelle parce qu'elle n'est jamais
-- refusee : le produit a reellement ete utilise.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('initial','entry','exit','inventory','reversal','consumption'));

-- Ce qu'une prestation consomme. C'est une recette : << un lavage complet
-- utilise 2 sachets d'Omo >>. Elle ne touche pas au prix du service, qui
-- reste fixe a la main dans la fiche de prestation.
CREATE TABLE IF NOT EXISTS service_consumables (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 service_id uuid NOT NULL REFERENCES services(id), product_id uuid NOT NULL REFERENCES products(id),
 quantity_milli integer NOT NULL CHECK(quantity_milli > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(service_id, product_id)
);
CREATE INDEX IF NOT EXISTS service_consumables_service_idx ON service_consumables(organization_id, service_id);
-- Rattache un mouvement au lavage qui l'a provoque : indispensable pour
-- contrepasser exactement ce qui a ete deduit quand le lavage est annule.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS wash_id uuid REFERENCES washes(id);
CREATE INDEX IF NOT EXISTS stock_movements_wash_idx ON stock_movements(wash_id) WHERE wash_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wash_assignments (
 wash_id uuid NOT NULL REFERENCES washes(id), worker_id uuid NOT NULL REFERENCES workers(id), PRIMARY KEY(wash_id,worker_id)
);
-- La table d'affectation existait deja : on l'etend plutot que d'en creer une
-- seconde. Les colonnes ont une valeur par defaut, donc les affectations
-- deja enregistrees restent valides et deviennent des participations.
ALTER TABLE wash_assignments ADD COLUMN IF NOT EXISTS assignment_role text NOT NULL DEFAULT 'participant';
ALTER TABLE wash_assignments ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE wash_assignments ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES users(id);
ALTER TABLE wash_assignments DROP CONSTRAINT IF EXISTS wash_assignments_role_check;
ALTER TABLE wash_assignments ADD CONSTRAINT wash_assignments_role_check
 CHECK(assignment_role IN ('principal','participant'));
-- Un lavage n'a qu'un responsable principal, ou aucun.
CREATE UNIQUE INDEX IF NOT EXISTS wash_assignments_principal_idx
 ON wash_assignments(wash_id) WHERE assignment_role = 'principal';
CREATE TABLE IF NOT EXISTS payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 wash_id uuid NOT NULL REFERENCES washes(id), method text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents >= 0),
 status text NOT NULL DEFAULT 'completed', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference text;
CREATE TABLE IF NOT EXISTS cash_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid NOT NULL REFERENCES sites(id), opened_by uuid REFERENCES users(id), closed_by uuid REFERENCES users(id),
 opening_amount_cents integer NOT NULL CHECK(opening_amount_cents >= 0), closing_amount_cents integer,
 expected_amount_cents integer, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS discrepancy_reason text;
CREATE TABLE IF NOT EXISTS cash_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 cash_session_id uuid NOT NULL REFERENCES cash_sessions(id), type text NOT NULL CHECK(type IN ('entry','exit')),
 amount_cents integer NOT NULL CHECK(amount_cents > 0), source text NOT NULL, description text,
 wash_id uuid REFERENCES washes(id), created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
-- Pas de table « expense_categories » : la liste des catégories de dépense est
-- un vocabulaire fermé, porté par le code (EXPENSE_CATEGORIES, côté serveur et
-- côté interface). C'est délibéré : les rapports agrègent les dépenses par
-- catégorie, et une liste libre par station rendrait ces totaux incomparables
-- d'une station à l'autre. La table existait sans être ni écrite ni lue ; la
-- garder aurait laissé croire à un référentiel modifiable qui n'existait pas.
CREATE TABLE IF NOT EXISTS expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid NOT NULL REFERENCES sites(id), category text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents > 0),
 payment_method text NOT NULL, cash_session_id uuid REFERENCES cash_sessions(id), description text,
 status text NOT NULL DEFAULT 'completed', created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE expenses ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS beneficiary text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_date date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS expense_id uuid REFERENCES expenses(id);

-- Fournisseurs et achats (L5).
CREATE TABLE IF NOT EXISTS suppliers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, phone text, contact_name text, notes text,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
CREATE TABLE IF NOT EXISTS purchases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 site_id uuid REFERENCES sites(id), supplier_id uuid REFERENCES suppliers(id),
 reference text NOT NULL, invoice_reference text,
 purchase_date date NOT NULL DEFAULT CURRENT_DATE,
 total_cents integer NOT NULL CHECK(total_cents >= 0),
 payment_method text NOT NULL, cash_session_id uuid REFERENCES cash_sessions(id),
 status text NOT NULL DEFAULT 'received',
 cancelled_at timestamptz, cancellation_reason text, cancelled_by uuid REFERENCES users(id),
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,reference)
);
CREATE INDEX IF NOT EXISTS purchases_org_date_idx ON purchases(organization_id, purchase_date DESC);
-- La colonne porte le mot « recu » et non « commande » : c'est la regle du
-- metier inscrite dans le schema. Seul ce qui est entre dans le magasin
-- augmente le stock, jamais ce qui a ete commande.
CREATE TABLE IF NOT EXISTS purchase_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 purchase_id uuid NOT NULL REFERENCES purchases(id), product_id uuid NOT NULL REFERENCES products(id),
 product_name_snapshot text NOT NULL,
 received_milli integer NOT NULL CHECK(received_milli > 0),
 unit_cost_cents integer NOT NULL CHECK(unit_cost_cents >= 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON purchase_items(purchase_id);
-- Rattache l'entree de stock a l'achat qui l'a provoquee, exactement comme
-- wash_id rattache une sortie au lavage : meme lecture dans les deux sens.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS purchase_id uuid REFERENCES purchases(id);
CREATE INDEX IF NOT EXISTS stock_movements_purchase_idx ON stock_movements(purchase_id) WHERE purchase_id IS NOT NULL;
-- Un achat produit UNE depense et une seule. Ce lien est ce qui rend le
-- double comptage impossible : la depense n'est pas ressaisie a la main.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS purchase_id uuid REFERENCES purchases(id);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_purchase_unique ON expenses(purchase_id) WHERE purchase_id IS NOT NULL;

-- Compteurs d'eau et d'électricité : un CIE et un SODECI maximum par site.
-- Les index sont stockés en millièmes d'unité (kWh ou m³) pour conserver
-- exactement les relevés décimaux, sans jamais estimer un tarif fournisseur.
CREATE TABLE IF NOT EXISTS utility_meters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('cie','sodeci')),
 meter_number text NOT NULL,
 is_active boolean NOT NULL DEFAULT true,
 created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id, provider)
);
CREATE INDEX IF NOT EXISTS utility_meters_org_idx ON utility_meters(organization_id, site_id, provider);

CREATE TABLE IF NOT EXISTS utility_readings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 meter_id uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
 reading_date date NOT NULL,
 index_milli bigint NOT NULL CHECK (index_milli >= 0),
 notes text,
 anomaly_comment text,
 created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(meter_id, reading_date)
);
CREATE INDEX IF NOT EXISTS utility_readings_org_date_idx ON utility_readings(organization_id, reading_date DESC);
CREATE INDEX IF NOT EXISTS utility_readings_meter_date_idx ON utility_readings(meter_id, reading_date DESC);
ALTER TABLE utility_readings ADD COLUMN IF NOT EXISTS cash_session_id uuid REFERENCES cash_sessions(id);
ALTER TABLE utility_readings ADD COLUMN IF NOT EXISTS anomaly_comment text;
CREATE INDEX IF NOT EXISTS utility_readings_cash_session_idx ON utility_readings(cash_session_id) WHERE cash_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS utility_readings_id_org_key ON utility_readings(id, organization_id);

-- Le binaire reste hors des listes de relevés. La clé étrangère composée
-- garantit qu'une photo ne peut pas viser le relevé d'une autre organisation.
CREATE TABLE IF NOT EXISTS utility_reading_photos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 reading_id uuid NOT NULL UNIQUE,
 mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/webp')),
 byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 300000),
 photo_data bytea NOT NULL,
 created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (reading_id, organization_id) REFERENCES utility_readings(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS utility_reading_photos_org_idx ON utility_reading_photos(organization_id, created_at DESC);

-- La facture réelle devient une dépense « utilities ». Ce lien unique empêche
-- qu'un même relevé facturé soit comptabilisé deux fois, même en cas de rejeu.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS utility_reading_id uuid;
DO $$ BEGIN
 ALTER TABLE expenses ADD CONSTRAINT expenses_utility_reading_fk
  FOREIGN KEY (utility_reading_id) REFERENCES utility_readings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS expenses_utility_reading_unique
 ON expenses(utility_reading_id) WHERE utility_reading_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 key text NOT NULL, fingerprint text NOT NULL, response_status integer, response_body jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,key)
);
-- Désactivation d'un membre sans suppression du compte : ses requêtes
-- protégées sont refusées dès le middleware d'appartenance.
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id);

-- Exceptions de permissions accordées (ou retirées) par le propriétaire à un
-- membre précis : granted = false retire une permission venant du rôle.
CREATE TABLE IF NOT EXISTS member_permissions (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id),
 permission text NOT NULL,
 granted boolean NOT NULL DEFAULT true,
 granted_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, user_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_member_permissions_user ON member_permissions(organization_id,user_id);

-- Relances d'échéance d'abonnement : une ligne par relance réellement envoyée,
-- ce qui garantit qu'une même station n'est jamais relancée deux fois.
CREATE TABLE IF NOT EXISTS subscription_reminders (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 kind text NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, kind)
);
-- Intentions de paiement d'abonnement.
--
-- Une ligne est creee des que le client declare vouloir payer, AVANT tout
-- encaissement. Elle sert de point de rendez-vous entre trois acteurs qui ne
-- se parlent pas : le client qui paie sur son telephone, l'agregateur qui
-- confirme par webhook, et l'editeur qui valide a la main quand il n'y a pas
-- d'agregateur.
--
-- La colonne reference est UNIQUE : c'est elle qui rend l'encaissement
-- idempotent. Un
-- webhook rejoue deux fois (retransmission reseau, chose courante ici) ne
-- doit jamais activer deux mois au lieu d'un.
CREATE TABLE IF NOT EXISTS payment_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 reference text NOT NULL UNIQUE,
 plan_code text NOT NULL,
 months integer NOT NULL DEFAULT 1,
 amount_cents integer NOT NULL,
 provider text NOT NULL DEFAULT 'manual',
 status text NOT NULL DEFAULT 'pending',
 provider_transaction_id text,
 declared_reference text,
 declared_at timestamptz,
 created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 settled_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS payment_intents_org_idx ON payment_intents(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_intents_status_idx ON payment_intents(status, created_at DESC);

-- Registre des encaissements d'abonnement : la seule source de verite du
-- chiffre d'affaires. Toute activation y ecrit une ligne, quel que soit son
-- chemin -- parcours client, saisie console, futur webhook -- parce que
-- 'activateSubscription()' est le point de passage unique.
--
-- Pourquoi une table a part plutot que 'payment_intents' : une intention est
-- une *demande de payer*, qui peut echouer ou rester en attente. Le registre
-- n'accueille que de l'argent recu. Les compter ensemble ferait apparaitre
-- dans le chiffre d'affaires des paiements jamais arrives.
--
-- 'organization_id' est volontairement sans cle etrangere et nullable :
-- l'ecriture comptable doit survivre a la suppression de la station, sinon
-- purger un client ferait disparaitre le chiffre d'affaires deja encaisse.
-- 'organization_name' en conserve une copie lisible.
CREATE TABLE IF NOT EXISTS subscription_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid,
 organization_name text NOT NULL,
 plan_code text NOT NULL,
 plan_name text NOT NULL,
 -- Negatif pour une annulation : on contrepasse, on ne supprime pas.
 amount_cents bigint NOT NULL,
 months integer NOT NULL,
 -- Periode couverte par l'encaissement : c'est elle qui permet d'etaler le
 -- revenu reconnu mois par mois, independamment de la date d'encaissement.
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 channel text NOT NULL DEFAULT 'other',
 payment_reference text,
 payment_intent_id uuid,
 source text NOT NULL,
 operator_email text,
 actor_user_id uuid,
 note text,
 -- Contrepassation : 'reverses_id' pointe la ligne annulee.
 reverses_id uuid REFERENCES subscription_payments(id) ON DELETE SET NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_payments_when_idx ON subscription_payments(occurred_at DESC);
CREATE INDEX IF NOT EXISTS subscription_payments_org_idx ON subscription_payments(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS subscription_payments_period_idx ON subscription_payments(period_start, period_end);

-- Demandes d'assistance.
--
-- Jusqu'ici une demande d'aide etait un message WhatsApp : aucune trace, donc
-- aucun moyen de savoir combien de demandes sont ouvertes, depuis quand, ni
-- si l'engagement de delai a ete tenu. WhatsApp reste le canal de discussion ;
-- cette table lui donne une memoire.
CREATE TABLE IF NOT EXISTS support_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 subject text NOT NULL,
 category text NOT NULL DEFAULT 'autre',
 status text NOT NULL DEFAULT 'open',
 -- Forfait au moment de la demande, fige volontairement : l'engagement a ete
 -- pris sous ce forfait. Si le client retrograde ensuite, la promesse tient.
 plan_code text,
 commitment_hours integer NOT NULL,
 response_due_at timestamptz NOT NULL,
 first_responded_at timestamptz,
 resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- La file de la console : les demandes ouvertes, la plus urgente d'abord.
CREATE INDEX IF NOT EXISTS support_requests_queue_idx ON support_requests(status, response_due_at);
CREATE INDEX IF NOT EXISTS support_requests_org_idx ON support_requests(organization_id, created_at DESC);

-- Messages d'un fil d'assistance.
--
-- 'internal' marque une note que le client ne doit jamais voir. Aucune
-- contrainte CHECK ici : 'ON DELETE SET NULL' sur l'auteur declencherait une
-- revalidation et ferait echouer la suppression du compte.
CREATE TABLE IF NOT EXISTS support_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 author_operator_email text,
 internal boolean NOT NULL DEFAULT false,
 body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON support_messages(request_id, created_at);

-- Supervision : compteurs agreges de toutes les requetes.
--
-- Agreger par tranche de cinq minutes plutot qu'echantillonner donne des taux
-- exacts pour un volume borne par le nombre de routes, et non par le trafic.
-- C'est la normalisation des chemins (voir normalizeRoute) qui rend cette
-- borne possible : sans elle, chaque identifiant creerait sa propre ligne.
CREATE TABLE IF NOT EXISTS request_metrics (
 bucket_start timestamptz NOT NULL,
 method text NOT NULL,
 route text NOT NULL,
 status_class text NOT NULL,
 requests bigint NOT NULL DEFAULT 0,
 total_duration_ms bigint NOT NULL DEFAULT 0,
 max_duration_ms integer NOT NULL DEFAULT 0,
 slow_requests integer NOT NULL DEFAULT 0,
 PRIMARY KEY (bucket_start, method, route, status_class)
);
CREATE INDEX IF NOT EXISTS request_metrics_when_idx ON request_metrics(bucket_start DESC);

-- Supervision : detail des pannes et des lenteurs.
--
-- 'request_body' est masque avant ecriture (voir redactBody) : aucun mot de
-- passe n'y entre jamais. Le reste du corps est conserve, parce que c'est ce
-- qui permet de reproduire un bug a l'identique.
--
-- Pas de cle etrangere sur organization_id : l'ecriture a lieu dans le
-- gestionnaire d'erreurs, ou une contrainte qui echoue ferait perdre la trace
-- de l'incident qu'on essaie justement d'enregistrer. La purge d'une station
-- supprime ses lignes (voir PURGE_ORDER).
CREATE TABLE IF NOT EXISTS error_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL DEFAULT 'error',
 method text NOT NULL,
 route text NOT NULL,
 path text NOT NULL,
 status integer NOT NULL,
 code text NOT NULL,
 message text NOT NULL,
 stack text,
 duration_ms integer NOT NULL DEFAULT 0,
 organization_id uuid,
 user_id uuid,
 operator_email text,
 request_body jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_events_when_idx ON error_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_events_route_idx ON error_events(route, occurred_at DESC);
CREATE INDEX IF NOT EXISTS error_events_org_idx ON error_events(organization_id, occurred_at DESC);
-- Une ligne ne peut etre contrepassee qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_reverses_idx
 ON subscription_payments(reverses_id) WHERE reverses_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Console de l'éditeur
--
-- Les comptes d'administration ne sont PAS des lignes de 'users'. C'était le
-- cas avant : un drapeau 'platform_admin' posé sur un compte de station. Ce
-- modèle liait l'administration du parc à l'exploitation d'un lavage — une
-- session de station ouvrait le back-office, et le compte de l'éditeur
-- traînait dans la liste des membres d'une organisation.
--
-- Deux tables séparées, donc, avec leurs propres sessions : aucune session de
-- station ne peut ouvrir la console, et aucune session de console ne peut
-- écrire dans une station par les routes ordinaires.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_operators (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL UNIQUE, password_hash text, full_name text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'active',
 role text NOT NULL DEFAULT 'admin',
 managed_by text NOT NULL DEFAULT 'bootstrap',
 last_login_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Les comptes historiques deviennent administrateurs : ils avaient déjà tous
-- les droits. Les comptes créés depuis la Console sont marqués « console »
-- pour ne pas être désactivés par la prochaine synchro PLATFORM_ADMIN_EMAILS.
ALTER TABLE platform_operators ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin';
ALTER TABLE platform_operators ADD COLUMN IF NOT EXISTS managed_by text NOT NULL DEFAULT 'bootstrap';
ALTER TABLE platform_operators DROP CONSTRAINT IF EXISTS platform_operators_role_check;
ALTER TABLE platform_operators ADD CONSTRAINT platform_operators_role_check CHECK(role IN ('admin','supervisor','support'));
ALTER TABLE platform_operators DROP CONSTRAINT IF EXISTS platform_operators_managed_by_check;
ALTER TABLE platform_operators ADD CONSTRAINT platform_operators_managed_by_check CHECK(managed_by IN ('bootstrap','console'));
CREATE TABLE IF NOT EXISTS platform_operator_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operator_id uuid NOT NULL REFERENCES platform_operators(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_operator_sessions_op_idx ON platform_operator_sessions(operator_id);

-- Journal de la console. Distinct de 'audit_logs', qui appartient au client.
--
-- Les deux sont alimentés : le client doit voir chez lui qu'on a touché à son
-- forfait (pas de porte dérobée), et l'éditeur doit pouvoir relire ses propres
-- actions sans parcourir les journaux de trois cents stations. Celui-ci
-- survit à la purge d'une organisation : c'est la trace qu'elle a existé.
CREATE TABLE IF NOT EXISTS platform_audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operator_id uuid REFERENCES platform_operators(id) ON DELETE SET NULL,
 operator_email text NOT NULL, action text NOT NULL,
 organization_id uuid, organization_name text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_logs_created_idx ON platform_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_logs_org_idx ON platform_audit_logs(organization_id, created_at DESC);

-- Alertes proactives de supervision. Les secrets Resend / WhatsApp restent
-- dans l'environnement ; la Console ne règle que les seuils et destinataires.
CREATE TABLE IF NOT EXISTS platform_alert_settings (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id = 1),
 enabled boolean NOT NULL DEFAULT false,
 error_rate_percent numeric(6,2) NOT NULL DEFAULT 5,
 min_requests integer NOT NULL DEFAULT 20,
 slow_request_count integer NOT NULL DEFAULT 5,
 window_minutes integer NOT NULL DEFAULT 15,
 cooldown_minutes integer NOT NULL DEFAULT 60,
 email_recipients text[] NOT NULL DEFAULT '{}',
 whatsapp_recipients text[] NOT NULL DEFAULT '{}',
 updated_by uuid REFERENCES platform_operators(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_alert_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_alert_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 fingerprint text NOT NULL,
 kind text NOT NULL,
 severity text NOT NULL,
 title text NOT NULL,
 message text NOT NULL,
 metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
 deliveries jsonb NOT NULL DEFAULT '[]'::jsonb,
 triggered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_alert_events_fingerprint_idx
 ON platform_alert_events(fingerprint, triggered_at DESC);
CREATE INDEX IF NOT EXISTS platform_alert_events_when_idx ON platform_alert_events(triggered_at DESC);

-- Rapprochement avec les relevés d'un agrégateur. Aucun montant comptable
-- n'est réécrit : le moteur rapproche des références et consigne les écarts.
CREATE TABLE IF NOT EXISTS reconciliation_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL,
 source_name text,
 period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'completed',
 total_rows integer NOT NULL DEFAULT 0,
 matched_rows integer NOT NULL DEFAULT 0,
 discrepancy_rows integer NOT NULL DEFAULT 0,
 ignored_rows integer NOT NULL DEFAULT 0,
 created_by uuid REFERENCES platform_operators(id) ON DELETE SET NULL,
 created_by_email text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_batches_when_idx ON reconciliation_batches(created_at DESC);
CREATE TABLE IF NOT EXISTS provider_statement_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES reconciliation_batches(id) ON DELETE CASCADE,
 line_number integer NOT NULL,
 provider_reference text,
 merchant_reference text,
 amount_cents bigint NOT NULL,
 currency text NOT NULL DEFAULT 'XOF',
 provider_status text NOT NULL,
 occurred_at timestamptz,
 raw jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(batch_id, line_number)
);
CREATE INDEX IF NOT EXISTS provider_statement_merchant_idx ON provider_statement_entries(merchant_reference);
CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES reconciliation_batches(id) ON DELETE CASCADE,
 statement_entry_id uuid REFERENCES provider_statement_entries(id) ON DELETE SET NULL,
 payment_id uuid,
 payment_intent_id uuid,
 kind text NOT NULL,
 reference text,
 organization_name text,
 expected_amount_cents bigint,
 actual_amount_cents bigint,
 details text NOT NULL,
 status text NOT NULL DEFAULT 'open',
 resolution_note text,
 resolved_by uuid REFERENCES platform_operators(id) ON DELETE SET NULL,
 resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_discrepancies_open_idx ON reconciliation_discrepancies(status, created_at DESC);
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS reconciliation_batch_id uuid;
CREATE TABLE IF NOT EXISTS reconciliation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 trigger_kind text NOT NULL,
 status text NOT NULL,
 error text,
 batch_id uuid REFERENCES reconciliation_batches(id) ON DELETE SET NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_when_idx ON reconciliation_runs(started_at DESC);


-- Suppression en deux temps.
--
-- 'deletion_requested_at' coupe l'accès immédiatement ; l'effacement physique
-- n'a lieu qu'à 'deletion_scheduled_for'. Entre les deux, le client est
-- restaurable d'un clic. Une suppression décidée sur un malentendu — un
-- paiement cru perdu, un homonyme — reste rattrapable.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deletion_reason text;
CREATE INDEX IF NOT EXISTS organizations_deletion_idx ON organizations(deletion_scheduled_for)
 WHERE deletion_scheduled_for IS NOT NULL;

-- Demandes de cloture emises par le client lui-meme.
--
-- A distinguer de la suppression ci-dessus, qui est une decision de
-- l'editeur et coupe l'acces aussitot. Ici le gerant signale qu'il veut
-- partir : rien ne s'arrete, il continue d'encaisser normalement. C'est
-- l'editeur qui programmera la cloture, ou qui refusera en expliquant
-- pourquoi. Le client peut se raviser tant que personne n'a tranche.
--
-- Une seule demande ouverte a la fois, garantie par l'index partiel plus bas :
-- deux demandes en attente pour la meme station n'auraient aucun sens et
-- feraient apparaitre la station deux fois dans la file de l'editeur.
CREATE TABLE IF NOT EXISTS closure_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
 requested_by_email text NOT NULL,
 reason text NOT NULL,
 status text NOT NULL DEFAULT 'pending'
   CHECK (status IN ('pending','cancelled','accepted','declined')),
 resolution_note text,
 resolved_by_email text,
 resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS closure_requests_one_pending
 ON closure_requests(organization_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS closure_requests_feed_idx
 ON closure_requests(status, created_at DESC);
CREATE TABLE IF NOT EXISTS clerk_webhook_events (
 id text PRIMARY KEY, event_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid REFERENCES organizations(id),
 actor_user_id uuid REFERENCES users(id), action text NOT NULL, entity_type text NOT NULL, entity_id text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(organization_id);
CREATE INDEX IF NOT EXISTS idx_services_org ON services(organization_id);
CREATE INDEX IF NOT EXISTS idx_washes_org_created ON washes(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_org_created ON expenses(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workers_org_status ON workers(organization_id,status);
CREATE INDEX IF NOT EXISTS idx_payments_org_created ON payments(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_org_status ON payments(organization_id,status);
CREATE INDEX IF NOT EXISTS idx_payments_wash ON payments(wash_id);
CREATE INDEX IF NOT EXISTS idx_wash_assignments_worker ON wash_assignments(worker_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_org_site ON cash_sessions(organization_id,site_id,status);
CREATE INDEX IF NOT EXISTS idx_wash_items_wash ON wash_items(wash_id);
-- Authentification maison (e-mail + mot de passe, sessions en base) ---------
DO $do$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
EXCEPTION WHEN others THEN
  RAISE NOTICE 'idx_users_email_lower non créé (e-mails en double existants)';
END $do$;
CREATE TABLE IF NOT EXISTS auth_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
-- Réinitialisation de mot de passe : seul le SHA-256 du jeton est stocké, ------
-- le jeton en clair ne vit que dans le lien envoyé par e-mail. ----------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 requested_ip text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);
` + rlsSchemaSql();

/**
 * Jeu de démonstration (station, équipe, lavages, caisse).
 *
 * **Jamais en production.** Ces quatre comptes partagent un mot de passe
 * public (`WashPilot2026!`) qui a longtemps été affiché sur la page de
 * connexion : sur un déploiement neuf, les semer reviendrait à publier une
 * porte d'entrée ouverte sur la première station. Le jeu reste utile en
 * développement et en test, où il donne des données immédiatement lisibles.
 */
async function seedDemoData(
  queryFn: (sql: string, params?: unknown[]) => Promise<DbQueryResult<Record<string, unknown>>>,
) {
  if (env.NODE_ENV === "production") return;
  // En test, le jeu de démonstration est toujours semé : la quasi-totalité des
  // suites s'authentifient avec ces comptes. Le désactiver par `.env` (ce que
  // fait une installation réelle) rendrait la suite rouge pour une raison sans
  // rapport avec le code testé — d'où l'exception explicite.
  if (env.NODE_ENV !== "test" && env.SEED_DEMO_DATA.trim().toLowerCase() === "false") return;

  const existingUser = await queryFn("SELECT id FROM users WHERE lower(email) = $1", ["demo@washpilot.ci"]);
  if (existingUser.rows && existingUser.rows.length > 0) return;

  const demoPasswordHash = await hashPassword("WashPilot2026!");

  const orgRes = await queryFn(
    `INSERT INTO organizations (name, slug, onboarding_completed)
     VALUES ('Station Cocody Riviera', 'station-cocody-riviera', true)
     RETURNING id`
  );
  const orgId = orgRes.rows[0].id;

  const userRes = await queryFn(
    `INSERT INTO users (email, first_name, last_name, phone, password_hash, status, organization_id)
     VALUES ('demo@washpilot.ci', 'Awa', 'Kouassi', '+225 07 01 02 03 04', $1, 'active', $2)
     RETURNING id`,
    [demoPasswordHash, orgId]
  );
  const userId = userRes.rows[0].id;

  await queryFn(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [orgId, userId]
  );

  // Trois comptes de démonstration supplémentaires, un par rôle, pour que la
  // gestion des accès soit testable immédiatement (même mot de passe).
  const demoTeam = [
    { email: "gerant@washpilot.ci", first: "Serge", last: "N'Guessan", phone: "+225 07 11 22 33 44", role: "manager" },
    { email: "caisse@washpilot.ci", first: "Fatou", last: "Diarra", phone: "+225 07 55 66 77 88", role: "cashier" },
    { email: "laveur@washpilot.ci", first: "Koffi", last: "Yao", phone: "+225 07 99 00 11 22", role: "washer" },
  ];
  for (const member of demoTeam) {
    const memberRes = await queryFn(
      `INSERT INTO users (email, first_name, last_name, phone, password_hash, status, organization_id)
       VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id`,
      [member.email, member.first, member.last, member.phone, demoPasswordHash, orgId]
    );
    await queryFn(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)`,
      [orgId, memberRes.rows[0].id, member.role]
    );
  }

  // Démonstration : la station est sur le forfait Starter, en cours d'essai.
  // L'essai de 14 jours a démarré il y a 3 jours → il reste 11 jours, ce qui
  // rend le compte à rebours visible dès la première connexion.
  const freePlanRes = await queryFn("SELECT id FROM plans WHERE code = 'starter'");
  if (freePlanRes.rows.length > 0) {
    await queryFn(
      `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'trialing', NOW() + interval '11 days')`,
      [orgId, freePlanRes.rows[0].id]
    );
  }

  const siteRes = await queryFn(
    `INSERT INTO sites (organization_id, name, city, address, phone, is_active)
     VALUES ($1, 'Station Cocody Riviera', 'Abidjan', 'Boulevard de France, Cocody', '+225 27 22 44 55 66', true)
     RETURNING id`,
    [orgId]
  );
  const siteId = siteRes.rows[0].id;

  // Les catégories de démonstration sont exactement celles qu'une station
  // reçoit de l'assistant (un représentant par famille) : la démonstration
  // doit montrer le produit tel qu'un client le configurera, pas une version
  // plate du catalogue.
  let berlineId = ""
  let suvId = ""
  for (const category of DEFAULT_VEHICLE_CATEGORIES) {
    const inserted = await queryFn(
      `INSERT INTO vehicle_categories (organization_id, name, family, sort_order, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [orgId, category.name, category.family, category.sort_order]
    );
    if (category.family === "berlines") berlineId = String(inserted.rows[0].id)
    if (category.family === "suv") suvId = String(inserted.rows[0].id)
  }

  // Catégories de prestations : les mêmes que celles d'une station issue de
  // l'assistant, pour que la démonstration montre le produit réel.
  const serviceCategoryIds = new Map<string, string>()
  for (const name of DEFAULT_SERVICE_CATEGORY_NAMES) {
    const inserted = await queryFn(
      `INSERT INTO service_categories (organization_id, name, is_active)
       VALUES ($1, $2, true) RETURNING id`,
      [orgId, name]
    )
    serviceCategoryIds.set(name.toLowerCase(), String(inserted.rows[0].id))
  }

  // Prestations : exactement la liste du catalogue, avec sa catégorie, son prix
  // et sa durée. Une démonstration qui invente ses propres prestations montre
  // une station que personne ne peut configurer.
  const serviceIds = new Map<string, string>()
  for (const template of SERVICE_CATALOG_TEMPLATES) {
    const categoryName = serviceCategoryName(template.category)
    const inserted = await queryFn(
      `INSERT INTO services (organization_id, category_id, name, description, price_cents, duration_minutes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
      [
        orgId,
        serviceCategoryIds.get(categoryName.toLowerCase()) ?? null,
        template.name,
        template.description,
        template.price_cents,
        template.duration_minutes,
      ]
    )
    serviceIds.set(template.name, String(inserted.rows[0].id))
  }

  const completeWash = SERVICE_CATALOG_TEMPLATES.find(
    (template) => template.name === "Lavage complet (intérieur + extérieur)"
  )
  const lustrage = SERVICE_CATALOG_TEMPLATES.find(
    (template) => template.name === "Lustrage de la carrosserie"
  )
  if (!completeWash || !lustrage) throw new Error("catalogue de prestations incomplet")

  const w1 = await queryFn(
    `INSERT INTO workers (organization_id, site_id, first_name, last_name, phone, role, status, district)
     VALUES ($1, $2, 'Jean-Marc', 'Koffi', '+225 07 10 20 30 40', 'car_washer', 'active', 'Cocody')
     RETURNING id`,
    [orgId, siteId]
  );
  const w2 = await queryFn(
    `INSERT INTO workers (organization_id, site_id, first_name, last_name, phone, role, status, district)
     VALUES ($1, $2, 'Ibrahim', 'Touré', '+225 05 20 30 40 50', 'versatile_washer', 'active', 'Plateau Dokui')
     RETURNING id`,
    [orgId, siteId]
  );
  await queryFn(
    `INSERT INTO workers (organization_id, site_id, first_name, last_name, phone, role, status, district)
     VALUES ($1, $2, 'Fatou', 'Cissé', '+225 01 30 40 50 60', 'team_lead', 'active', 'Riviera Palmeraie')
     RETURNING id`,
    [orgId, siteId]
  );

  const cashSessionRes = await queryFn(
    `INSERT INTO cash_sessions (organization_id, site_id, opened_by, opening_amount_cents, status)
     VALUES ($1, $2, $3, 2500000, 'open')
     RETURNING id`,
    [orgId, siteId, userId]
  );
  const cashSessionId = cashSessionRes.rows[0].id;

  // Les deux lavages de démonstration prennent leur montant dans le catalogue :
  // un total saisi à la main finirait par ne plus correspondre au prix affiché.
  const wash1 = await queryFn(
    `INSERT INTO washes (organization_id, site_id, vehicle_category_id, reference, status, total_cents, payment_status, payment_method, created_by)
     VALUES ($1, $2, $3, 'LAV-2026-0001', 'completed', $4, 'paid', 'cash', $5)
     RETURNING id`,
    [orgId, siteId, berlineId, completeWash.price_cents, userId]
  );
  await queryFn(
    `INSERT INTO wash_items (wash_id, service_id, service_name, quantity, unit_price_cents, line_total_cents)
     VALUES ($1, $2, $3, 1, $4, $4)`,
    [
      wash1.rows[0].id,
      serviceIds.get(completeWash.name),
      completeWash.name,
      completeWash.price_cents,
    ]
  );
  await queryFn(
    `INSERT INTO wash_assignments (wash_id, worker_id) VALUES ($1, $2)`,
    [wash1.rows[0].id, w1.rows[0].id]
  );
  await queryFn(
    `INSERT INTO payments (organization_id, wash_id, method, amount_cents, status)
     VALUES ($1, $2, 'cash', $3, 'verified')`,
    [orgId, wash1.rows[0].id, completeWash.price_cents]
  );
  await queryFn(
    `INSERT INTO cash_movements (organization_id, cash_session_id, type, amount_cents, source, description, wash_id, created_by)
     VALUES ($1, $2, 'entry', $3, 'wash_payment', 'Encaissement lavage LAV-2026-0001', $4, $5)`,
    [orgId, cashSessionId, completeWash.price_cents, wash1.rows[0].id, userId]
  );

  const wash2 = await queryFn(
    `INSERT INTO washes (organization_id, site_id, vehicle_category_id, reference, status, total_cents, payment_status, payment_method, created_by)
     VALUES ($1, $2, $3, 'LAV-2026-0002', 'completed', $4, 'paid', 'wave', $5)
     RETURNING id`,
    [orgId, siteId, suvId, lustrage.price_cents, userId]
  );
  await queryFn(
    `INSERT INTO wash_items (wash_id, service_id, service_name, quantity, unit_price_cents, line_total_cents)
     VALUES ($1, $2, $3, 1, $4, $4)`,
    [wash2.rows[0].id, serviceIds.get(lustrage.name), lustrage.name, lustrage.price_cents]
  );
  await queryFn(
    `INSERT INTO wash_assignments (wash_id, worker_id) VALUES ($1, $2), ($1, $3)`,
    [wash2.rows[0].id, w1.rows[0].id, w2.rows[0].id]
  );
  await queryFn(
    `INSERT INTO payments (organization_id, wash_id, method, amount_cents, status)
     VALUES ($1, $2, 'wave', $3, 'verified')`,
    [orgId, wash2.rows[0].id, lustrage.price_cents]
  );

  await queryFn(
    `INSERT INTO onboarding_progress (organization_id, current_stage, completed_at, plan_code)
     VALUES ($1, 'completed', NOW(), 'starter')
     ON CONFLICT (organization_id) DO UPDATE SET current_stage = 'completed', completed_at = NOW()`,
    [orgId]
  );
}

function createPglitePool(pglite: PGlite): pg.Pool {
  let transactionLock: Promise<void> = Promise.resolve();

  // NOTE D'ARCHITECTURE — sérialisation.
  //
  // Seul `connect()` est sérialisé (verrou de transaction historique) : deux
  // clients interactifs ne peuvent pas s'entremêler leurs `BEGIN`/`COMMIT`.
  // `query()` ne l'est PAS, volontairement. Sur Postgres réel, `pool.query`
  // ouvre de toute façon une connexion distincte — il ne rejoint jamais la
  // transaction d'un client. Sérialiser `query()` contre les clients ouverts
  // ne ferait donc rien d'utile en production, et provoquerait des morts
  // subites dès qu'un code tient un client et interroge le pool dans le même
  // flux (patron présent dans les tests). Sur PGlite (une seule connexion),
  // l'entremêlement historique est conservé tel quel ; le chemin système
  // reste de toute façon explicite (`runWithTenant` absent → pas de
  // `SET ROLE`, requête exécutée en propriétaire).
  const runQuery = async <R = Record<string, unknown>>(
    sqlOrConfig: string | { text?: string; sql?: string; values?: unknown[] },
    params?: unknown[],
  ): Promise<DbQueryResult<R>> => {
    let sql: string;
    let values: unknown[] | undefined = params;
    if (typeof sqlOrConfig === "string") {
      sql = sqlOrConfig;
    } else if (sqlOrConfig && typeof sqlOrConfig === "object") {
      sql = sqlOrConfig.text || sqlOrConfig.sql || "";
      values = sqlOrConfig.values || params;
    } else {
      sql = String(sqlOrConfig);
    }

    if (!values || values.length === 0) {
      const trimmed = sql.trim();
      const statements = trimmed.split(";").map((s) => s.trim()).filter(Boolean);
      if (statements.length > 1) {
        await pglite.exec(sql);
        return { rows: [] as R[], rowCount: 0, fields: [], command: "EXEC" };
      }
    }

    const res = await pglite.query(sql, values);
    return {
      rows: (res.rows || []) as R[],
      rowCount: res.rowCount ?? (res.rows ? res.rows.length : 0),
      fields: res.fields || [],
      command: res.command || "SELECT",
      affectedRows: res.affectedRows,
    };
  };

  return {
    async query<R = Record<string, unknown>>(
      sqlOrConfig: string | { text?: string; sql?: string; values?: unknown[] },
      params?: unknown[],
    ) {
      return runQuery<R>(sqlOrConfig, params);
    },
    async connect() {
      let releaseLock: () => void = () => {};
      const prevLock = transactionLock;
      transactionLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await prevLock;

      let released = false;
      const client: DbClient = {
        async query<R = Record<string, unknown>>(
          sqlOrConfig: string | { text?: string; sql?: string; values?: unknown[] },
          params?: unknown[],
        ) {
          return runQuery<R>(sqlOrConfig, params);
        },
        release() {
          if (!released) {
            released = true;
            releaseLock();
          }
        },
      };
      return client;
    },
    async end() {
      await pglite.close();
    },
  } as unknown as pg.Pool;
}



// ---------------------------------------------------------------------------
// Verse au registre les activations anterieures a son existence.
//
// Avant la table subscription_payments, une activation ne laissait qu'une
// ligne d'audit chez le client, le montant enfoui dans du JSON. Sans ce
// rattrapage la courbe de revenu demarrerait a zero le jour de la mise a
// jour, et tout l'historique deja encaisse serait invisible.
//
// Idempotent : la cle est le couple (station, instant). Relancer au
// demarrage est sans effet.
// ---------------------------------------------------------------------------
async function backfillRevenueLedger(
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>,
): Promise<void> {
  const inserted = await query(
    `INSERT INTO subscription_payments(
       organization_id, organization_name, plan_code, plan_name, amount_cents, months,
       period_start, period_end, channel, payment_reference, source, note, occurred_at)
     SELECT a.organization_id,
            COALESCE(o.name, 'Station supprimee'),
            COALESCE(a.metadata->>'plan_code', 'inconnu'),
            COALESCE(a.metadata->>'plan_name', 'Forfait'),
            COALESCE((a.metadata->>'price_cents')::bigint, 0)
              * COALESCE((a.metadata->>'months')::int, 1),
            COALESCE((a.metadata->>'months')::int, 1),
            COALESCE((a.metadata->>'period_end')::timestamptz, a.created_at)
              - (COALESCE((a.metadata->>'months')::int, 1) || ' months')::interval,
            COALESCE((a.metadata->>'period_end')::timestamptz, a.created_at),
            'other',
            a.metadata->>'payment_reference',
            'backfill',
            'Reprise automatique depuis le journal d audit',
            a.created_at
       FROM audit_logs a
       LEFT JOIN organizations o ON o.id = a.organization_id
      WHERE a.action = 'subscription.activated'
        AND a.organization_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM subscription_payments sp
           WHERE sp.organization_id = a.organization_id
             AND sp.occurred_at = a.created_at)
     RETURNING id`,
  )
  const n = inserted.rowCount ?? 0
  if (n) console.log(`[revenu] ${n} encaissement(s) repris depuis le journal d'audit.`)
}

/**
 * La base embarquée a-t-elle le droit de prendre le relais ?
 *
 * En développement, oui : c'est ce qui permet de lancer le projet sans rien
 * installer. **En production, jamais.**
 *
 * PGlite écrit dans le système de fichiers du serveur. Dans un conteneur, ce
 * système de fichiers disparaît au redéploiement. Un démarrage silencieux sur
 * la base embarquée donnerait une application parfaitement fonctionnelle, qui
 * encaisserait de l'argent réel pendant des semaines, puis perdrait tout à la
 * première mise à jour — sans qu'aucune alerte n'ait été levée.
 *
 * Le cas le plus traître n'est pas l'oubli de configuration : c'est la base
 * externe momentanément injoignable au démarrage. Se rabattre alors sur une
 * base vide ferait repartir la station à zéro, caisse comprise. Mieux vaut
 * refuser de démarrer : un service arrêté se remarque, une base vide non.
 */
export function embeddedFallbackAllowed(nodeEnv: string): boolean {
  return nodeEnv !== "production"
}

/**
 * Transcription unique des anciennes prestations vers l'éligibilité explicite.
 *
 * **Ce que cette migration dit, et ne dit pas.** Sous l'ancien modèle, une
 * prestation s'appliquait à *tout* véhicule : le prix venait de la clé de
 * catégorie exacte, puis de la clé de famille, puis du prix de base. Les
 * catégories autorisées n'étaient donc jamais écrites — le comportement
 * « autorisée partout » était la règle. Cette migration **transcrit** cette
 * règle telle quelle, pour les catégories connues de la station au moment du
 * passage : elle n'invente aucune autorisation nouvelle, elle grave dans le
 * nouveau modèle ce que l'ancien faisait réellement.
 *
 * Deux limites assumées et documentées :
 *   • les catégories créées **après** la migration ne deviennent pas
 *     éligibles d'office — c'est la nouvelle règle qui s'applique, et le
 *     gérant doit cocher explicitement ;
 *   • une prestation n'est transcrite que si elle n'a **aucune** association
 *     explicite : relancer la migration ne réactive jamais une catégorie
 *     qu'un gérant a ensuite décochée.
 *
 * Les valeurs de l'ancien jsonb sont lues avec prudence (un texte non
 * numérique ou négatif est ignoré, pas casté de force) : une donnée sale ne
 * doit jamais empêcher le démarrage.
 */
export const SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL = `
INSERT INTO service_vehicle_prices(service_id, vehicle_category_id, price_cents)
SELECT s.id, vc.id,
  COALESCE(
    CASE WHEN s.price_by_vehicle_type ->> vc.id::text ~ '^[0-9]+$'
         THEN (s.price_by_vehicle_type ->> vc.id::text)::int END,
    CASE WHEN s.price_by_vehicle_type ->> COALESCE(vc.family, '') ~ '^[0-9]+$'
         THEN (s.price_by_vehicle_type ->> COALESCE(vc.family, ''))::int END,
    s.price_cents
  )
FROM services s
JOIN vehicle_categories vc ON vc.organization_id = s.organization_id
WHERE NOT EXISTS (SELECT 1 FROM service_vehicle_prices p WHERE p.service_id = s.id)
ON CONFLICT (service_id, vehicle_category_id) DO NOTHING`;

/**
 * Lit l'autorité de certification à faire confiance au pool externe.
 *
 * `DATABASE_SSL_CA` accepte deux formes, parce que les deux se rencontrent en
 * pratique : le **chemin** d'un fichier déposé par l'hébergeur (Supabase
 * fournit `prod-ca-2021.crt`), ou le **contenu PEM** collé dans la variable
 * d'environnement par une plateforme serverless qui n'a pas de disque. Les
 * `\n` littéraux sont acceptés, un `.env` ne sachant pas porter de vrai
 * retour à la ligne dans une valeur.
 */
export function readCaCertificate(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const looksLikePem = value.includes("-----BEGIN CERTIFICATE-----");
  const unescaped = value.replace(/\\n/g, "\n");
  if (looksLikePem) return unescaped;
  try {
    return readFileSync(value, "utf8");
  } catch {
    console.warn(
      `[db] DATABASE_SSL_CA ne ressemble ni à un certificat PEM ni à un fichier lisible (${value}). ` +
        "La connexion se fera avec les autorités publiques uniquement.",
    );
    return null;
  }
}

export async function initDatabaseSchema(): Promise<boolean> {
  // La base à ouvrir est décidée par une fonction pure, testée à part. En mode
  // test, elle ignore `DATABASE_URL` : une suite qui écrirait dans la base de
  // production (ou dans celle du développeur) serait pire qu'une suite rouge.
  const decision = chooseDatabaseTarget({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
  })

  if (!embeddedFallbackAllowed(env.NODE_ENV) && decision.target === "embedded") {
    throw new Error(
      "DATABASE_URL est obligatoire en production. Sans elle, l'application démarrerait sur la base " +
        "embarquée, à l'intérieur du serveur : les données seraient perdues au premier redéploiement.",
    )
  }
  if (decision.ignoredDatabaseUrl) {
    console.warn(
      "[db] Mode test : DATABASE_URL est ignorée, la suite utilise une base embarquée en mémoire. " +
        "Aucune donnée réelle n'est lue ni écrite.",
    )
  }
  if (decision.target === "external") {
    try {
      // Pooler en mode transaction : l'état de session (SET ROLE,
      // app.current_org) n'y survit pas. On ne refuse pas le démarrage — un
      // correctif peut être en cours — mais l'opérateur doit le savoir.
      const connectionProfile = describeConnection(env.DATABASE_URL);
      if (connectionProfile.warning) console.warn(`[db] ${connectionProfile.warning}`);
      const externalPool = new Pool({
        connectionString: env.DATABASE_URL,
        max: env.PG_POOL_MAX,
        ssl: buildSslConfig(env.DATABASE_URL, readCaCertificate(env.DATABASE_SSL_CA)),
        connectionTimeoutMillis: 8000,
        idleTimeoutMillis: 30000,
      });
      await externalPool.query("SELECT 1");
      await externalPool.query(schemaSql);
      await probeRlsRole(externalPool);
      await seedServiceCatalog(externalPool.query.bind(externalPool));
      await externalPool.query(SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL);
      await migrateLegacyPlatformAdmins(externalPool.query.bind(externalPool));
      await syncPlatformOperators(externalPool.query.bind(externalPool));
      await backfillRevenueLedger(externalPool.query.bind(externalPool));
      pool = bindRlsGuard(externalPool as unknown as RlsPool) as unknown as pg.Pool;
      ready = true;
      console.info("[db] Connecté à PostgreSQL via DATABASE_URL");
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      if (!embeddedFallbackAllowed(env.NODE_ENV)) {
        throw new Error(
          `Connexion à DATABASE_URL impossible (${detail}). L'application refuse de démarrer sur la base ` +
            "embarquée : elle repartirait d'une base vide, caisse comprise.",
          // L'erreur d'origine reste attachée : sans elle, l'exploitant lirait
          // « connexion impossible » sans savoir si c'est le mot de passe, le
          // réseau ou le certificat.
          { cause: error },
        );
      }
      console.warn("[db] Connexion DATABASE_URL échouée, basculement sur PostgreSQL embarqué (PGlite):", detail);
    }
  }

  try {
    // Emplacement décidé par une fonction pure, testée à part : sans dossier,
    // PGlite garde tout en mémoire et le travail de la journée disparaît au
    // redémarrage. Le défaut est donc le disque, et une base volatile se
    // signale bruyamment dans les journaux.
    const location = resolvePgliteLocation({
      nodeEnv: env.NODE_ENV,
      dataDir: env.PGLITE_DATA_DIR,
    });
    if (location.dataDir) {
      // PGlite ne crée que le dernier niveau : sans cela, un chemin imbriqué
      // comme `.data/pglite` échoue avec ENOENT au tout premier démarrage.
      await mkdir(location.dataDir, { recursive: true });
    }
    pgliteInstance = location.dataDir ? new PGlite(location.dataDir) : new PGlite();
    const rawPool = createPglitePool(pgliteInstance);
    await rawPool.query(schemaSql);
    await probeRlsRole(rawPool);
    pool = bindRlsGuard(rawPool as unknown as RlsPool) as unknown as pg.Pool;
    await seedServiceCatalog(pool.query.bind(pool));
    await seedDemoData(pool.query.bind(pool));
    await pool.query(SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL);
    await migrateLegacyPlatformAdmins(pool.query.bind(pool));
    await syncPlatformOperators(pool.query.bind(pool));
    await backfillRevenueLedger(pool.query.bind(pool));
    ready = true;
    console.info(describePgliteLocation(location, env.NODE_ENV));
    return true;
  } catch (error) {
    ready = false;
    console.error(
      "[db] Initialisation de la base de données échouée:",
      error instanceof Error ? error.message : "unknown",
    );
    if (env.NODE_ENV === "production" && env.DATABASE_URL) throw error;
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  ready = false;
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
