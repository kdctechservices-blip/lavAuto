# Analyse complète du projet — WashPilot CI / LAV'AUTO

**Date de l'analyse :** 31 octobre 2026 (UTC)  
**Branche examinée :** `arena/fc0a752e-lavauto`  
**Révision examinée :** `4fe0293` (snapshot initial de la branche)  
**Nature :** revue statique de l'architecture et des contrôles, complétée par build, tests, lint, audits des dépendances et parcours smoke.  
**Modifications fonctionnelles :** aucune. Ce document est le seul ajout de cette analyse.

---

## 1. Synthèse exécutive

WashPilot CI est un SaaS opérationnel de gestion de stations de lavage, bien au-delà d'un simple tableau de bord. Le dépôt contient une SPA React/TypeScript, une API Express/TypeScript, un schéma PostgreSQL étendu, des parcours métier de caisse et de paiement, le contrôle d'accès par organisation, une console opérateur isolée, des fonctions de stock/achats/présences, un mode hors connexion et plusieurs cibles de déploiement.

**État technique vérifié :**

- `npm ci` réussit ; Node installé dans l'environnement : 22.22.3.
- `npm run build` réussit : vérification TypeScript puis build Vite (5 599 modules transformés).
- `npm test` réussit : **1 049 tests passés, 0 échec**, répartis dans 80 fichiers de tests.
- `npm run smoke` réussit : **69/69 vérifications** du parcours applicatif/API local.
- `npm run smoke:serverless` réussit : **60/60 vérifications** sur le bundle et le simulateur serverless.
- `npm run lint` réussit sans erreur, mais avec **27 avertissements**.
- `npm audit --omit=dev` : **0 vulnérabilité de dépendance de production**. L'audit complet relève 17 vulnérabilités (15 modérées, 2 faibles), dans l'arbre de développement (ESLint, TypeScript ESLint, shadcn et transitifs).

**Conclusion :** base logicielle mûre et cohérente, avec une bonne couverture des flux API et des règles métier. Les principales réserves concernent le durcissement de l'isolation RLS en cas de mauvaise configuration, la conservation possible d'un jeton de réinitialisation dans les traces d'incident, la politique de mot de passe (5 caractères) et quelques défauts de câblage/traitement d'erreur. Les tests et le build sont verts, mais ils ne remplacent ni une revue d'environnement de production ni des tests navigateur et d'intégration auprès des fournisseurs réels.

---

## 2. Périmètre et inventaire

Le dépôt comprend environ **90 999 lignes** sur les fichiers TypeScript/TSX de `server/`, `src/` et `tests/` (comptage brut, incluant les tests), avec :

- **66 fichiers TypeScript serveur** ;
- **253 fichiers TypeScript/TSX frontend** ;
- **80 fichiers de tests** ;
- un schéma SQL important centralisé dans `server/db.ts` (environ 96 Ko) ;
- une documentation métier/opérationnelle abondante (déploiement, base, RBAC, caisse, stock, paiements, reçus, support, etc.).

Les chiffres décrivent le dépôt analysé, pas nécessairement le code exécuté ou les données de production.

### Technologies principales

| Domaine | Choix |
|---|---|
| Interface | React 19, Vite 8, TypeScript 6, React Router 7, Tailwind CSS 4, CoreUI, composants shadcn/ui, Recharts, Framer Motion |
| API | Express 5, TypeScript exécuté par `tsx`, API REST sous `/api/v1` |
| Stockage | PostgreSQL via `pg`, PGlite pour les tests et environnements locaux sans base externe |
| Authentification | Comptes maison, mots de passe scrypt, sessions opaques, cookies httpOnly ; authentification applicative propre, stockée dans PostgreSQL |
| Déploiements | serveur Node/Docker, Vercel serverless (bundle API dédié) |
| Tests | `node:test`, tests unitaires/intégration avec PGlite, smoke tests locaux et simulateur serverless |

---

## 3. Architecture et responsabilités

### Backend

`server.ts` construit le serveur HTTP, configure les en-têtes, CORS, les sondes de santé, Express, le middleware Vite en développement et le service statique en production. Le montage des API est isolé dans `server/app.ts`, ce qui permet aux tests d'exercer la même chaîne de middleware que l'application.

L'API sépare les domaines métier en routeurs/services :

- **socle** : `env.ts`, `db.ts`, `http.ts`, `auth.ts`, `tenant.ts`, `tenant-context.ts` ;
- **tenants, rôles, autorisations** : `permissions.ts`, `access.ts`, `plan-limits.ts`, `entitlements.ts` ;
- **station** : catalogue, sites, lavages, reçus, caisse, dépenses, paiements, notifications ;
- **opérations** : stock, fournisseurs, achats, compteurs, horaires, présences, rendement ;
- **SaaS** : onboarding, abonnement, paiement d'abonnement, demandes de support ;
- **éditeur** : console d'administration, opérateurs, surveillance, rapprochement et journaux d'audit ;
- **exploitation** : sauvegarde/restauration, rappels, alertes, détection d'incidents et export.

### Frontend

La SPA est organisée par pages (`src/app/`), composants partagés (`src/components/`), console de l'éditeur (`src/console/`), configuration (routes, navigation, tarifs) et clients API/types (`src/lib/`). Les pages sont déclarées en chargement différé dans `src/config/routes.tsx`. L'authentification, les permissions, l'abonnement, les mutations, la synchronisation hors ligne et le service worker ont des modules dédiés.

### Base de données

Le schéma PostgreSQL est créé/complété au démarrage par des déclarations idempotentes. Il couvre notamment : organisations, membres, abonnements, stations, prestations, véhicules, laveurs, clients, lavages et lignes, paiements, caisses et mouvements, dépenses, stock, achats, fournisseurs, présence, compteurs, jetons de session et de réinitialisation, idempotence, permissions, reçus, notifications, demandes de support, audit et monitoring.

### Multi-tenant et autorisations

Le principe de base est correct : l'organisation active vient de la session et de `organization_members`, pas d'un identifiant de tenant arbitraire fourni par le navigateur. La pile est :

1. session authentifiée ;
2. contexte d'organisation et de rôle ;
3. abonnement/état du forfait ;
4. permission RBAC sur chaque route ;
5. limite de capacité/capacité du forfait sur les opérations concernées.

Les droits sont refusés par défaut et le frontend partage le référentiel de permissions pour afficher les actions compatibles. Des tests dédiés couvrent les rôles, les limites, l'accès API et l'isolation entre organisations.

En défense supplémentaire, `server/db-rls.ts` applique un rôle PostgreSQL restreint (`washpilot_app`) et le paramètre `app.current_org`, puis nettoie la connexion avant retour au pool. La documentation signale explicitement l'incompatibilité avec les poolers en mode transaction.

---

## 4. Fonctionnalités produit observées

1. **Site public et acquisition** : pages d'accueil, fonctionnalités, démonstration, tarifs et FAQ.
2. **Création de compte et onboarding** : assistant persistant configurant station, prestations, équipe et forfait, avec confirmation transactionnelle.
3. **Gestion multi-sites** : sites physiques, accès selon rôle et capacités du plan.
4. **Catalogue** : prestations, catégories, tarifs, tarification par catégorie de véhicule et nomenclature de véhicules.
5. **Opérations de lavage** : création, attribution des laveurs, étapes opérationnelles, historique, reçus imprimables et annulation/remboursement.
6. **Encaissement et caisse** : paiements, sessions, mouvements, dépenses, solde théorique, clôture et justification des écarts.
7. **Abonnements** : période d'essai, lecture seule après expiration/suspension, demandes d'évolution et traitement par la console.
8. **Équipe** : comptes et rôles, laveurs, horaires, pointage/présence, correction et performance.
9. **Stock et achats** : produits, consommables liés aux prestations, mouvements, fournisseurs et achats.
10. **Pilotage** : tableau de bord, rapports opérationnels/financiers et indicateurs de services, paiements et dépenses.
11. **Console éditeur** : gestion des stations/comptes/opérateurs, paiements, surveillance, support et rapprochements.
12. **Résilience** : file hors ligne, identifiants d'idempotence, export/sauvegarde et fonctions de rappel/alertes.

