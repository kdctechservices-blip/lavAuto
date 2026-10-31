# Permissions et garde-fous (RBAC) — WashPilot CI

Date : 20 octobre 2026.

Chaque utilisateur ne peut consulter et modifier que ce que le propriétaire de
la station lui autorise. Les autorisations sont vérifiées **par le serveur, à
chaque requête** : masquer un bouton dans l'interface n'est qu'un confort, ce
n'est jamais une protection.

---

## 1. Ce qui existait déjà, et ce qui a changé

L'audit du dépôt a précédé l'implémentation, pour ne pas créer un second
système d'authentification en parallèle du premier.

| Constat de l'audit | Suite donnée |
|---|---|
| Authentification par session maison (`requireSession`) et appartenance en base (`organization_members.role`) | **Conservées telles quelles** — ce sont elles qui portent le nouveau système |
| `requireRole("owner","manager")` répété sur 30 routes : contrôle par rôle, pas par action | Remplacé par `requirePermission("service:manage")` etc. — le droit porte sur l'action |
| **Aucune garde sur les lectures** : un caissier pouvait lire les rapports financiers, un laveur les dépenses | Toutes les lectures sont désormais gardées |
| Aucun moyen de changer le rôle d'un utilisateur | Routes de gestion des accès + écran dédié |
| Aucun moyen de révoquer un accès sans supprimer le compte | Désactivation d'appartenance, effective immédiatement |
| Rôle `cashier` déjà utilisé en base | **Conservé** plutôt que renommé : c'est un métier réel en station, et renommer aurait invalidé les comptes existants |

Le projet n'utilise ni Clerk ni Prisma : l'authentification est maison et
l'accès aux données passe par `pg` avec des requêtes SQL explicites. Les
principes de l'architecture demandée s'appliquent à l'identique, seuls les
outils diffèrent.

---

## 2. Les quatre rôles

| Rôle | Code | Vocation | Permissions |
|------|------|----------|-------------|
| Propriétaire | `owner` | Accès complet, y compris finances, droits et abonnement | 28 |
| Gérant | `manager` | Gestion opérationnelle quotidienne | 15 |
| Caissier | `cashier` | Tenue de la caisse et encaissements | 12 |
| Agent de lavage | `washer` | Consultation de son travail | 2 |

---

## 3. Matrice des permissions

Lecture : ✅ accordé par défaut · ⚙️ accordable à titre exceptionnel par le
propriétaire · ❌ refusé, non délégable.

| Action | Permission | Propriétaire | Gérant | Caissier | Agent |
|---|---|---|---|---|---|
| Tableau de bord | `dashboard:read` | ✅ | ✅ | ✅ | ⚙️ |
| Consulter les lavages | `wash:read` | ✅ | ✅ | ✅ | ✅ |
| Enregistrer un lavage | `wash:create` | ✅ | ✅ | ✅ | ⚙️ |
| Modifier un lavage | `wash:update` | ✅ | ✅ | ⚙️ | ⚙️ |
| **Faire avancer l'avancement d'un lavage** | `wash:status` | ✅ | ✅ | ✅ | ⚙️ |
| Annuler un lavage | `wash:cancel` | ✅ | ⚙️ | ⚙️ | ⚙️ |
| Consulter les encaissements | `payment:read` | ✅ | ✅ | ✅ | ⚙️ |
| Enregistrer un encaissement | `payment:create` | ✅ | ✅ | ✅ | ⚙️ |
| Confirmer un mobile money | `payment:verify` | ✅ | ✅ | ⚙️ | ⚙️ |
| **Rembourser un encaissement** | `payment:cancel` | ✅ | ❌ | ❌ | ❌ |
| Consulter la caisse | `cash_session:read` | ✅ | ✅ | ✅ | ⚙️ |
| Ouvrir / clôturer la caisse | `cash_session:manage` | ✅ | ✅ | ✅ | ⚙️ |
| Consulter les tarifs | `service:read` | ✅ | ✅ | ✅ | ✅ |
| **Modifier les tarifs** | `service:manage` | ✅ | ⚙️ | ⚙️ | ⚙️ |
| Consulter les laveurs | `worker:read` | ✅ | ✅ | ✅ | ⚙️ |
| Ajouter / modifier un laveur | `worker:create` / `worker:update` | ✅ | ✅ | ⚙️ | ⚙️ |
| Supprimer un laveur | `worker:delete` | ✅ | ⚙️ | ⚙️ | ⚙️ |
| Consulter les dépenses | `expense:read` | ✅ | ✅ | ✅ | ⚙️ |
| Enregistrer une dépense | `expense:create` | ✅ | ✅ | ✅ | ⚙️ |
| **Modifier / supprimer une dépense** | `expense:manage` | ✅ | ⚙️ | ⚙️ | ⚙️ |
| Rapports d'activité | `report:operational` | ✅ | ✅ | ✅ | ⚙️ |
| **Rapports financiers (marges, dépenses)** | `report:financial` | ✅ | ✅ | ⚙️ | ⚙️ |
| Exporter les rapports | `report:export` | ✅ | ⚙️ | ⚙️ | ⚙️ |
| Consulter l'historique des opérations | `audit:read` | ✅ | ✅ | ⚙️ | ⚙️ |
| **Gérer les utilisateurs et les droits** | `user:manage` | ✅ | ❌ | ❌ | ❌ |
| **Paramètres de la station** | `settings:manage` | ✅ | ❌ | ❌ | ❌ |
| **Abonnement** | `subscription:manage` | ✅ | ❌ | ❌ | ❌ |
| Exporter les données | `data:export` | ✅ | ⚙️ | ⚙️ | ⚙️ |

