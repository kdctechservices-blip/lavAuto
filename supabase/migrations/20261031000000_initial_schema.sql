-- LAVAUTO: schema initial de lapplication.
-- Projet Supabase dédié ; base neuve (aucune reprise de données).
-- Générée depuis server/db.ts::schemaSql le 2026-10-31.
-- Ne jamais modifier après application : créer une nouvelle migration.


CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid, email text NOT NULL, first_name text, last_name text, phone text,
 avatar_url text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
 password_hash text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL, slug text, onboarding_completed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin boolean NOT NULL DEFAULT false;
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
-- Rôle applicatif : droits DML uniquement, ni superutilisateur ni
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
END $rls$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON organizations;
CREATE POLICY org_isolation ON organizations
  USING (id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON subscriptions;
CREATE POLICY org_isolation ON subscriptions
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON organization_members;
CREATE POLICY org_isolation ON organization_members
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sites;
CREATE POLICY org_isolation ON sites
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON onboarding_progress;
CREATE POLICY org_isolation ON onboarding_progress
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON service_categories;
CREATE POLICY org_isolation ON service_categories
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE vehicle_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON vehicle_categories;
CREATE POLICY org_isolation ON vehicle_categories
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON services;
CREATE POLICY org_isolation ON services
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON workers;
CREATE POLICY org_isolation ON workers
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE work_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON work_schedules;
CREATE POLICY org_isolation ON work_schedules
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON attendance_records;
CREATE POLICY org_isolation ON attendance_records
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON customers;
CREATE POLICY org_isolation ON customers
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE washes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON washes;
CREATE POLICY org_isolation ON washes
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE receipt_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON receipt_issues;
CREATE POLICY org_isolation ON receipt_issues
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON notifications;
CREATE POLICY org_isolation ON notifications
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON product_categories;
CREATE POLICY org_isolation ON product_categories
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON products;
CREATE POLICY org_isolation ON products
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON stock_movements;
CREATE POLICY org_isolation ON stock_movements
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE service_consumables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON service_consumables;
CREATE POLICY org_isolation ON service_consumables
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON payments;
CREATE POLICY org_isolation ON payments
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON cash_sessions;
CREATE POLICY org_isolation ON cash_sessions
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON cash_movements;
CREATE POLICY org_isolation ON cash_movements
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON expenses;
CREATE POLICY org_isolation ON expenses
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE utility_meters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON utility_meters;
CREATE POLICY org_isolation ON utility_meters
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE utility_readings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON utility_readings;
CREATE POLICY org_isolation ON utility_readings
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE utility_reading_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON utility_reading_photos;
CREATE POLICY org_isolation ON utility_reading_photos
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON suppliers;
CREATE POLICY org_isolation ON suppliers
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON purchases;
CREATE POLICY org_isolation ON purchases
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON purchase_items;
CREATE POLICY org_isolation ON purchase_items
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON idempotency_keys;
CREATE POLICY org_isolation ON idempotency_keys
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE member_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON member_permissions;
CREATE POLICY org_isolation ON member_permissions
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE subscription_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON subscription_reminders;
CREATE POLICY org_isolation ON subscription_reminders
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON payment_intents;
CREATE POLICY org_isolation ON payment_intents
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON subscription_payments;
CREATE POLICY org_isolation ON subscription_payments
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON support_requests;
CREATE POLICY org_isolation ON support_requests
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE closure_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON closure_requests;
CREATE POLICY org_isolation ON closure_requests
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON audit_logs;
CREATE POLICY org_isolation ON audit_logs
  USING (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE wash_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON wash_items;
CREATE POLICY org_isolation ON wash_items
  USING (EXISTS (SELECT 1 FROM washes p WHERE p.id = wash_items.wash_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM washes p WHERE p.id = wash_items.wash_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid));

ALTER TABLE wash_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON wash_assignments;
CREATE POLICY org_isolation ON wash_assignments
  USING (EXISTS (SELECT 1 FROM washes p WHERE p.id = wash_assignments.wash_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM washes p WHERE p.id = wash_assignments.wash_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid));

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON support_messages;
CREATE POLICY org_isolation ON support_messages
  USING (EXISTS (SELECT 1 FROM support_requests p WHERE p.id = support_messages.request_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM support_requests p WHERE p.id = support_messages.request_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid));

ALTER TABLE service_vehicle_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON service_vehicle_prices;
CREATE POLICY org_isolation ON service_vehicle_prices
  USING (EXISTS (SELECT 1 FROM services p WHERE p.id = service_vehicle_prices.service_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM services p WHERE p.id = service_vehicle_prices.service_id AND p.organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid));

ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON error_events;
CREATE POLICY org_isolation ON error_events
  USING ((organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid))
  WITH CHECK ((organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid));

ALTER TABLE platform_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON platform_audit_logs;
CREATE POLICY org_isolation ON platform_audit_logs
  USING ((organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid))
  WITH CHECK ((organization_id IS NULL OR organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid));