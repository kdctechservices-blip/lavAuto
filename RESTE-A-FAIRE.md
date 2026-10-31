# Ce qui reste à implémenter — WashPilot CI

> Analyse du 20 octobre 2026, sur l'état du dépôt au commit `e14ac04`.
> 7 052 lignes de serveur (24 modules) · 24 301 lignes de front (171 fichiers)
> · 2 928 lignes de tests (16 fichiers, 189 tests) · `tsc`, lint et build verts.

Ce document ne répète pas l'analyse initiale (`ANALYSE-COMPLETE.md`) ni l'état
des promesses tarifaires (`TARIFS.md` §6). Il répond à une seule question :
**qu'est-ce qui empêche aujourd'hui de mettre ce produit entre les mains d'un
client payant, et dans quel ordre le traiter.**

---

## 0. Ce qui est solide

Pour situer le reste. Le socle métier est construit et vérifié :

- **24 modules serveur**, 74 routes, toutes consommées par l'interface.
- **RBAC à trois niveaux** (interface, serveur, base), 28 permissions, refus
  par défaut, 4 permissions non délégables, exceptions par membre.
- **Moteur de forfaits** : 12 capacités, essai de 14 jours, bascule en lecture
  seule, plafonds (utilisateurs, laveurs, stations) sous verrou consultatif,
  délai de grâce de 14 jours à la rétrogradation.
- **Idempotence** sur les écritures d'argent, **journal d'audit**, **isolation
  multi-tenant** testée, **sauvegarde/restauration**.
- **189 tests** dont l'isolation des locataires, les garde-fous de forfait et
  la matrice des rôles figée.

Ce qui suit ne remet rien de cela en cause. Ce sont les pièces manquantes.

---

## 1. ~~Bloquant~~ — RÉSOLU le 20/10/2026 : le back-office est en place

> **Résolu.** Le chemin 1 ci-dessous (activation manuelle assistée) a été
> implémenté : console `/console` (application séparée depuis le 20/10/2026),
> opérateurs de plateforme par
> `PLATFORM_ADMIN_EMAILS`, routes d'activation, de suspension, de prolongation
> et de refus de demande. Voir **`BACK-OFFICE.md`**. Le constat d'origine est
> conservé ci-dessous pour mémoire.

**C'était le point le plus grave, et il était invisible depuis l'interface.**

Trois routes seulement touchent la table `subscriptions` :

| Route | Fichier | Effet |
|---|---|---|
| Inscription | `server/onboarding.ts` | crée l'essai de 14 jours |
| Expiration | `server/entitlements.ts` | passe l'essai en `expired` |
| `POST /subscription/simulate` | `server/subscription.ts` l. 49 | change le forfait — **`if (env.NODE_ENV !== "production")`** |

Il n'existe **aucun back-office, aucun super-administrateur, aucune route
d'activation** (vérifié : `grep` sur `super_admin|back-office|is_admin` ne
retourne rien).

Le parcours réel d'un client aujourd'hui :

```
inscription → essai 14 j → expiration → lecture seule
   → « Demander l'activation » → e-mail à l'assistance + lien WhatsApp
   → … et personne ne peut activer le forfait sans écrire du SQL à la main
```

`server/support.ts` trace bien la demande et prévient l'assistance. Mais la
dernière marche n'existe pas. **Un client qui veut payer ne le peut pas.**

### Ce qu'il faut décider avant de coder

Deux chemins, et le choix n'est pas technique :

1. **Activation manuelle assistée** — une route d'administration réservée à
   l'éditeur, plus un écran minimal : liste des demandes en attente, bouton
   « activer le forfait X jusqu'au … ». Cohérent avec un encaissement par
   mobile money hors application, qui est la pratique courante à Abidjan.
   Quelques jours de travail. **C'est le minimum pour vendre.**

2. **Encaissement intégré** — CinetPay, PayDunya ou Wave Business, qui
   couvrent le XOF et le mobile money ivoirien. Webhook de confirmation,
   renouvellement, échecs de prélèvement, relances. Plusieurs semaines, et
   une relation contractuelle avec l'agrégateur.