Les quatre permissions en ❌ ne sont **jamais** délégables : les accorder
reviendrait à permettre de contourner le système de rôles lui-même.

`expense:manage` est en gras sans être en ❌ : il reste techniquement
délégable, mais c'est la frontière de la séparation des tâches (section 11).
L'accorder se décide, ne se subit pas.

---

## 4. Les trois niveaux de contrôle

### Niveau 1 — Interface React

`src/lib/permissions.tsx` expose un point d'entrée unique :

```tsx
const manageCatalog = useAccess("service:manage", "catalog.manage")

<Button disabled={!manageCatalog.allowed} title={manageCatalog.reason ?? undefined}>
  Modifier le tarif
</Button>
```

`useAccess(permission, capability)` combine deux questions distinctes :
le **rôle** autorise-t-il l'action (RBAC), et le **forfait** l'inclut-il
(essai gratuit, plan payant) ? Le rôle prime : inutile de proposer un
changement de forfait à quelqu'un qui n'aurait de toute façon pas le droit.

La navigation est filtrée par la même source : un gérant ne voit ni
« Dépenses », ni « Gestion des accès », ni « Données et sauvegarde ».

### Niveau 2 — Serveur Express

```ts
r.patch("/services/:id", requirePermission("service:manage"), asyncRoute(...))
r.get("/expenses",      requirePermission("expense:read"),   asyncRoute(...))
```

Ordre des middlewares, du plus général au plus précis (`server/app.ts`) :

1. `requireSession` — qui êtes-vous ? sinon **401** ;
2. `requireTenantContext` — quelle station, quel rôle, compte actif ? sinon **403** ;
3. `attachSubscription` — que permet le forfait ?
4. `requirePermission(...)` — posé sur chaque route, sinon **403**.

`requireTenantContext` calcule les permissions effectives une fois par requête
et les attache à `req.tenant`. Pour les décisions qui dépendent des données,
`assertPermission(req, "...")` s'utilise à l'intérieur d'un gestionnaire.

### Niveau 3 — Base de données

Chaque enregistrement porte son `organization_id`, et **toute** requête filtre
dessus. L'organisation provient de l'appartenance en base, jamais d'un
paramètre du navigateur :

```ts
"SELECT ... FROM washes WHERE id=$1::uuid AND organization_id=$2::uuid"
```

Un identifiant valide appartenant à une autre station renvoie donc 404, et non
les données.

---

## 5. Exceptions accordées par le propriétaire

Les besoins réels ne rentrent pas toujours dans trois cases. Le propriétaire
peut donc, depuis **Paramètres → Gestion des accès**, accorder une permission
supplémentaire à un membre précis, ou lui retirer une permission venant de son
rôle.

```
PUT /api/v1/access/members/:userId/permissions/expense:create
{ "granted": true }   → autorisation exceptionnelle
{ "granted": false }  → retrait explicite
{ "granted": null }   → retour au droit par défaut du rôle
```

