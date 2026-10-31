# Catégories de véhicules et tarification par gabarit

Date : 23 octobre 2026 · Modules : `src/config/vehicle-taxonomy.ts`,
`src/lib/service-pricing.ts`, `server/default-catalog.ts`, `server/api.ts`,
`src/app/vehicle-categories/page.tsx`, `src/app/services/page.tsx`

Le catalogue ne proposait que trois catégories de véhicules (« Berline »,
« SUV / 4x4 », « Moto ») et aucune ne portait de tarif. Une station ne pouvait
donc pas facturer plus cher un SUV qu'une citadine, ni accueillir un camion ou
un bus dans son référentiel. Ce document décrit ce qui a été mis en place.

---

## 1. Le référentiel : 9 familles, 61 types

La liste vit dans **un seul fichier**, `src/config/vehicle-taxonomy.ts`,
importé par l'interface *et* par le serveur. Une liste recopiée des deux côtés
dérive : un type proposé à l'écran que l'API refuse est un formulaire qui
répond 400 sans explication.

| Famille (`code`) | Types |
|---|---|
| Motos et deux-roues (`deux_roues`) | Moto, Scooter, Cyclomoteur, Moto-taxi, Tricycle motorisé, Quad |
| Petites voitures (`petites_voitures`) | Citadine, Mini-citadine, Petite berline, Compacte, Coupé, Cabriolet |
| Berlines et familiales (`berlines`) | Berline compacte, Berline moyenne, Berline grande taille, Break, Monospace compact, Monospace familial |
| SUV et tout-terrain (`suv`) | Crossover, SUV compact, SUV familial, Grand SUV, 4x4, Pick-up double cabine, Véhicule tout-terrain |
| Utilitaires légers (`utilitaires`) | Fourgonnette, Fourgon, Petit utilitaire, Grand utilitaire, Pick-up simple cabine, Pick-up cabine approfondie |
| Transport de personnes (`transport_personnes`) | Taxi, VTC, Taxi collectif, Minibus, Car, Autocar, Bus urbain, Bus articulé |
| Poids lourds (`poids_lourds`) | Camion léger, Camion porteur, Camion-benne, Camion-citerne, Camion frigorifique, Tracteur routier, Semi-remorque, Remorque |
| Véhicules spéciaux (`speciaux`) | Tracteur agricole, Engin de chantier, Pelle mécanique, Chargeuse, Chariot élévateur, Ambulance, Véhicule de secours, Véhicule blindé |
| Électriques et hybrides (`electriques`) | Voiture électrique, SUV électrique, Berline hybride, Utilitaire électrique, Moto électrique, Scooter électrique |

Chaque type a un `code` stable, sans accent (`suv_familial`), et un `name`
affiché (« SUV familial »). Le code sert de clé ; renommer un libellé ne casse
donc aucun tarif.

**Pourquoi des familles.** Personne ne saisit 61 prix. Neuf familles tiennent
sur un écran — c'est le niveau auquel un gérant raisonne (« le SUV, je le
facture plus cher ») et c'est donc celui qui porte la tarification.

---

## 2. Modèle de données

`vehicle_categories` gagne trois colonnes, toutes rétro-remplies au démarrage :

```sql
ALTER TABLE vehicle_categories ADD COLUMN family     text;                       -- code de famille
ALTER TABLE vehicle_categories ADD COLUMN sort_order integer NOT NULL DEFAULT 0;  -- rang dans la famille
ALTER TABLE vehicle_categories ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
```

- `family` est du texte libre validé contre le référentiel côté API, pas une
  clé étrangère : une station peut ranger une catégorie maison dans une famille
  connue sans migration.
- `updated_at` corrige un défaut antérieur : la colonne n'existait pas et
  l'API renvoyait `created_at AS updated_at`, c'est-à-dire une date fausse.