Le chemin 1 n'interdit pas le chemin 2 : il le précède. Tant que le volume
tient dans un tableur, l'activation manuelle est plus sûre qu'une intégration
mal rodée qui encaisse mal.

> **Conséquence si rien n'avait été fait :** le 15ᵉ jour, chaque client
> devenait lecture seule et aucun ne pouvait payer. Le produit était une
> démonstration.

**Ce qui a été livré** (20/10/2026) : `server/platform-admin.ts`,
`server/admin.ts` (18 routes), table `platform_operators` amorcée au
démarrage depuis `PLATFORM_ADMIN_EMAILS`, écran `/admin` atteint par le menu
utilisateur, 20 tests dans `tests/platform-admin.test.ts`. Le chemin 2
(encaissement intégré) reste ouvert et n'est pas contredit : la route
d'activation deviendra le point d'entrée du webhook.

---

## 2. ~~Bloquant~~ — RÉSOLU le 22/10/2026 : le déploiement est outillé

> **Traité pour Vercel** (§ « Déploiement Vercel » plus bas) : `vercel.json`,
> fonctions serverless `api/`, empaquetage `npm run build:api`, relances par
> cron. Le constat d'origine est conservé ci-dessous pour mémoire.


| Manque | Constat |
|---|---|
| Conteneur / plateforme | Ni `Dockerfile`, ni `Procfile`, ni `fly.toml`, ni `render.yaml` |
| Intégration continue | Pas de `.github/workflows/` — **les 209 tests ne tournent nulle part automatiquement** |
| Documentation | `README.md` s'arrête aux « Flux métier clés », aucune section de mise en production |

La base supporte bien un PostgreSQL externe (`DATABASE_URL`, `server/db.ts`
l. 574) avec repli PGlite en développement : ce point-là est sain.

Le reste est à écrire. L'absence de CI est la plus coûteuse : 209 tests qui ne
s'exécutent qu'à la main finissent par ne plus s'exécuter du tout.

---

## 3. ~~Bloquant terrain — Aucun mode hors ligne~~ — RÉSOLU le 21/10/2026

> **Traité.** L'application est installable, s'ouvre sans réseau, et les lavages
> encaissés pendant une coupure repartent seuls au retour du réseau, sans
> doublon possible. Voir **`HORS-CONNEXION.md`** pour les règles, les
> exclusions volontaires (ouverture de caisse, annulations, modifications) et
> les limites assumées. 25 tests : `tests/offline-queue.test.ts` et
> `tests/pwa.test.ts`.
>
> Le constat initial, conservé pour mémoire :

## 3 bis. Constat d'origine — Aucun mode hors ligne

Recherche sur `serviceWorker|manifest.json|workbox|indexedDB|offline` dans
`src/`, `public/` et `index.html` : **aucun résultat**.

Le contexte d'usage rend ce manque sérieux. Une station de lavage à Abidjan
travaille sous un auvent, parfois en bordure de voie, avec une connexion
mobile qui tombe. Aujourd'hui, quand le réseau coupe :

- le caissier ne peut plus enregistrer un lavage ;
- il note sur un cahier ;
- la saisie n'est jamais rattrapée, ou l'est le soir, de mémoire.

Les recettes de la journée deviennent fausses, et le produit perd exactement
ce qu'il promet. **C'est le premier risque d'abandon après l'installation.**

La bonne nouvelle : l'architecture s'y prête déjà. Les écritures d'argent
passent par `withIdempotency` et une `Idempotency-Key` — rejouer une file
d'attente locale ne créera pas de doublon. Le travail porte sur :

1. un manifeste et un *service worker* pour que l'application se lance sans
   réseau (aucune dépendance nouvelle n'est nécessaire : Vite sait générer
   l'un et l'autre, ou on les écrit à la main) ;
