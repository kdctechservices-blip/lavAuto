# La base de données est-elle branchée à toutes les fonctionnalités ?

> Vérifié le 22 octobre 2026. Ce document n'est pas une intention : chaque
> ligne correspond à une table réellement écrite et relue, et le contrôle
> automatique qui le prouve tourne à chaque envoi (`npm test`).

## La question, et comment y répondre

« Est-ce que tout est bien en base ? » ne se tranche pas en lisant le code :
un écran peut répondre `200` en servant une liste vide, une constante, ou un
cache du navigateur. Il faut donc répondre sur trois plans, et chaque plan a
son contrôle :

| Plan | Contrôle | Ce qu'il attrape |
| --- | --- | --- |
| Écriture | `tests/database-wiring.test.ts` joue chaque parcours puis **compte les lignes** dans les tables attendues | une fonctionnalité qui n'écrit plus rien, ou qui écrit ailleurs |
| Lecture | le même test interroge les écrans correspondants avec les données qu'il vient de créer | une table remplie mais jamais lue (un fait perdu) |
| Schéma | le même test lit `server/db.ts` et le code serveur | une table morte, une requête sur une table inexistante |

À quoi s'ajoutent deux garde-fous de cohérence :

- `tests/referentials.test.ts` compare les listes dupliquées (catégories de
  dépense, moyens de paiement, tarifs semés) entre l'interface, le serveur et
  la base ;
- `npm run smoke` rejoue le parcours complet contre un vrai serveur, base en
  mémoire.

## Le tableau de correspondance

Chaque fonctionnalité de l'application, ses routes, et les tables qu'elle
touche réellement. Une table qui apparaît ici est écrite **et** relue par
l'écran correspondant.

### Compte, station et abonnement

| Fonctionnalité | Écran | Routes | Tables |
| --- | --- | --- | --- |
| Inscription | `/auth/sign-up` | `POST /auth/register` | `users`, `organizations`, `organization_members`, `onboarding_progress`, `auth_sessions` |
| Connexion / déconnexion | `/auth/sign-in` | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | `users`, `auth_sessions` |
| Mot de passe oublié / réinitialisé | `/auth/forgot-password`, `/auth/reset-password` | `POST /auth/forgot-password`, `GET|POST /auth/reset-password` | `password_reset_tokens`, `users`, `auth_sessions` |
| Profil | `/settings/account` | `PATCH /auth/profile`, `POST /auth/password` | `users`, `auth_sessions` |
| Configuration guidée | `/onboarding` | `PUT /onboarding/progress`, `POST /onboarding/confirm` | `onboarding_progress`, `sites`, `services`, `workers`, `vehicle_categories`, `subscriptions` |
| Abonnement et essai | `/settings/billing` | `GET /subscription`, `POST /subscription/checkout`, `POST …/declare` | `subscriptions`, `plans`, `payment_intents`, `subscription_payments` |
| Résiliation demandée | `/settings/billing` | `POST /subscription/closure` | `closure_requests`, `audit_logs` |
| Relances d'échéance | cron quotidien | `GET /cron/reminders` | `subscription_reminders`, `subscriptions`, `organization_members` |

### Opérations de la station

| Fonctionnalité | Écran | Routes | Tables |
| --- | --- | --- | --- |
| Tableau de bord | `/dashboard` | `GET /dashboard/metrics` | `washes`, `payments`, `cash_sessions` |
| Lavages | `/washes` | `GET|POST /washes`, `PATCH /washes/:id/status`, `POST /washes/:id/cancel` | `washes`, `wash_items`, `wash_assignments`, `stock_movements`, `audit_logs` |
| Détail d'un lavage | `/washes/:id` | `GET /washes/:id`, `GET /vehicles/:plate` | `washes`, `wash_items`, `wash_assignments`, `payments` |
| Encaissement | `/payments` | `POST /washes/:id/payments`, `POST /payments/:id/verify`, `POST /payments/:id/refund` | `payments`, `cash_movements`, `washes`, `audit_logs` |
| Reçu imprimable | `/washes/:id` | `POST /washes/:id/receipt`, `GET …/receipt/history` | `receipt_issues`, `washes`, `payments` |
| Caisse | `/cash-drawer` | `POST /cash-sessions/open`, `POST …/:id/movements`, `POST …/:id/close` | `cash_sessions`, `cash_movements`, `audit_logs` |
| Dépenses | `/expenses` | `GET|POST /expenses`, `PATCH /expenses/:id` | `expenses`, `cash_movements`, `audit_logs` |
| Historique | `/history` | `GET /washes`, `GET /audit-logs` | `washes`, `audit_logs` |

### Catalogue, stock et achats

| Fonctionnalité | Écran | Routes | Tables |
| --- | --- | --- | --- |
| Prestations | `/services` | `GET|POST /services`, `PATCH|DELETE /services/:id` | `services`, `audit_logs` |
| Catégories de prestation | `/service-categories` | `GET|POST /service-categories` | `service_categories` |
| Catégories de véhicule | `/vehicle-categories` | `GET|POST /vehicle-categories` | `vehicle_categories` |
| Sites | `/sites` | `GET|POST /sites`, `PATCH|DELETE /sites/:id` | `sites`, `audit_logs` |
| Produits et stock | `/stock` | `GET|POST /products`, `POST /stock-movements`, `POST /products/:id/inventory` | `products`, `product_categories`, `stock_movements` |
| Consommables par prestation | `/services` | `PUT /services/:id/consumables` | `service_consumables` |
| Achats | `/purchases` | `GET|POST /purchases`, `POST /purchases/:id/cancel` | `purchases`, `purchase_items`, `stock_movements`, `expenses` |
| Fournisseurs | `/purchases` | `GET|POST /suppliers` | `suppliers` |