Exemple typique : autoriser un gérant à enregistrer les dépenses, sans pour
autant lui ouvrir les marges de la station (`report:financial` reste refusé).

Permissions effectives = permissions du rôle − retraits explicites +
autorisations exceptionnelles, les permissions réservées au propriétaire étant
systématiquement écartées.

---

## 6. Garde-fous métier

| Situation | Règle appliquée |
|---|---|
| Un utilisateur modifie son propre rôle | Refusé (**403**) et journalisé (`access.denied`) |
| Un gérant s'attribue le rôle propriétaire | Refusé : il n'a pas `user:manage` |
| Le dernier propriétaire est rétrogradé ou désactivé | Refusé (**409 last_owner**) |
| Une permission réservée est déléguée | Refusé (**403 permission_not_grantable**) |
| Un membre change de rôle | Ses exceptions précédentes sont supprimées |
| Un membre est désactivé | Toutes ses requêtes sont refusées dès l'appartenance, sans attendre l'expiration de sa session |
| Un encaissement doit être annulé | Jamais supprimé : passage en « remboursé », motif obligatoire, sortie de caisse correspondante, journalisation |
| Un encaissement en espèces sans caisse ouverte | Refusé |
| Un lavage déjà annulé | Nouvel encaissement refusé |
| Un paiement enregistré deux fois | Clé d'idempotence obligatoire |
| Un identifiant d'une autre station | Introuvable (404) |

Le journal d'audit conserve `organization_id`, `actor_user_id`, `action`,
`entity_type`, `entity_id`, `created_at` et les valeurs avant/après pour les
changements de rôle. Aucun mot de passe ni jeton n'y figure.

---

## 7. Contrat d'API

| Route | Permission | Usage |
|---|---|---|
| `GET /api/v1/me/permissions` | — (tout membre) | Rôle et permissions de l'utilisateur connecté ; source unique de l'interface |
| `GET /api/v1/access/roles` | `user:manage` | Référentiel des rôles et des permissions |
| `GET /api/v1/access/members` | `user:manage` | Membres, rôles, statuts et droits effectifs |
| `PATCH /api/v1/access/members/:userId` | `user:manage` | Change le rôle et/ou le statut (`active` / `disabled`) |
| `PUT /api/v1/access/members/:userId/permissions/:permission` | `user:manage` | Accorde, retire ou réinitialise une permission |
| `POST /api/v1/payments/:id/refund` | `payment:cancel` | Remboursement tracé, motif obligatoire |

---

## 8. Tests

33 tests dédiés, sur 113 au total.

`tests/permissions.test.ts` (17) — la matrice elle-même : droits de chaque
rôle, refus par défaut d'un rôle inconnu, exceptions, permissions non
délégables, et le middleware (401 sans session, 403 sans droit).

`tests/authorization-api.test.ts` (16) — la vraie API, avec de vraies
sessions, sur la même pile de middlewares qu'en production :

- un utilisateur non connecté reçoit 401 ;
- le propriétaire modifie un tarif, le gérant reçoit 403 sur le même appel ;
- le gérant enregistre bien un lavage dans sa station ;
- le gérant ne reçoit ni dépenses ni marge (`financial_access: false`) ;
- l'agent de lavage est refusé sur encaissements, caisse, dépenses, rapports
  et tableau de bord, mais consulte ses lavages ;
- gestion des accès, export de données et liste des utilisateurs sont
  réservés au propriétaire ;
- modifier son propre rôle est refusé et journalisé ;
- une permission accordée prend effet immédiatement, et son retrait aussi ;
- une permission réservée au propriétaire ne se délègue pas ;
- un membre désactivé est refusé partout, puis retrouve l'accès sans se
  reconnecter ;
- la station conserve toujours un propriétaire actif ;
- un identifiant appartenant à une autre station reste introuvable.

```bash
npm test                                      # 113 tests
npx tsx --test tests/authorization-api.test.ts
```

---

## 9. Comptes de démonstration

Même mot de passe pour tous : `WashPilot2026!`

| Compte | Rôle |
|---|---|
| `demo@washpilot.ci` | Propriétaire |
| `gerant@washpilot.ci` | Gérant |
| `caisse@washpilot.ci` | Caissier |
| `laveur@washpilot.ci` | Agent de lavage |