Les reçus sont décrits par le projet comme des reçus internes imprimables, et non comme des reçus fiscaux normalisés DGI ; cette distinction est correctement rappelée dans la documentation produit.

---

## 5. Qualité logicielle et protections en place

### Points solides

- **Argent en entiers** : stockage en centimes et calculs entiers, évitant les erreurs d'arrondi flottant.
- **Prix historiques** : les lignes de lavage conservent les noms et prix vendus, indépendamment d'une modification ultérieure du catalogue.
- **Idempotence** : utilisée sur des mutations métier sensibles, avec détection de réutilisation d'une clé pour un contenu différent et rejeu explicite.
- **Concurrence** : transactions, verrous de ligne et verrous advisory sur des opérations qui ne doivent pas se doubler (caisse, capacités, onboarding, etc.).
- **Sessions** : jetons aléatoires de 32 octets ; seul leur SHA-256 est enregistré en base ; cookie httpOnly ; sessions révocables.
- **Mots de passe** : dérivation scrypt, salage individuel et comparaison en temps constant.
- **Réinitialisation** : jeton à usage unique, durée limitée, empreinte uniquement en base, réponse générique pour réduire l'énumération de comptes.
- **Erreurs API** : réponses d'erreur sans fuite des détails internes pour les erreurs serveur ; journalisation d'incident et redaction des champs sensibles du corps.
- **Sauvegarde PostgreSQL et Docker** : documentation et scripts dédiés ; la base Docker n'est pas exposée au réseau public par défaut.
- **Tests de contrats métier** : bon volume de tests sur les workflows sensibles, les rôles et les barrières inter-tenant.
- **Déploiement serverless pensé explicitement** : bundle dédié, réécriture Vercel et smoke test simulé pour les chemins API profonds.

### Limites de preuve

- Les tests utilisent principalement PGlite : ils valident les usages SQL et les règles métier, mais pas tous les comportements d'un PostgreSQL managé réel, notamment les rôles, les permissions, le TLS, le pooler et les limites spécifiques de l'hébergeur.
- Le simulateur serverless ne certifie pas le comportement de la plateforme Vercel en production, ni la configuration DNS, secrets, cron ou régions.
- Les smoke tests couvrent le parcours API et la présence de pages/modules, pas une campagne E2E visuelle complète dans plusieurs navigateurs et tailles d'écran.
- Aucun état réel des secrets, de la base, de la sauvegarde restaurable, des fournisseurs e-mail/WhatsApp ou du domaine de production n'est vérifié dans cette analyse.

---

## 6. Résultats des contrôles exécutés

| Contrôle | Résultat | Remarque |
|---|---:|---|
| `npm ci` | ✅ | 560 paquets installés ; l'audit npm signale des vulnérabilités de développement, détaillées ci-dessous. |
| `npm run build` | ✅ | `tsc -b` et Vite réussissent ; CSS principal compilé à environ 603 Ko non compressés. |
| `npm test` | ✅ | 1 049 tests passés, aucun échec ; environ 3 min 46 s dans cet environnement. |
| `npm run smoke` | ✅ | 69/69 vérifications, incluant inscription, onboarding, lavage, paiement, reçu, remboursement, clôture et console. |
| `npm run smoke:serverless` | ✅ | 60/60 vérifications du parcours API après bundling. Le test serverless ne vérifie pas les pages servies par la plateforme. |
| `npm run lint` | ✅ | 0 erreur, 27 avertissements (Fast Refresh, React Hook Form/React Compiler et dépendance de hook). |
| `npm audit --omit=dev` | ✅ | 0 vulnérabilité dans les dépendances de production. |
| `npm audit` | ⚠️ | 17 avis dans l'arbre de développement : 15 modérés et 2 faibles ; notamment ESLint/TypeScript ESLint, minimatch et shadcn/deepmerge. Aucun avis critique ou élevé dans le rapport reçu. |