2. une file d'écritures en IndexedDB, rejouée à la reconnexion ;
3. un indicateur d'état franc à l'écran — « 3 lavages en attente d'envoi » —
   car un mode hors ligne silencieux inquiète plus qu'il ne rassure.

---

## 4. Manque fonctionnel — Le client n'existe pas

La table `customers` est créée (`server/db.ts`), la colonne
`washes.customer_id` existe en clé étrangère… et **rien ne les alimente** :
aucune route, aucun écran. Seul `server/backup.ts` la cite, pour l'exporter
vide.

S'y ajoutent deux absences :

- **aucune plaque d'immatriculation** nulle part dans le schéma ni l'interface ;
- **aucun reçu ni ticket** imprimable ou partageable.

Ce que cela coûte concrètement :

- impossible de retrouver « la Corolla bleue de ce matin » ;
- impossible de distinguer un client fidèle d'un passage unique, donc pas
  d'abonnement client, pas de carte de fidélité, pas de relance ;
- le client repart sans preuve de ce qu'il a payé, ce qui est le premier motif
  de contestation à la caisse.

La table `customers` ne porte que `full_name` et `phone`. Il faudra trancher
si le client est une fiche, ou si le véhicule (plaque) est l'identifiant réel
— dans un lavage, c'est souvent le véhicule qu'on reconnaît, pas la personne.

---

## 5. Exploitation et sécurité

Rien ici n'est une faille ouverte, mais chaque ligne devient un problème le
jour où l'application tourne sur plus d'une instance.

| Point | État | Risque |
|---|---|---|
| Limitation de débit | En mémoire, par processus (`server/auth-router.ts` l. 25-36) | Remise à zéro à chaque redémarrage ; inopérante avec deux instances |
| Relances d'échéance | `setInterval` dans le processus (`server/reminders.ts` l. 186) | Deux instances = deux e-mails au même client |
| Vérification d'e-mail | Absente à l'inscription | N'importe quelle adresse, y compris celle d'un tiers |
| CSRF | Pas de jeton ; `sameSite: "none"` dès que HTTPS (`server/auth.ts` l. 158) | Atténué par le CORS restrictif en production et le `Content-Type: application/json` qui force un pré-vol — **à confirmer explicitement plutôt qu'à supposer** |

Le reste du modèle de session est sain : jeton opaque, cookie `httpOnly`,
seul le SHA-256 est stocké.

---

## 6. Dette et angles morts

- **`clerk_webhook_events`** : table créée, citée nulle part ailleurs.
  Reliquat d'une authentification Clerk abandonnée. À supprimer.
- **Aucun test de rendu de composant.** Les 209 tests couvrent le serveur et
  des contrôles statiques. C'est précisément par là qu'est passé le plantage
  `MenuGroupContext is missing` (commit `dd51140`) : un menu qui ne tombe
  qu'à l'ouverture, invisible pour `tsc` comme pour le build. Sans
  `jsdom`/`@testing-library` — donc sans nouvelle dépendance, contrainte
  posée — on ne peut pas faire mieux que les contrôles statiques actuels.
  **Cette contrainte mérite d'être rediscutée**, c'est la seule qui laisse
  passer une classe entière de défauts.
- ~~**« Assistance prioritaire »** (forfait Pro) : promesse sans définition.~~
  **Tranché** : délai de première réponse par forfait (Business 4 h ouvrées,
  Pro 1 jour, Starter 3 jours), affiché au client et mesuré dans la console.
  Voir `TARIFS.md` §6 et `BACK-OFFICE.md` §7.
- **« Suivi des sessions de caisse »** vendu en Pro mais disponible en
  Starter, et **« gestion des équipes »** différenciée seulement par le
  plafond : `TARIFS.md` §7.2 propose une reformulation, non tranchée.

---

## 7. Ordre recommandé

Le critère n'est pas la difficulté, c'est **ce qui empêche d'encaisser le
premier franc, puis de garder le premier client.**

