# Les prestations d'une station de lavage

Date : 23 octobre 2026 · Modules : `server/default-catalog.ts`, `server/db.ts`,
`server/onboarding.ts`, `src/app/onboarding/components/services-step.tsx`

Le catalogue de l'assistant proposait neuf modèles dispersés (« Lavage
extérieur simple », « Mousse active », « Séchage manuel »…) qui décrivaient des
*gestes* plutôt que des *prestations vendues*. Aucune ne correspondait à ce
qu'une station affiche sur son panneau de prix. Le catalogue porte désormais la
liste réelle : **11 prestations**, dans l'ordre où elles se vendent.

---

## 1. La liste

Source unique : `SERVICE_CATALOG_TEMPLATES` dans `server/default-catalog.ts`.

| # | Prestation | Catégorie de station | Prix indicatif | Durée |
|---|---|---|---|---|
| 1 | Lavage extérieur | Lavage extérieur | 2 000 F CFA | 20 min |
| 2 | Lavage intérieur simple | Lavage intérieur | 1 500 F CFA | 20 min |
| 3 | Lavage complet (intérieur + extérieur) | Lavage complet | 3 500 F CFA | 45 min |
| 4 | Lavage express | Lavage extérieur | 1 500 F CFA | 15 min |
| 5 | Nettoyage des tapis et sièges uniquement | Lavage intérieur | 2 500 F CFA | 30 min |
| 6 | Lavage des moquettes (maison) | Autres prestations | 3 000 F CFA | 45 min |
| 7 | Nettoyage des jantes et pneus | Lavage extérieur | 1 000 F CFA | 15 min |
| 8 | Lavage du bas de caisse | Lavage extérieur | 1 500 F CFA | 20 min |
| 9 | Lavage moteur complet | Lavage extérieur | 3 000 F CFA | 45 min |
| 10 | Lustrage de la carrosserie | Detailing & soins | 5 000 F CFA | 60 min |
| 11 | Lavage de motos | Lavage extérieur | 1 000 F CFA | 15 min |

Les prix et les durées sont **indicatifs** : la station les ajuste librement
depuis l'écran « Prestations ». Ils existent pour qu'un lavage créé le premier
jour ait un montant et une heure de fin justes, pas pour contraindre.

L'ordre suit le parcours du client, du plus courant au plus spécialisé. Il est
respecté dans l'assistant d'ouverture ; l'écran « Prestations » de la station
classe encore par nom (voir §6).

### Pourquoi ces catégories

Les cinq catégories créées avec la station sont celles de l'assistant : Lavage
extérieur, Lavage intérieur, Lavage complet, Detailing & soins, Autres
prestations. Deux prestations de la liste ne rentrent dans aucune case
véhicule :

- **Lavage des moquettes (maison)** — ce n'est pas un véhicule ; rangée dans
  « Autres prestations », avec sa propre ligne de prix et sa durée.
- **Lavage de motos** — rangée dans « Lavage extérieur » : c'est un lavage
  extérieur, et le station peut lui donner un tarif par famille (deux-roues)
  sans créer de catégorie supplémentaire.

---

## 2. Une seule liste, trois usages

| Usage | Où | Ce qu'il lit |
|---|---|---|
| Assistant d'ouverture (`GET /api/v1/service-catalog`) | `service_catalog` | Les 11 modèles actifs, triés |
| Prestations de la station (`/services`) | `services` | Ce que l'assistant a recopié, modifiable |
| Station de démonstration | `services` de l'organisation de démo | Les 11 mêmes lignes |

Avant, trois listes coexistaient : un `INSERT` dans le schéma, cinq prestations
écrites à la main dans la démonstration, et le catalogue lu par l'assistant.
Elles avaient déjà divergé — la démo proposait une « Formule VIP Prestige »
introuvable dans l'assistant, et un utilitaire n'y trouvait aucune case.

Le semi du catalogue a quitté le schéma pour `seedServiceCatalog()`, rejoué à
chaque démarrage :

- **idempotent** : `ON CONFLICT (category, name) DO UPDATE` — corriger un prix
  ou renommer une prestation atteint les bases déjà créées, pas seulement les
  neuves ;
- **non destructif** : une prestation retirée de la liste est **désactivée**,
  jamais supprimée. Une station a pu la cocher pendant son assistant ; son
  identifiant doit continuer d'exister.

Vérifié en conditions réelles : une base portant un ancien modèle le voit
désactivé au redémarrage, et le catalogue reste à 11 lignes actives.

---

## 3. Durée et description : deux colonnes qui manquaient

`service_catalog` ne portait que `category`, `name`, `price_cents`,
`sort_order`. L'assistant créait donc des prestations **sans durée** : tous les
lavages recevaient l'heure de fin estimée par défaut (45 min), qu'on vende un
lavage express ou un lustrage de carrosserie de soixante minutes. La barre de
progression des tâches en cours mentait.

Deux colonnes ajoutées (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, donc sans
migration manuelle) :