---

## 7. Constats et risques, par priorité

### P1 — Durcir le démarrage si la protection RLS n'est pas opérationnelle

**Constat :** `probeRlsRole()` peut signaler que le rôle `washpilot_app` manque ou que le compte applicatif n'en est pas membre. Le démarrage continue alors ; le code de `db-rls.ts` documente explicitement le repli sans `SET ROLE`. Si le compte DB est propriétaire des tables, PostgreSQL fait normalement échapper ce propriétaire aux politiques RLS. Les filtres tenant dans les requêtes restent une protection applicative, et aucune fuite inter-tenant n'a été démontrée par cette analyse ; en revanche, la seconde barrière RLS n'est plus effective.

**Risque :** une requête métier future qui oublierait le filtre d'organisation ne sera pas rattrapée par la base dans cette configuration dégradée. Une simple alerte de log peut passer inaperçue en production.

**Recommandation :** refuser le démarrage en production, ou rendre `/readyz` non prêt, lorsque la RLS est attendue mais que rôle/appartenance/politiques ne sont pas correctement vérifiés. Ajouter un test d'intégration PostgreSQL avec un rôle applicatif non propriétaire et un contrôle négatif entre deux organisations. Vérifier que la configuration du pooler est en mode session/direct.

**Références :** `server/db-rls.ts` (notamment lignes 78–93 et 187–218) ; `server/database-target.ts` ; `SUPABASE.md`.

### P1 — Éviter d'écrire les jetons de réinitialisation dans le chemin de monitoring

**Constat :** les liens de réinitialisation placent le jeton dans la query string (`/auth/reset-password?token=…`). Lorsqu'un incident est capturé, `captureIncident()` transmet `req.originalUrl` en clair comme `path`, et `recordErrorEvent()` enregistre ce champ. Les corps sont masqués, mais cette protection ne nettoie pas l'URL. Les incidents lents ou les erreurs serveur sur l'endpoint de validation peuvent donc conserver le jeton dans `error_events`.

**Risque :** un jeton valide est une capacité de changement de mot de passe ; sa conservation dans les journaux internes augmente la portée d'une fuite ou d'un accès excessif à la console de monitoring. Cette analyse n'a pas déclenché de tel incident, donc il s'agit d'un chemin de fuite plausible, pas d'une exposition constatée.

**Recommandation :** persister uniquement `req.path` ou un chemin normalisé, sans query string. Si certains paramètres sont nécessaires au diagnostic, autoriser une liste blanche et remplacer explicitement `token`, `code`, `key` et autres secrets. Ajouter un test garantissant qu'un jeton de reset n'apparaît ni dans le chemin stocké ni dans le journal d'incident.

**Références :** `server/auth-router.ts` lignes 548–560 ; `server/monitoring-middleware.ts` lignes 91–102 ; `server/monitoring.ts` lignes 232–259.

### P2 — Politique de mot de passe faible et limitation de débit non distribuée

**Constat :** `MIN_PASSWORD_LENGTH` vaut **5** caractères et est appliqué à l'inscription, au changement et à la réinitialisation du mot de passe. La limitation de tentatives utilise une `Map` mémoire par IP dans `server/auth-router.ts`.

**Risque :** les mots de passe courts sont plus faciles à deviner ; en présence de plusieurs processus, de redémarrages ou de fonctions serverless, un compteur mémoire n'impose pas une limite cohérente à l'échelle du service. Scrypt renforce le coût d'une attaque hors ligne, mais ne remplace pas une politique de secret solide ni un rate limit partagé.

**Recommandation :** aligner la longueur minimale avec le niveau attendu (par exemple 8 caractères minimum, idéalement encourager les longues phrases de passe), vérifier les comptes/migrations existants avant toute évolution, et déplacer le contrôle de débit vers un service partagé ou un mécanisme edge, avec protections spécifiques pour login, création de compte et réinitialisation. Conserver des réponses génériques et éviter le verrouillage exploitable contre un tiers.