- Les catégories déjà en base reçoivent leur famille par un `UPDATE … CASE`
  idempotent (aucune écriture sur une ligne qui a déjà une famille). L'ordre
  des règles compte : « SUV électrique » bascule côté électrique, pas côté SUV.

Rien n'est supprimé, rien n'est renommé : les lavages historiques gardent leur
`vehicle_category_id`.

---

## 3. Tarification : trois niveaux, une seule fonction

`src/lib/service-pricing.ts` — `resolveUnitPrice(service, vehicle)` — est
appelée **par le serveur et par l'interface**. C'était le défaut le plus coûteux :
le serveur appliquait `price_by_vehicle_type`, les écrans calculaient avec le
seul `price_cents`. Mesure avant correctif : prestation à 1 000 F, tarif SUV à
5 000 F → l'écran annonçait 1 000 F, le lavage était enregistré à 5 000 F.

Ordre de résolution :

1. `price_by_vehicle_type[<id de catégorie>]` — tarif pour cette catégorie
   exacte (« SUV familial ») ;
2. `price_by_vehicle_type[<code de famille>]` — tarif pour la famille (« suv ») ;
3. `price_cents` — prix de base.

Les clés UUID sont distinguées des codes de famille par leur forme
(`isFamilyPriceKey`). Les tarifs par catégorie déjà enregistrés continuent donc
de fonctionner ; une station qui ne s'en sert pas ne voit aucune différence.

Côté serveur, `POST /washes` lit la famille de la catégorie choisie dans la
même requête que la validation, puis applique la règle. Les lignes de
`wash_items` conservent le prix réellement facturé (`unit_price_cents`), comme
avant : le tarif d'aujourd'hui ne réécrit pas les ventes d'hier.

---

## 4. Ce qui a changé à l'écran

### 4.1 Catégories de véhicules (`/vehicle-categories`)

- Liste **groupée par famille**, avec une ligne d'en-tête par famille
  (libellé, nombre de catégories, à quoi elle sert). Les catégories sans
  famille atterrissent dans un groupe « Sans famille » qui explique qu'elles ne
  recevront aucun tarif de famille — elles restent visibles et modifiables.
- Recherche par nom **ou par famille**.
- Formulaire : nom + **famille** (liste fermée) au lieu du seul nom.
- **« Parcourir le référentiel »** : une boîte de dialogue propose les 61 types
  par famille, avec filtre, case « toute la famille », et les types déjà
  présents affichés barrés. L'ajout est idempotent : rejouer ne crée aucun
  doublon.
- Les familles encore inutilisées sont rappelées en bas de tableau.

### 4.2 Prestations (`/services`)

- Nouvelle section **« Prix par famille de véhicule »** : un champ par famille
  utilisée par la station, pré-rempli avec le tarif existant, vide signifiant
  « prix de base ». Les tarifs par catégorie déjà enregistrés sont réinjectés
  tels quels à l'enregistrement — le serveur remplace l'objet entier, les
  omettre les effacerait.
- Colonne Prix : « dès 3 000 F / jusqu'à 5 000 F » quand des tarifs existent,
  sinon le prix simple.
- La devise de l'écran passe de « XOF » à « F CFA », conforme à la règle de
  `src/lib/format.ts`.

### 4.3 Caisse (`/washes`)

- Le sélecteur de véhicule est **groupé par famille** (`<optgroup>`) : sur 60
  catégories, une liste plate se parcourt mal.
- Le prix unitaire affiché sur chaque prestation est celui du véhicule
  sélectionné, avec la mention « (tarif véhicule) » quand il diffère du prix de
  base. Le total, la validation du montant reçu et la caisse suivent.

### 4.4 Assistant (`/onboarding`)

- Les neuf catégories par défaut portent leur famille : la station neuve peut
  facturer par gabarit dès la première recette. Un représentant **par famille**
  et un seul (Moto, Citadine, Berline moyenne, SUV familial, Fourgonnette,
  Minibus, Camion porteur, Engin de chantier, Voiture électrique) : une famille
  oubliée, et ses véhicules n'ont aucune case — donc aucun tarif appliqué.