| # | Chantier | Pourquoi d'abord | Ordre de grandeur |
|---|---|---|---|
| ~~1~~ | ~~**Activation manuelle des forfaits**~~ (§1, chemin 1) | **✅ Livré le 20/10/2026 — voir `BACK-OFFICE.md`** | — |
| 2 | **Déploiement + CI** (§2) | Sans elle, rien n'arrive chez le client et les tests s'érodent | Jours |
| 3 | **Mode hors ligne** (§3) | Premier motif d'abandon en conditions réelles | Semaines |
| 4 | **Client, plaque, reçu** (§4) | Première demande d'un exploitant une fois le quotidien couvert | Semaines |
| 5 | **Robustesse multi-instance** (§5) | Au moment de passer à deux instances, pas avant | Jours |
| 6 | **Dette** (§6) | En continu | — |

Les chantiers 1 et 2 étaient les seuls qui séparaient une démonstration d'un
produit vendable. **Le premier est fait.** Le chantier 2 — déploiement et
intégration continue — devient donc le prochain, et le dernier avant qu'un
client réel puisse s'inscrire, payer et être servi.

Tout le reste peut attendre ce premier client — et sera mieux conçu une fois
qu'on l'aura écouté.

## Enregistrer un lavage — revu le 21 octobre 2026

### Le vrai défaut : une station neuve ne peut rien encaisser

Signalé deux fois, le bouton a fini par être reproduit — en créant un compte
comme le ferait un nouveau gérant. Une organisation qui vient de s'inscrire
n'a **ni station, ni prestation, ni employé**. Le bouton « Nouveau lavage »
est alors grisé à juste titre, avec pour seule indication : « Créez d'abord
une station dans **Réglages › Stations** ».

Or ce menu n'existe pas. La barre latérale affiche « Configuration » et
« Paramètres ». Le gérant cherchait « Réglages », ne trouvait rien, et
concluait que le bouton était cassé. Il ne l'était pas : il était sans issue.

| | Avant | Maintenant |
| --- | --- | --- |
| Nom du menu cité | « Réglages › Stations », introuvable | « Configuration › Stations », tel qu'il s'appelle |
| Ce qui manque | Seule la station était mentionnée | Les trois manques listés : station, prestation, employé |
| Comment y aller | Une phrase à déchiffrer | Un lien par manque, dans l'ordre où on les règle |

### Ce qui avait déjà été vérifié, et reste vrai

L'examen précédent n'avait trouvé **aucun défaut à l'ouverture** du formulaire : la station est
active, le droit `wash:create` est accordé, le forfait autorise
`washes.create`, les deux chargements de droits se terminent toujours, et le
service worker sert bien la dernière version. Un refus `cash_session_required`
observé en ligne de commande venait de l'appel d'essai lui-même, qui omettait
la session de caisse — le formulaire, lui, la transmet.

Le blocage réel était **à la validation**, pas à l'ouverture : le bouton
« Enregistrer » restait grisé sans que la raison saute aux yeux.

### Ce qui a changé

| Point | Avant | Maintenant |
| --- | --- | --- |
| Laveur | Case « Employés affectés (facultatif) », souvent laissée vide | « Qui lave ce véhicule ? » — **obligatoire**, la validation l'exige |
| Aucun employé actif | « Aucun employé actif à affecter. », sans issue | Lien direct vers **Équipe** pour en ajouter un |
| Reçu | Accessible seulement en rouvrant la fiche du lavage | Proposé **immédiatement après une vente intégralement réglée** |
| Plaque sur le reçu | Absente | Ligne « Plaque », le client reconnaît sa voiture |
| Station fermée | Restait proposée dans le formulaire | Écartée du formulaire, mais toujours nommée dans l'historique |

### Deux choix assumés

**L'exigence du laveur porte sur le formulaire, pas sur le serveur.** Un
lavage ressaisi après coup, ou rejoué depuis la file hors ligne, peut
légitimement n'avoir personne de nommé ; le refuser côté serveur ferait
perdre des ventes déjà encaissées. Au comptoir, en revanche, le caissier a le
laveur sous les yeux : c'est le seul moment où l'information est encore sûre.