**Références :** `server/auth-router.ts` lignes 22–47 et 49–116 ; `src/app/auth/password-policy.ts`.

### P2 — Dépendances de développement à corriger

**Constat :** l'audit complet rapporte 17 avis, essentiellement dans les outils de lint/codegen et leurs dépendances transitives. L'audit des dépendances runtime (`--omit=dev`) est propre : 0 vulnérabilité.

**Risque :** exposition des postes de développement et de la chaîne CI/de build ; moins directe que celle d'une dépendance exécutée côté serveur, mais pertinente pour la supply chain.

**Recommandation :** planifier la mise à jour des versions concernées, examiner les changements majeurs proposés par `npm audit fix` au lieu d'appliquer `--force` en aveugle, puis relancer build, lint et tests. Documenter les exceptions si certains changements de versions ne sont pas compatibles.

### P3 — Le routeur de notifications est monté deux fois

**Constat :** `createNotificationsRouter()` est monté deux fois à la suite dans `server/app.ts` (lignes 103–104). Les routes qui répondent terminent normalement sur le premier routeur ; ce doublon ne semble donc pas casser les endpoints actuels, mais duplique le montage et peut compliquer les futures routes/middlewares.

**Recommandation :** supprimer l'un des deux montages et ajouter/maintenir un test de composition de routes.

### P3 — Les payloads trop volumineux risquent d'être renvoyés comme erreurs 500

**Constat :** le parseur JSON est limité à 1 Mo (`server.ts`), mais le gestionnaire central ne convertit explicitement que `entity.parse.failed` en 400. L'erreur Express/body-parser `entity.too.large` n'a pas de branche dédiée.

**Risque :** un appelant qui envoie plus de 1 Mo peut recevoir un `500 internal_error` au lieu du statut attendu 413, ce qui dégrade diagnostic, métriques et comportement client.

**Recommandation :** mapper `entity.too.large` vers HTTP 413 et couvrir le cas par un test API.

### P3 — Avertissements lint et poids de styles

- Les 27 avertissements ESLint ne bloquent pas la construction. Plusieurs concernent `watch()` de React Hook Form et l'avertissement du React Compiler ; d'autres concernent la règle Fast Refresh et des dépendances de hooks. Ils sont à traiter selon leur cause plutôt que de les masquer en bloc.
- La feuille CSS de production atteint environ **603 Ko avant gzip**. Le code JavaScript est réparti en chunks, mais la CSS reste un poste d'optimisation intéressant, notamment pour les réseaux mobiles. Mesurer le transfert réel et retirer les styles/CoreUI non nécessaires avant de refactoriser les composants.

### P3 — Documentation et configuration partiellement désynchronisées

- `ANALYSE-COMPLETE.md` est une analyse antérieure qui mentionne une autre branche/révision, des chiffres plus petits et des fonctions alors manquantes (par exemple reset mot de passe), désormais implémentées. Il ne doit pas être considéré comme l'état courant.
- `vite.config.ts` contient un commentaire qui parle d'un « backend Go », alors que le backend présent est Express/TypeScript. La configuration décrit aussi le proxy du serveur Vite autonome, tandis que le flux principal de développement passe par Vite en middleware dans Express.
- `package.json` et le dépôt contiennent à la fois `package-lock.json` et `bun.lock`. La commande de référence documentée est npm ; l'équipe gagnerait à préciser quel lockfile est canonique et à empêcher leur divergence.

**Recommandation :** utiliser ce document comme état de référence daté, corriger les éléments de documentation/configuration périmés, et établir une politique explicite pour le gestionnaire de paquets.

---

## 8. Lecture du déploiement et de l'exploitation

### Points positifs