### Équipe

| Fonctionnalité | Écran | Routes | Tables |
| --- | --- | --- | --- |
| Laveurs | `/team` | `GET|POST /workers`, `PATCH|DELETE /workers/:id` | `workers`, `audit_logs` |
| Membres et rôles | `/settings/access` | `GET /access/members`, `POST /access/members`, `PATCH /access/members/:id` | `organization_members`, `users`, `audit_logs` |
| Droits individuels | `/settings/access` | `PUT /access/members/:id/permissions/:permission` | `member_permissions`, `audit_logs` |
| Présences | `/team-attendance` | `POST /attendance/check-in`, `POST …/check-out`, `POST …/absence`, `PATCH /attendance/:id` | `attendance_records`, `audit_logs` |
| Plannings | `/work-schedules` | `GET|POST /work-schedules`, `DELETE /work-schedules/:id` | `work_schedules` |
| Performance de l'équipe | `/team-performance` | `GET /team-performance` | `wash_assignments`, `washes`, `workers` |

### Rapports, assistance et exploitation

| Fonctionnalité | Écran | Routes | Tables |
| --- | --- | --- | --- |
| Rapports et exports | `/reports` | `GET /reports/summary`, `GET /revenue/export` | `washes`, `payments`, `expenses`, `wash_items`, `wash_assignments`, `workers`, `sites` |
| Journal d'audit | `/history` | `GET /audit-logs`, `GET /audit-logs/filters` | `audit_logs` |
| Notifications | cloche de l'en-tête | `GET /notifications`, `POST /notifications/:id/read`, `POST …/read-all` | `notifications` |
| Assistance | `/support` | `GET|POST /support/requests`, `POST …/:id/messages` | `support_requests`, `support_messages` |
| Sauvegarde et export | `/settings/data` | `GET /backup/summary`, `GET /backup/export` | toutes les tables de l'organisation |
| Console de l'éditeur | `/console` | `/console/*` | `platform_operators`, `platform_operator_sessions`, `platform_audit_logs`, `organizations`, `subscriptions`, `subscription_payments`, `payment_intents`, `plans` |
| Surveillance | `/console/monitoring` | `GET /console/monitoring` | `request_metrics`, `error_events` |
| Anti-double-envoi | toutes les écritures | — | `idempotency_keys` |

## Ce qui a été corrigé lors de cette vérification

### 1. Les notifications étaient écrites mais jamais lues

La table `notifications` recevait bien une ligne à la clôture d'un lavage
(« Lavage terminé »), mais **aucune route ne la lisait** : le fait était
enregistré et perdu. Deux conséquences : l'équipe ne voyait jamais l'alerte, et
la colonne `read_at` — prévue pour l'acquittement — restait vide à jamais.

- `server/notifications.ts` ajoute `GET /api/v1/notifications`,
  `POST /api/v1/notifications/:id/read` et `POST …/read-all`, tous limités à
  l'organisation de la session.
- Le centre de notifications (`src/lib/notifications.tsx`) affiche ces lignes
  avec leur date réelle, et l'acquittement est enregistré **en base** : un
  lavage terminé signalé sur la caisse ne réapparaît pas sur le téléphone du
  gérant.

### 2. La table `expense_categories` ne servait à rien

Elle existait, n'était ni écrite ni lue, et les catégories de dépense étaient
de fait un vocabulaire fermé écrit dans le code. La table a été retirée du
schéma, de l'export de sauvegarde et de la purge d'organisation. La raison est
écrite à l'endroit où elle était créée : les rapports agrègent les dépenses par
catégorie, et une liste libre par station rendrait ces totaux incomparables.

La duplication restante — la même liste dans l'interface et dans le serveur —
est désormais surveillée par `tests/referentials.test.ts` : si l'un bouge sans
l'autre, le contrôle échoue avant que l'écran ne propose un choix que l'API
refuse.

## Ce qui reste volontairement non branché

Deux tables restent sans emploi, et c'est une décision, pas un oubli. Elles
sont nommées dans le test, qui échouerait si une **troisième** apparaissait
sans justification.

| Table | Situation | Décision |
| --- | --- | --- |
| `customers` | Jamais alimentée ; `washes.customer_id` jamais renseigné | Tranché le 21 octobre : on suit le véhicule (plaque), pas la personne. Le nom du client reste une mention libre sur le lavage (`washes.customer_name`), affichée sur le reçu |
| `clerk_webhook_events` | Vestige d'une authentification Clerk abandonnée | Suppression à planifier (aucun autre code ne la cite) |

## Comment vérifier soi-même

```bash
npm test -- tests/database-wiring.test.ts   # écriture + lecture + schéma
npm test -- tests/referentials.test.ts      # cohérence des listes dupliquées
npm run smoke                               # parcours complet sur un vrai serveur
```

Le premier de ces contrôles est celui qui répond à la question posée : il
exécute réellement l'inscription, la configuration, la caisse, un lavage, son
encaissement, son reçu, une dépense, un mouvement de stock, un achat, un
pointage, un planning, une invitation d'équipe, un changement de droits, une
demande d'assistance, une intention de paiement et un export — puis compte les
lignes table par table.