**Le reçu n'est pas émis tout seul.** Une ligne d'émission signifie qu'un
papier est sorti ; l'émettre automatiquement fausserait le compte des copies.
Il est donc proposé en un clic, pendant que le client est encore au comptoir.

### Ce que cela laisse ouvert

- Le reçu reste un reçu commercial, **jamais une facture normalisée** : aucune
  mention TVA, FNE ou DGI, et les tests l'interdisent explicitement.
- Un lavage enregistré sans laveur depuis la file hors ligne n'apparaîtra dans
  aucune part de rendement. C'est la contrepartie du choix ci-dessus.

## Recensement du câblage — 21 octobre 2026

Comparaison croisée entre les pages, les routes, le menu et l'API.

**Pages et menus : rien ne manque.** Toute page de `src/app/` a une route, et
toute route a une entrée de menu. Le grief « des pages non branchées » ne porte
pas sur l'interface.

**L'écart était ailleurs : sept routes d'API construites, testées, et qu'aucun
écran n'appelait.** Sur 117 routes, sept étaient inatteignables :

| Route | Conséquence concrète | Suite donnée |
|---|---|---|
| `GET/POST/DELETE /work-schedules` | Aucune heure de référence saisissable, donc **personne n'était jamais déclaré en retard** | Écran « Horaires » |
| `GET /attendance/history` | Les présences passées n'étaient consultables nulle part | Section « Historique de présence » |
| `GET/POST /product-categories` | Tout produit restait « Sans catégorie », sans moyen d'y remédier | Champ dans la fiche produit |
| `POST /support/upgrade-request` | — | **Laissée débranchée, volontairement** (voir ci-dessous) |

### Pourquoi `/support/upgrade-request` reste débranchée

Trois chemins mènent déjà au même besoin, et deux sont branchés :

- **acheter un forfait** → `/subscription/checkout`, avec déclaration de
  paiement et suivi ; c'est le parcours réel ;
- **poser une question** → `/support/requests`, qui crée un ticket que le
  client peut suivre.

`/support/upgrade-request` ne fait ni l'un ni l'autre : elle journalise et
envoie un courriel à l'opérateur, **sans laisser au client la moindre trace
consultable**. La brancher ajouterait un troisième bouton pour un résultat
invisible. Le choix est donc de la laisser de côté et de signaler qu'elle est
supplantée — sa suppression est une décision à prendre, pas un oubli.

### Ce qui reste ouvert

- ~~Le client n'existe toujours pas~~ — **tranché le 21 octobre 2026 : on suit
  le véhicule, pas la personne.** On note la plaque, rien d'autre : pas de nom,
  pas de téléphone, pas de fichier client à tenir. Elle sert à retrouver
  l'historique d'un véhicule qui revient. La table `customers` reste donc vide
  et sans emploi ; `washes.customer_id` n'est plus alimenté.
- `clerk_webhook_events` : table morte, héritée d'une architecture abandonnée.
- Deuxième instance impossible (limitation en mémoire, `setInterval`).
- `wash_quality_events` absente.

### Branchement de la base — vérifié le 22 octobre 2026

Le détail, table par table et fonctionnalité par fonctionnalité, est dans
`BASE-DE-DONNEES.md`. Deux corrections en sont sorties :

- **Les notifications sont désormais lues.** La table `notifications`
  recevait « Lavage terminé » sans qu'aucune route ne la relise : le fait
  était enregistré puis perdu, et `read_at` ne servait à rien. Trois routes
  (`GET /notifications`, `POST /notifications/:id/read`, `POST …/read-all`)
  et l'affichage dans le centre de notifications ferment la boucle.
- **`expense_categories` a été retirée du schéma.** Elle n'était ni écrite ni
  lue ; les catégories de dépense sont un vocabulaire fermé, porté par le
  code, pour que les rapports restent comparables d'une station à l'autre.