- Le serveur refuse explicitement de démarrer en production sans base externe opérationnelle.
- Les conteneurs sont multi-stage, l'image runtime est non-root et la base Docker reste sur le réseau interne.
- Le mode Vercel a un bundle API et une réécriture pour préserver les chemins profonds.
- Les routes de santé séparent disponibilité HTTP (`/healthz`) et dépendance DB (`/readyz`).
- Les rappels ont une configuration de cron/secret ; e-mail, WhatsApp et rapprochement sont optionnels et documentés.

### Vérifications indispensables avant mise en production

1. Fournir un `DATABASE_URL` TLS valide, et confirmer la connexion directe ou le pooler PostgreSQL **session** lorsque l'état de session est requis.
2. Vérifier automatiquement `washpilot_app`, les droits accordés, le propriétaire des tables, les politiques RLS et les tables volontairement exclues.
3. Définir `SEED_DEMO_DATA=false` en production et confirmer l'absence de comptes de démonstration.
4. Renseigner `APP_URL`, l'expéditeur e-mail et le fournisseur e-mail ; vérifier le parcours réel de reset et la délivrabilité.
5. Configurer les origines CORS si l'interface et l'API sont sur des origines distinctes ; contrôler les cookies avec le proxy/hébergeur réel.
6. Renseigner les secrets d'amorçage console et cron de façon sûre, et vérifier qu'ils ne sont ni committés ni affichés dans des journaux.
7. Tester une sauvegarde **et une restauration** sur un environnement isolé ; le fait d'avoir les scripts ne prouve pas qu'une restauration de production fonctionne.
8. Configurer collecte/alerte des logs, rétention et accès à la console de monitoring. Les détails d'incident peuvent contenir données personnelles et montants.
9. Valider les jobs de rappels, alertes WhatsApp, rapprochement et paiement avec les environnements réels des fournisseurs ; leur réussite dans les tests locaux n'est pas démontrée ici.
10. Exécuter des tests navigateur de bout en bout (mobile inclus), un test de charge et une vérification de restauration/continuité avant d'annoncer une capacité de production.

---

## 9. Plan d'action proposé

### Immédiat — sécurité et confiance des journaux

- Ne jamais conserver de query string dans `error_events.path` ; ajouter une assertion de non-régression pour le jeton reset.
- Décider du comportement fail-closed de la RLS en production ; vérifier la configuration réelle de chaque base.
- Revoir la politique de mot de passe et introduire un rate limiting compatible multi-instance/serverless.
- Mapper `entity.too.large` en 413.

### Court terme — hygiène technique

- Retirer le double montage des notifications.
- Mettre à jour les dépendances de développement et établir une règle de versionnage/audit.
- Réduire les 27 avertissements lint en distinguant les vrais problèmes des incompatibilités d'outils.
- Mettre à jour README, analyse existante, commentaire Vite et lockfiles.

### Avant montée en charge

- Ajouter une suite E2E navigateur couvrant inscription, onboarding, lavage/caisse, annulation, accès rôle/tenant, usage hors ligne et reprise.
- Ajouter un test PostgreSQL réel dédié à RLS/pooler/concurrence et un contrôle de performances des requêtes de rapports.
- Mesurer puis réduire le CSS initial ; examiner les pages/chunks les plus volumineux.
- Vérifier les scénarios de rétention/effacement des données, la restauration et le suivi des incidents avec des données réalistes mais non personnelles.

---

## 10. Conclusion

Le projet est **fonctionnellement riche et techniquement bien structuré**, et les contrôles exécutables disponibles passent tous après installation des dépendances. Les bonnes pratiques de gestion de l'argent, d'idempotence, d'autorisation, d'audit et de tests sont visibles dans le code.

La recommandation n'est pas de réécrire l'application : il faut d'abord traiter les constats de sécurité opérationnelle (RLS non bloquante, jeton dans le chemin monitoré, politique/rate limit des mots de passe), corriger les petits défauts précis, puis valider la configuration PostgreSQL et les intégrations de production dans un environnement réel. Le niveau de préparation du **code** est bon ; l'état de préparation de l'**exploitation réelle** reste à confirmer par les contrôles listés ci-dessus.