- La **station de démonstration** boucle sur cette même liste. Elle n'en créait
  que trois (Moto, Berline moyenne, SUV familial) : un utilitaire, un minibus
  ou un camion n'avaient aucune case à l'ouverture de la démo.
- Les **catégories de prestations** sont désormais créées (Lavage extérieur,
  Lavage intérieur, Lavage complet, Detailing & soins, Autres prestations) et
  chaque prestation reçoit celle de son modèle — le classement existait déjà
  dans `service_catalog` et était jeté à la confirmation.
- Comme pour les véhicules, l'initialisation ne se fait que si la liste est
  vide : une station qui a délibérément supprimé ses catégories ne les voit pas
  revenir.

---

## 5. API

| Route | Rôle |
|---|---|
| `GET /api/v1/vehicle-categories` | Liste triée famille → rang → nom, avec `family`, `sort_order`, `updated_at` |
| `GET /api/v1/vehicle-categories/catalog` | Référentiel complet (9 familles, 61 types) + ce qui est déjà ajouté dans la station |
| `POST /api/v1/vehicle-categories/catalog` | Ajout en lot `{ types: ["suv_familial", …] }` — idempotent, `400 invalid_vehicle_type` sinon |
| `POST /api/v1/vehicle-categories` | Création `{ name, family?, sort_order? }` — `400 invalid_vehicle_family` si la famille n'existe pas |
| `PATCH /api/v1/vehicle-categories/:id` | Renommage, reclassement, activation |
| `DELETE /api/v1/vehicle-categories/:id` | `409` si un lavage l'utilise ; retire aussi les clés de tarif qui la visaient |

Validation des tarifs sur `POST`/`PATCH /services` :

- une clé non-UUID doit être une famille du référentiel (`400 invalid_vehicle_family`) ;
- une clé UUID doit être une catégorie **de l'organisation** (`400 invalid_vehicle_category`).

Journal d'audit : `vehicle_category.created`, `vehicle_category.updated`,
`vehicle_category.deleted`, `vehicle_category.imported`, `service.created`,
`service.updated` (avec l'ancien et le nouveau prix dans `metadata`). Un
changement de tarif n'est plus anonyme.

---

## 6. Tests

| Fichier | Ce qui est vérifié |
|---|---|
| `tests/vehicle-taxonomy.test.ts` | 9 familles, 61 types, unicité des codes et libellés, recherche par code ou libellé, ordre de tri |
| `tests/service-pricing.test.ts` | Ordre de résolution (catégorie → famille → base), valeurs douteuses ignorées, amplitude de prix |
| `tests/default-catalog.test.ts` | Défauts cohérents avec le référentiel, familles couvertes, classement des prestations |
| `tests/vehicle-categories.test.ts` | API de bout en bout : import, doublons, famille inconnue, tarif facturé sur le lavage, tarif d'une autre station refusé, purge à la suppression |
| `tests/database-wiring.test.ts` | L'assistant crée bien catégories de prestations, familles et prestations classées |

Suite complète : **896 tests**, 0 échec. `tsc -b`, `lint`, `build` et `smoke`
(69/69) passent.

---

## 7. Ce qui reste ouvert

- **Plafond `max_services`** toujours affiché et non appliqué (voir
  `ANALYSE-CATALOGUE-PRESTATIONS.md`, CAT-04).
- **Duplication d'une prestation** d'une famille à l'autre (« même formule,
  tarif camion ») : à faire quand le besoin se présentera.

**Fait depuis** (voir `PRESTATIONS-CATALOGUE.md` §5) : l'édition des tarifs par
catégorie précise et la suppression d'une prestation sont désormais dans
l'interface.
- Les écrans Caisse, Achats et Rapports affichent encore « XOF » par endroits :
  la règle « F CFA » n'est pas encore généralisée.