Le contrôle qui empêche la récidive est `tests/database-wiring.test.ts` : il
joue chaque parcours et compte les lignes table par table. Une table morte
supplémentaire, ou une fonctionnalité qui cesse d'écrire, le fait échouer.

### Messages de validation — réglés le 21 octobre 2026

Une saisie refusée renvoyait le message brut de la bibliothèque de validation :
« Invalid option: expected one of "cash"|"orange_money" ». Inutilisable pour un
caissier, qui ne sait ni ce qui est refusé, ni quoi corriger.

Basculer la bibliothèque en français ne suffisait pas : elle produit alors
« Entrée invalide : chaîne de caractères attendu, indéfini reçu ». Il manquait
surtout **le nom du champ en cause**, qui est l'information la plus utile.

Avant / après :

| Avant | Après |
|---|---|
| `Invalid option: expected one of "cash"\|"orange_money"` | Le mode de paiement ne fait pas partie des choix possibles. |
| `Invalid UUID` | La station n'est pas valide. Reprenez la sélection dans la liste. |
| `Too small: expected number to be >=1` | Ligne 2 : la quantité doit être au moins 1. |
| `Too big: expected number to be <=100000000` | Le montant ne peut pas dépasser 1 000 000 F. |
| `Too big: expected number to be <=1439` | L'heure de début ne peut pas dépasser 23:59. |

Les règles retenues :

- **un message écrit à la main dans un validateur l'emporte toujours.**
  « Sélectionnez au moins une prestation. » vaut mieux que toute phrase
  générique ;
- **aucune tournure ne s'accorde en genre**, puisque le libellé peut être
  masculin ou féminin : « ne fait pas partie des choix possibles » plutôt que
  « n'est pas reconnu » ;
- **les bornes se relisent dans l'unité du métier** : les centimes en francs,
  les millièmes en unités, les minutes depuis minuit en heures ;
- **une borne exclusive ne se dit pas comme une borne inclusive** :
  `.positive()` donne « doit dépasser 0 », jamais « au moins 0 » ;
- un champ absent du lexique reste lisible : `widget_id` devient « widget ».

### Coût de référence d'un produit — réglé le 21 octobre 2026

Acheter un produit ne touchait pas à sa fiche. Le gérant saisissait « 300 F le
sachet » le premier jour, le prix montait à 350 au marché, et la fiche affichait
toujours 300. Comme chaque lavage valorise sa consommation au coût de la fiche,
**la marge affichée était fausse, et toujours dans le sens flatteur.**

Désormais, **le dernier prix payé devient le coût de référence.**

Pas une moyenne pondérée, pour deux raisons. D'abord le stock peut être négatif
dans ce produit — une rupture n'a jamais le droit de bloquer un lavage — et une
moyenne pondérée par une quantité négative ne veut plus rien dire. Ensuite
c'est le chiffre que le gérant reconnaît : il a payé 350, sa fiche doit
afficher 350. La valeur du stock se lit alors comme un coût de reconstitution,
ce qui est la bonne question pour décider, et non comme une valeur comptable
historique — la comptabilité, elle, part de l'export.

Trois garde-fous :

- **un prix nul n'écrase rien.** Recevoir un échantillon gratuit ne doit pas
  faire croire que le produit ne coûte plus rien, ce qui rendrait toutes les
  marges parfaites ;
- **l'historique n'est jamais réécrit.** Chaque mouvement déjà enregistré garde
  le coût qui était vrai ce jour-là ;
- **le réalignement est tracé** (`product.cost_changed` : ancien prix, nouveau
  prix, achat en cause), et l'écran dit d'où vient le chiffre — « prix payé le
  21/10/2026 » ou « saisi à la main ». Corriger le coût à la main efface la
  mention, pour que l'écran ne mente pas.

**Limite assumée :** annuler un achat reprend la marchandise mais ne restaure
pas l'ancien coût de référence. Un prix payé par erreur se corrige à la main
sur la fiche produit.

---

## Correctifs du 22 octobre 2026