Connectez-vous avec chacun : la navigation, les boutons et les réponses de
l'API changent ensemble.

---

## 10. Limites assumées

- **Un rôle par organisation et par utilisateur.** Le schéma
  (`UNIQUE(user_id, organization_id)`) le garantit. Un utilisateur membre de
  plusieurs stations reçoit le contexte de la première ; un sélecteur de
  station reste à construire le jour où le cas se présentera.
- **Pas d'invitation par e-mail.** La gestion des accès agit sur les membres
  existants ; l'ajout d'un utilisateur passe encore par l'inscription.
- **Permissions par station, pas par site.** Un gérant autorisé l'est sur
  toute l'organisation, pas sur un site précis. À revoir le jour où une
  station exploitera plusieurs sites avec des équipes distinctes.

---

## Cumul avec le forfait

Les permissions de ce document répondent à une seule question : **cette
personne a-t-elle le droit ?** Elles ne disent rien de ce que l'organisation a
souscrit. Un second verrou, indépendant, répond à l'autre question :
**l'organisation a-t-elle acheté cette fonction ?**

| Verrou | Portée | Refus | Code |
|--------|--------|-------|------|
| `requirePermission` | la personne | définitif | 403 `forbidden` |
| `requireCapability` | l'organisation | levable par un achat | 402 `plan_upgrade_required` |

**Le rôle se vérifie avant le forfait.** L'ordre n'est pas une question de
style : proposer un forfait supérieur à quelqu'un qui n'aurait de toute façon
pas le droit d'agir l'envoie réclamer une dépense inutile. Un caissier à qui
l'historique est refusé voit un refus de rôle, jamais une proposition d'achat
— et ce, même sur un forfait Business où la fonction est bien incluse.

Corollaire : **le forfait ne connaît pas les rôles.** Sur un forfait Starter,
le gérant et le propriétaire reçoivent le même écran d'argumentaire pour
l'historique. La hiérarchie des rôles ne réapparaît qu'une fois la fonction
souscrite.