| Colonne | Rôle |
|---|---|
| `duration_minutes` | Durée indicative, recopiée dans `services.duration_minutes` |
| `description` | Une phrase pour la fiche de la prestation |

L'assistant affiche désormais « 20 min » à côté du prix, et la description en
infobulle.

---

## 4. Ce que reçoit une station qui termine l'assistant

1. **Catégories de prestations** : les cinq créées si la liste est vide.
2. **Prestations choisies** : une ligne par case cochée, avec son prix, sa
   **durée**, sa **description** et la catégorie de son modèle.
3. **Prestations personnalisées** : sans durée ni description, catégorie
   « Autres prestations » — c'est à la station de les compléter.

L'insertion reste idempotente sur le nom : rejouer la confirmation ne duplique
rien.

---

## 5. Le formulaire de prestation (CRUD complet)

L'écran **Prestations** permet désormais de créer, modifier, désactiver et
supprimer une prestation, en définissant les trois choses qui font son prix :

| Champ | Rôle |
|---|---|
| **Type de service** | Liste des 11 types du catalogue (ou « Prestation personnalisée »). En choisir un pré-remplit le nom, la catégorie, la durée, la description et le prix indicatif — tout reste modifiable. |
| **Catégorie de prestation** | Où la prestation se range (Lavage extérieur, Lavage intérieur, Lavage complet, Detailing & soins, Autres prestations). |
| **Prix (F CFA)** + **Durée** | Le prix de base et la durée, ceux qui s'appliquent quand aucun tarif véhicule n'est défini. |
| **Prix par famille de véhicule** | Neuf champs au plus : « le SUV, je le facture plus cher ». |
| **Prix par catégorie de véhicule** | Panneau replié, groupé par famille, un champ par catégorie réellement configurée dans la station. Le tarif d'une catégorie l'emporte sur celui de sa famille. Le champ vide affiche ce qui s'appliquera : « 3 000 (famille) » ou « 2 000 (prix de base) ». |

Le panneau des tarifs par catégorie s'ouvre d'office sur une prestation qui a
déjà de tels tarifs : un tarif en vigueur ne doit jamais devenir invisible,
donc incorrigible.

Choisir un type retrouve la catégorie de station correspondante par son nom
(`matchingServiceCategory` dans `src/config/service-categories.ts`) : le
gérant n'a pas à savoir que « Lavage moteur complet » se range dans « Lavage
extérieur ».

### Ordre de résolution du prix

```
tarif de la catégorie de véhicule  →  tarif de sa famille  →  prix de base
```

Une seule fonction, `resolveUnitPrice` (`src/lib/service-pricing.ts`), appelée
par le serveur **et** par les écrans : le prix affiché et le prix facturé ne
peuvent pas diverger.

### Suppression

| Situation | Réponse |
|---|---|
| Prestation jamais vendue | `204`, supprimée |
| Référencée par un lavage | `409 service_in_use` — l'historique garde son prix, on désactive |
| Avec des consommables rattachés | `204` : les consommables partent avec elle (leur clé étrangère bloquait la suppression en 500) |
| Prestation d'une autre station | `404` — l'identifiant d'une autre organisation ne doit rien révéler |

Chaque suppression est journalisée (`service.deleted`), après le COMMIT : une
suppression annulée ne laisse pas de trace dans l'audit.

---

## 6. Tests

| Fichier | Ce qu'il garantit |
|---|---|
| `tests/default-catalog.test.ts` | La liste exacte, dans l'ordre ; pas de doublon ; prix > 0 ; durée dans 1…1440 ; description présente ; chaque modèle tombe dans une catégorie existante |
| `tests/database-wiring.test.ts` | Le semis rejoué deux fois ne duplique pas ; le catalogue lu par l'API est la même liste ; la prestation créée par l'assistant a bien reçu sa durée et sa description |
| `tests/services-crud.test.ts` | Création avec catégorie de véhicule et prix ; le lavage facture le prix de la catégorie puis celui de la famille ; une modification s'applique au lavage suivant ; refus d'une catégorie étrangère ; suppression refusée si vendue, acceptée sinon, consommables compris ; isolation entre stations |

`npm test` : 908 tests, 0 échec. `tsc -b` 0 erreur, lint 0 erreur, build OK,
`npm run smoke` 69/69.

---

## 7. Ce qui reste ouvert

- **Ordre des prestations dans l'écran « Prestations »** : il trie par nom
  (`ORDER BY name`), pas selon l'ordre de vente du catalogue. Un `sort_order`
  sur `services` demanderait un glisser-déposer pour rester honnête.
- **Filtrage par catégorie de prestation** : la colonne existe, le filtre
  d'écran n'est pas posé.
- Les écrans Achats et Rapports affichent encore « XOF » par endroits.
- `max_services` reste affiché et non appliqué (CAT-04 de
  `ANALYSE-CATALOGUE-PRESTATIONS.md`).