Trois défauts trouvés en rejouant le parcours complet d'un nouveau client, plus
la cause qui les rendait invisibles.

### 1. La suite de tests écrivait dans la vraie base

`npm test` lançait `tsx --test tests/*.test.ts` sans `NODE_ENV`. Sans lui,
`NODE_ENV` vaut `development` : les fichiers de tests ouvraient donc la base
**sur disque** (`.data/pglite`), la même que le serveur de développement. Node
exécute les fichiers en parallèle, plusieurs processus écrivaient dans une base
PGlite mono-utilisateur, et chaque fichier héritait des données du précédent.

Le symptôme était trompeur : **37 fichiers en échec**, des centaines de 403 et
de « compte déjà existant », sans aucun rapport avec le code testé. Un `.env`
renseigné renvoyait même la suite vers la base de production, où elle créait
des stations et des encaissements.

| | Avant | Maintenant |
| --- | --- | --- |
| `npm test` | base disque partagée, 250/287 | base mémoire par fichier, **826/826** |
| Données réelles | lues et écrites par la suite | jamais touchées |
| Glob des fichiers | développé par le shell (échec sous Windows) | lu en JavaScript |

Trois garde-fous plutôt qu'un seul, parce que chacun couvre un cas différent :

1. `scripts/run-tests.mjs` force `NODE_ENV=test`, `PGLITE_DATA_DIR=:memory:` et
   vide `DATABASE_URL` pour ses processus enfants.
2. `server/database-target.ts` — fonction pure, testée — **ignore
   `DATABASE_URL` en mode test**, quel que soit le `.env` de la machine.
3. `server/db.ts` sème toujours le jeu de démonstration en mode test, même si
   `SEED_DEMO_DATA=false` : sinon une installation réelle rendrait la suite
   rouge en supprimant les comptes sur lesquels elle s'authentifie.

### 2. Une station neuve ne pouvait enregistrer aucun lavage

La confirmation de l'assistant crée la station, les prestations, l'équipe et
l'abonnement — mais **aucune catégorie de véhicule**. Or `vehicle_category_id`
est obligatoire à la création d'un lavage, et l'écran de caisse désactive le
sélecteur quand la liste est vide. Un gérant qui venait de terminer sa
configuration arrivait donc sur un formulaire incapable d'encaisser, sans
message expliquant quoi créer.

- `server/default-catalog.ts` : trois catégories posées à la confirmation
  (Berline, SUV / 4x4, Moto), jamais réappliquées si la station les a
  supprimées depuis.
- Écran « Nouveau lavage » : à défaut de catégorie, le champ dit désormais quoi
  faire et renvoie vers l'écran de création.

### 3. Un journal de débogage dans le chemin de confirmation

`console.log("[api] confirm handler:", …)` traînait dans
`POST /onboarding/confirm` et écrivait l'identifiant d'organisation et
d'utilisateur dans les journaux du serveur à chaque confirmation. Retiré.

### Ce qui empêche ces défauts de revenir

`npm run smoke` (nouveau) démarre un serveur jetable sur une base en mémoire et
joue le parcours entier : inscription → configuration → confirmation →
ouverture de caisse → lavage → paiement → reçu → remboursement → clôture, puis
activation et suspension depuis la console, et la séparation des deux sessions.
**69 vérifications** en une dizaine de secondes, sans toucher aux données
réelles. Il vérifie aussi que Vite transforme les 48 modules de pages — une
route cassée est vue avant d'être ouverte chez un client.

### Ce que cela laisse ouvert

- Les stations créées **avant** ce correctif n'ont toujours pas de catégorie ;
  l'écran « Nouveau lavage » les guide vers la création, mais rien n'est semé
  rétroactivement — c'est un choix : on ne réintroduit pas des lignes qu'un
  client a pu supprimer volontairement.
- `npm run smoke` ne voit pas les défauts d'affichage (CSS, contraste,
  ergonomie) : il vérifie les parcours, pas la mise en page.

---

## Déploiement Vercel — 22 octobre 2026