Le détail des fonctions gardées, forfait par forfait, est dans `TARIFS.md`
section 7. L'interface applique la même priorité via `useAccess(permission,
capability)` et le composant `PlanGate`.

## Navigation : la permission d'une entrée de menu

Règle : **une entrée de la barre latérale exige la permission de l'action que
sa page permet**, pas celle qui autorise à la lire.

La nuance n'est pas cosmétique. Le serveur laisse tout porteur de `wash:read`
lire `GET /sites`, mais créer, modifier ou désactiver une station exige
`settings:manage`, réservé au propriétaire. L'entrée « Stations » a d'abord
été déclarée avec `wash:read` : un agent de lavage voyait donc apparaître une
rubrique « Configuration » ne contenant qu'un écran dont tous les boutons
étaient grisés. Le même raisonnement qu'en section « Cumul avec le forfait »
s'applique : on n'annonce pas une porte qu'on ne peut pas ouvrir. L'entrée
exige désormais `settings:manage`.

L'URL `/sites` reste atteignable en lecture pour qui a `wash:read` — rien
n'est interdit qui ne l'était, seule l'annonce change.

Ce que chaque rôle voit aujourd'hui :

| Entrée | Permission | Propriétaire | Gérant | Caissier | Agent |
|---|---|:-:|:-:|:-:|:-:|
| Tableau de bord | `dashboard:read` | ✓ | ✓ | ✓ | — |
| Nouveau lavage | `wash:read` | ✓ | ✓ | ✓ | ✓ |
| Encaissements | `payment:read` | ✓ | ✓ | ✓ | — |
| Caisse | `cash_session:read` | ✓ | ✓ | ✓ | — |
| Dépenses | `expense:read` | ✓ | ✓ | ✓ | — |
| Rapports | `report:operational` | ✓ | ✓ | ✓ | — |
| Historique | `audit:read` | ✓ | ✓ | — | — |
| Équipe | `worker:read` | ✓ | ✓ | ✓ | — |
| Catalogue | `service:read` | ✓ | ✓ | ✓ | ✓ |
| Stations | `settings:manage` | ✓ | — | — | — |
| Gestion des accès | `user:manage` | ✓ | — | — | — |
| Paramètres | libre | ✓ | ✓ | ✓ | ✓ |

`tests/navigation.test.ts` verrouille l'ensemble : toute page du disque est
déclarée dans une route, toute entrée de menu pointe vers une route existante,
toute route applicative est atteignable depuis le menu — sauf exceptions
nommées et motivées — et l'entrée Stations exige bien `settings:manage`.

---

## 11. Décisions de privilèges

Un changement de matrice n'est pas un correctif : il déplace un droit d'une
personne à une autre, chez tous les clients, au déploiement. Chaque
modification est donc consignée ici — date, constat, décision, portée — avant
d'être écrite dans `server/permissions.ts`.

### 2026-10-20 — Le gérant supervise les dépenses

**Constat.** Le caissier détenait `expense:read` et `expense:create` ; le
gérant, ni l'un ni l'autre. La hiérarchie de supervision était donc inversée
sur le seul domaine où elle compte le plus.

L'enjeu n'était pas le confort d'un écran. Une dépense réglée en espèces
insère un mouvement `type='exit'`, `source='expense'` dans la session de
caisse ouverte (`server/operations.ts`). Or le caissier détient
`cash_session:manage` : il ouvre et clôture lui-même cette session. Le montant
attendu à la clôture se calcule à partir des mouvements, dépense comprise.

Conséquence : un caissier pouvait sortir 10 000 F du tiroir, les enregistrer
en dépense, et clôturer avec un **écart nul**. L'opération était régulière en
apparence, et aucun échelon entre lui et le propriétaire ne pouvait la voir.
Dans une station où le propriétaire est absent ou gère plusieurs sites, le
contrôle n'existait pas.

**Décision.** Le rôle `manager` obtient :

| Permission | Motif |
|---|---|
| `expense:read` | Referme le trou de supervision. Lecture non destructive, tracée, réversible. |
| `expense:create` | Sans elle, un gérant qui achète des consommables fait enregistrer la dépense par son caissier, qui en devient l'auteur apparent. Refuser la permission **fabriquait un journal d'audit faux** — pire que de l'accorder. |
| `report:financial` | Donner le détail des dépenses en retenant leur total ne protège rien : le gérant peut les additionner. Seul l'écran devenait incohérent. |

**Ce qui n'a pas bougé.** `expense:manage` (modifier, supprimer) reste au
propriétaire. C'est la vraie frontière, et elle était déjà au bon endroit :
**on délègue l'enregistrement, jamais la réécriture.** Sans cela, qui puise
dans la caisse pourrait effacer la trace de sa sortie.

**Pourquoi le défaut du rôle et non une exception par membre.** Le
propriétaire pouvait déjà accorder `expense:read` à son gérant au cas par cas
(`expense:read` figure dans `GRANTABLE_PERMISSIONS`). Le critère retenu :

> Une permission appartient au rôle quand **tous** les clients feraient la
> même exception. Elle reste une exception quand elle dépend de la personne.

Aucun propriétaire ne souhaite un gérant aveugle aux sorties d'argent. Le
défaut était donc faux, et le rattraper client par client revenait à leur
faire payer un défaut de conception.

**Porte de sortie.** Le nouveau défaut n'est pas imposé. Un propriétaire en
désaccord retire la permission à un gérant nommé, sans changer son rôle :

```http
PUT /api/v1/access/members/:userId/permissions/expense:read
{ "granted": false }
```

Le retrait est ciblé — le reste du rôle reste intact. Vérifié par le test
« le propriétaire peut retirer à un gérant les dépenses venues du rôle ».

**Effet de bord assumé.** Le cloisonnement financier n'a pas disparu, il s'est
déplacé : c'est désormais le **caissier** qui marque la frontière des rapports
(`financial_access: false`), là où c'était le gérant. L'entrée « Dépenses »
apparaît dans sa barre latérale.

**Verrouillage.** `tests/permissions.test.ts` fige l'empreinte exacte de
chaque rôle et vérifie qu'aucun subordonné ne détient sur les dépenses un
droit que son supérieur n'a pas. Faire échouer ce test n'est pas un incident :
c'est le signal qu'un droit change de main, et qu'il faut d'abord écrire la
décision dans cette section.

### 2026-10-21 — Le stock entre dans la matrice (lot L3)

**Constat.** Le domaine du stock n'existait pas : ni table, ni route, ni
permission. Trois droits sont créés.

| Permission | Couvre |
|---|---|
| `stock:read` | Consulter les produits, leur stock et l'historique des mouvements |
| `stock:manage` | Créer et modifier un produit ou une catégorie, fixer le coût unitaire et le seuil d'alerte |
| `stock:move` | Enregistrer une entrée, une sortie, un inventaire, ou contrepasser un mouvement |

**Décision.** Le rôle `manager` reçoit les trois. Le caissier et l'agent de
lavage n'en reçoivent aucune.

**Pourquoi le gérant reçoit `stock:move` et pas seulement la lecture.** C'est
exactement le raisonnement du 20 octobre sur les dépenses. En station, c'est
le gérant qui réceptionne les bidons et qui compte les étagères. S'il n'a pas
le droit d'enregistrer le mouvement, il le fait saisir par son caissier — qui
en devient l'auteur apparent dans `audit_logs`. Refuser la permission ne
protège rien et **fabrique un journal d'audit faux**.

**Pourquoi le caissier n'a rien par défaut.** Son métier est le tiroir, pas la
réserve. Le refus par défaut s'applique. Une station où le caissier gère
réellement le stock peut lui accorder `stock:move` au cas par cas — les trois
permissions sont délégables.

**Pourquoi aucune n'est réservée au propriétaire.** `OWNER_ONLY_PERMISSIONS`
protège ce qui permettrait de contourner le système : les utilisateurs, les
paramètres, l'abonnement, le remboursement. Le stock ne touche à aucun de ces
leviers.

**La frontière « enregistrement / réécriture » est tenue autrement.** Ici elle
n'est pas portée par une permission mais par le modèle de données : un
mouvement de stock **ne peut être ni modifié ni supprimé**, seulement
contrepassé par un mouvement inverse qui le référence
(`reverses_movement_id`). Même le propriétaire ne peut pas réécrire un
mouvement passé. C'est plus fort qu'un droit, parce que c'est structurel.

**Le coût unitaire ne réécrit jamais le passé.** `stock:manage` permet de
changer le coût d'un produit, mais chaque mouvement fige le coût appliqué au
moment où il est écrit (`unit_cost_cents`), exactement comme `wash_items` fige
le prix d'une prestation. Augmenter le prix d'un bidon demain ne change pas la
valeur des sorties d'hier.

**Verrouillage.** `tests/permissions.test.ts` passe de 18 à 21 permissions
attendues pour le gérant, et de 28 à 31 pour le propriétaire.

### 21 octobre 2026 — Les fournisseurs et les achats (lot L5)

Deux permissions s'ajoutent.

| Permission | Ce qu'elle ouvre |
| --- | --- |
| `supplier:manage` | Créer et tenir à jour la liste des fournisseurs |
| `purchase:manage` | Enregistrer un achat, le consulter, l'annuler |

**Le gérant les reçoit toutes les deux.** C'est lui qui va au marché et qui
revient avec les sachets. Lui refuser l'achat produirait l'un des deux maux
que la matrice existe pour éviter : ou bien le propriétaire ressaisit après
coup une marchandise qu'il n'a pas vue arriver, ou bien le gérant emprunte le
compte d'un autre. Dans les deux cas le journal devient faux.

**Le caissier ne les reçoit pas.** Le prix d'achat des produits n'est pas de
son ressort, et une consultation suffirait à le lui apprendre : la lecture est
donc fermée au même titre que l'écriture. Un caissier reçoit un **403**, jamais
un 402 — on ne propose pas un abonnement à qui n'aura pas le droit ensuite.

**Pas de permission de lecture séparée.** `purchase:manage` ouvre la liste et
la fiche autant que l'enregistrement. Découper serait gratuit : les trois
personnes qui consultent les achats sont les trois qui les font.

**Le forfait réutilise `stock.manage`.** Les achats n'existent que pour
alimenter le stock ; ils relèvent de la même promesse commerciale. Une
capacité de plus ne vendrait rien de neuf et doublerait les chemins à garder
cohérents — la leçon du lot précédent était justement : **une seule clé par
module**.

**Verrouillage.** `tests/permissions.test.ts` passe de 21 à 23 permissions
attendues pour le gérant, et de 31 à 33 pour le propriétaire.

### 21 octobre 2026 — L'avancement opérationnel d'un lavage (`wash:status`)

**Constat.** Un lavage est enregistré quand il est rendu : il naît donc
`status = 'completed'`, et tout le comptable — rapports, rendement des
laveurs, encaissements — repose sur cette valeur. Mais la station vit aussi
d'une autre réalité : la voiture attend, le laveur est en train, la voiture
est prête. Cette réalité n'avait aucune place dans le produit.

Une seule colonne ne pouvait pas porter les deux : faire naître les lavages en
`pending` aurait vidé les rapports d'une station entière le jour où elle
commence à enregistrer — le manager aurait vu « 0 lavage terminé » alors que
la station en avait encaissé trente.

**Décision.** Une **seconde** colonne, `operation_status`, porte l'avancement
physique : `pending` (en attente) → `in_progress` (en cours) → `completed`
(terminé). Le statut comptable ne bouge pas.

La permission qui la fait bouger est `wash:status`, et elle va plus loin que
`wash:update` :

| Rôle | `wash:status` | Pourquoi |
|---|---|---|
| Propriétaire | ✅ | Par définition. |
| Gérant | ✅ | Il supervise l'activité de la station. |
| Caissier | ✅ | C'est **son** poste : il enregistre le lavage et suit la voiture. Lui refuser ce geste l'obligerait à quitter le comptoir pour une opération de terrain. |
| Agent de lavage | ❌ | Il fait le lavage, il ne le *déclare* pas terminé : c'est la station qui sait, pas celui qui a les mains dans la mousse. Le geste reste accessible à ceux qui tiennent le comptoir et la supervision. |

`wash:update` (modifier le contenu d'un lavage) n'a pas bougé : continuer à
modifier un lavage déjà enregistré reste une décision de gestion, pas de
terrain.

**Ce que la permission ne permet pas.** Elle ne touche ni un montant, ni un
mouvement de caisse, ni une ligne de stock, ni le statut comptable. Elle écrit
une seule colonne et laisse une trace (`wash.status_changed` dans le journal
d'audit). Un lavage annulé ne se fait plus avancer.

**Verrouillage.** `tests/permissions.test.ts` passe de 25 à 26 permissions
attendues pour le gérant, de 12 à 13 pour le caissier, et de 36 à 37 pour le
propriétaire. L'agent de lavage ne reçoit pas la permission : la pastille
reste un texte, sans lien.

**Verrouillage du comportement.** `tests/wash-operation-status-api.test.ts`
exerce la route de bout en bout : l'avancement s'écrit, il ne touche ni au
montant ni au statut comptable ni aux encaissements, il laisse une trace
d'audit, et il est refusé au laveur (403), gelé sur un lavage annulé (409) et
invisible depuis une autre organisation (404).

### 22 octobre 2026 — Les tâches à la station

Une permission, mais un écran de plus : la même `wash:status` sert désormais à
faire tourner le décompte du temps de lavage.

**Le panneau « À la station ».** Chaque lavage en attente ou en cours a une
carte : le nom du client, la plaque, le laveur, et une barre de progression.
Un clic sur une carte qui attend lance le décompte ; un clic sur une carte qui
tourre demande confirmation avant de la terminer. Quand le temps estimé est
écoulé, la tâche se termine d'elle-même et une notification le dit.

**La permission n'a pas bougé.** Le geste de terrain reste à ceux qui tiennent
le poste — comptoir et supervision. L'agent de lavage voit les cartes, mais
elles ne sont pas cliquables : il fait le travail, il ne le déclare pas
terminé.

**Ce que l'écran ajoute au lavage.** Trois colonnes, sans effet comptable :
`customer_name` (une étiquette de comptoir, ni téléphone ni fiche),
`estimated_minutes` (la durée des prestations, figée à l'enregistrement) et
`operation_started_at` (l'instant du départ du décompte). La carte est une
vue de terrain ; le tableau historique reste la source.

**Verrouillage.** `tests/wash-countdown.test.ts` et `tests/wash-tasks.test.ts`
vérifient le calcul du décompte et le tri des cartes ; l'API est vérifiée dans
`tests/wash-operation-status-api.test.ts`.