Le déploiement en ligne (`lavautomaj.vercel.app`) servait l'interface mais
aucune API : **toutes** les routes `/api/v1/*` répondaient 404, et le service
worker affichait `TypeError: Failed to fetch` dans la console.

### La cause

Vercel ne sert que `dist/` : aucun serveur Express n'y tournait. La réécriture
de l'application monopage renvoyait donc `index.html` pour chaque appel d'API,
et `auth/me`, `auth/login`, `subscription`, `public/pricing` échouaient tour à
tour — d'où les écrans qui ne chargent plus rien.

Une première correction avait servi l'API depuis `api/[...slug].ts`. Elle
laissait la moitié du problème : sur Vercel, un nom entre crochets dans `api/`
ne couvre **qu'un** segment. `/api/healthz` et `/api/v1` répondaient, tout ce
qui est plus profond (`/api/v1/auth/me`, `/api/v1/public/pricing`,
`/api/v1/auth/register`) renvoyait le 404 de la plateforme sans atteindre la
fonction. D'où une fonction unique `api/index.ts` et une réécriture explicite
de `/api/:path*` vers elle, le chemin voyageant dans `__washpilot_api_path`.

### Ce qui a été ajouté

| Fichier | Rôle |
| --- | --- |
| `api/index.ts` | fonction unique de l'API (`/api` et tout `/api/...`) |
| `server/vercel-app.ts` | pile Express du serveur, sans son démarrage |
| `server/vercel-url.ts` | reconstitution du chemin, **la pièce qui manquait** |
| `server/vercel-handler.ts` | entrée du bundle |
| `scripts/build-api.mjs` | empaquette l'API (esbuild) |
| `scripts/serve-vercel-local.mjs` | imitateur du runtime Vercel, pour vérifier |
| `vercel.json` | construction, réécriture SPA, en-têtes, cron |
| `tests/vercel-url.test.ts` | 8 tests sur la reconstitution du chemin |

**Le piège à retenir** : une fonction de `api/` ne reçoit pas l'URL demandée.
Vercel lui passe `/api` et place les segments dans `req.query.slug`. Une
fonction qui transmet `req` telle quelle à Express répond 404 sur absolument
tout — le symptôme exact observé. `server/vercel-url.ts` reconstruit le chemin,
et `tests/vercel-url.test.ts` le vérifie sans avoir besoin de Vercel.

**Second piège** : le code serveur importe ses voisins en `.ts` explicite. Le
runtime de Vercel transpile chaque fichier isolément et laisse l'import en
`.ts` → « Cannot find module ». D'où `npm run build:api`, qui produit un bundle
unique importé par les fonctions.

### Le service worker

`assetCacheFirst` laissait remonter l'échec réseau : la console affichait un
`TypeError` sans contexte et l'écran restait vide. Les deux stratégies
renvoient désormais une réponse explicite (504, message lisible) au lieu d'une
promesse rejetée ; le cache passe en `v2`, ce qui purge les entrées de la
première version à l'activation.

### Ce que cela laisse ouvert

- **`CRON_SECRET` n'est pas encore défini chez Vercel.** Sans lui, la route des
  relances répond 503 et n'envoie rien : les e-mails J-3 / J-1 ne partent pas.
  C'est volontaire (un déclencheur ouvert inonderait les clients), mais cela
  doit être fait avant la mise en service.
- **La limitation des tentatives de connexion reste en mémoire** : sur une
  plateforme serverless, elle est comptée par instance, donc plus faible
  qu'annoncé. À déplacer en base ou dans un cache partagé.
- **`npm run smoke:serverless` imite le runtime Vercel, il ne le remplace pas.**
  Il vérifie le routage, les cookies et le parcours complet ; il ne dit rien
  des limites de la plateforme (taille du bundle, temps de démarrage à froid,
  région).
- **Le premier déploiement reste à faire** avec `DATABASE_URL` (Neon) : la
  sonde `/api/healthz` doit répondre `{"status":"ok","database":"ready"}`.
