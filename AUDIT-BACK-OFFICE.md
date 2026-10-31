# Audit du plan « back-office administrateur » — Phase 0

Date : 21 octobre 2026 · Dépôt réel : `Colorado225/LAVAUTO` · Branche : `arena/070bf131-lavauto` · Base : `b8ae334`

Ce document répond au plan d'implémentation en 8 phases qui m'a été soumis. Le plan
recommandait lui-même de commencer par un audit, en reconnaissant n'avoir pas pu lire
les fichiers. Cet audit a été fait, fichier par fichier. Voici ce qu'il révèle.

---

## 1. La conclusion, en une phrase

**Le back-office décrit par le plan existe déjà, il est en service, et il est couvert
par 161 tests automatiques.** Les quatre chantiers que le plan désigne comme « à
traiter en premier » sont tous les quatre terminés et verrouillés par des tests.
Appliquer le plan tel quel reviendrait à reconstruire par-dessus l'existant.

---

## 2. Deux erreurs de départ qu'il faut corriger avant toute chose

Le plan a été écrit pour un autre produit. Deux écarts le rendent inapplicable en l'état.

### 2.1 Ce n'est pas le bon dépôt

Le plan vise `Colorado225/ubiquitous-doodle`. Le projet réel est `Colorado225/LAVAUTO`.

### 2.2 Ce n'est pas la bonne technologie

Le plan décrit une authentification Clerk, une base Neon, un accès aux données Prisma
et un service Go. **Aucun de ces quatre éléments n'existe ici.** Vérification faite
sur les dépendances déclarées et sur l'arborescence :

| Le plan suppose | Réalité mesurée |
|---|---|
| Clerk (identité) | absent — session maison, cookie signé |
| Prisma (accès données) | absent — SQL écrit à la main |
| Neon (hébergement base) | absent — PostgreSQL standard, repli local pour le développement |
| Service Go | absent — aucun fichier Go dans le dépôt |
| Dossier `backend/` | absent — le serveur est dans `server/` |

Conséquence pratique : toutes les instructions du plan qui parlent de « rôle dans les
métadonnées Clerk », de « schéma Prisma » ou de « migration Prisma » n'ont pas de cible.

---

## 3. Phase par phase : ce qui est déjà fait

### Phase 1 — Cycle de vie d'un compte station

Le plan décrit : essai → en attente de paiement → actif → suspendu → clôturé.
**C'est exactement ce qui tourne.** L'essai dure 14 jours, sans carte bancaire.
Le compte bascule seul en lecture seule à l'échéance. L'éditeur peut activer,
suspendre avec motif obligatoire, prolonger un essai, programmer une clôture.

Un détail que le plan n'avait pas prévu et qui est pourtant déjà traité : **la clôture
se fait en deux temps.** L'accès est coupé immédiatement, mais l'effacement réel
n'intervient qu'à une date ultérieure. Entre les deux, le client est récupérable.
C'est plus prudent que ce que demandait le plan.

### Phase 2 — Modèle de données

Dix des douze tables demandées existent, parfois sous un autre nom :

| Table demandée par le plan | Table réelle | État |
|---|---|---|
| `stations` | `organizations` + `sites` | ✅ |
| `subscription_plans` | `plans` | ✅ |
| `subscriptions` | `subscriptions` | ✅ |
| `subscription_requests` | `payment_intents` | ✅ même rôle |
| `payments` | `subscription_payments` | ✅ |
| `support_tickets` | `support_requests` | ✅ |
| `support_messages` | `support_messages` | ✅ |
| `platform_admins` | `platform_operators` | ✅ |
| `audit_logs` | `audit_logs` | ✅ |
| `account_closure_requests` | deux colonnes sur l'organisation | ⚠️ voir §4.1 |

### Phase 3 — Permissions

**C'est le point n°1 du plan, et il est déjà traité au-delà de ce qui était demandé.**

Le droit d'administrateur de plateforme ne s'accorde que par une variable de
configuration du serveur. **Aucune route de l'application ne peut l'attribuer.**
Ce n'est pas une affirmation de principe : c'est un test qui s'appelle, mot pour mot,
*« aucune route n'accorde la qualité d'opérateur »*.

Trois autres tests gardent la frontière :

- *« la console est invisible depuis n'importe quelle session de station »*
- *« les identifiants d'une station n'ouvrent pas la console »*
- *« un propriétaire de station ne peut pas activer son propre forfait »*

La console répond **404**, et non 403, à qui n'y a pas droit : elle ne révèle même pas
son existence. Les deux mondes ont des cookies différents et des durées différentes.

### Phase 4 — Contrats d'API

**34 routes d'administration** sont en service, toutes derrière le contrôle d'opérateur.
Elles couvrent le tableau de bord, les stations, les demandes d'abonnement, les
paiements, l'assistance, le journal, les revenus et la surveillance technique.

Le point n°3 du plan — « l'approbation doit déclencher une seule activation, même si
la requête est répétée » — est couvert par trois tests dont les noms sont sans ambiguïté :

- *« cliquer deux fois ne crée pas deux références »*
- *« une validation déjà faite ne se rejoue pas »*
- *« deux validations simultanées n'activent qu'un seul mois »*

Le troisième traite la vraie difficulté : deux clics au même instant. Le plan ne
l'avait pas envisagée.

Autre exigence du plan déjà satisfaite, et testée : *« un renouvellement anticipé ne
fait pas perdre les jours payés »*. Et la règle de prudence la plus importante du
parcours de paiement : *« déclarer un paiement n'active rien »*. Une preuve envoyée
par le client n'est jamais une confirmation.

### Phase 5 — Interfaces

**12 écrans** composent la console : vue d'ensemble, stations, fiche station, comptes,
fiche compte, paiements, revenus, assistance, fiche de ticket, journal, surveillance,
détail d'erreur.

### Phase 6 — Assistance WhatsApp et e-mail

Le canal WhatsApp est en place **côté client**, avec un numéro configurable par
l'exploitant. Nuance relevée à la vérification : l'opérateur, lui, répond depuis la
console par la messagerie du ticket, pas par WhatsApp. Les relances d'échéance partent réellement par e-mail, en trois temps
(3 jours avant, 1 jour avant, après expiration), **chacune une seule fois** — une table
dédiée empêche le renvoi.

### Phase 7 — Tests

Le plan réclame des tests sur l'isolation, la double activation, les permissions.
Ils existent : **161 tests** sur ce seul périmètre, sur 617 au total pour le produit.

---

## 4. Ce qui manque réellement

L'audit n'a trouvé que trois écarts défendables. Les voici, par ordre d'utilité.

### 4.1 Le client ne peut pas demander lui-même la clôture de son compte

Aujourd'hui, seul l'éditeur peut programmer une clôture. Un gérant qui veut partir
doit le demander par l'assistance. C'est le seul élément du plan réellement absent.

Est-ce grave ? Modérément, et c'est même défendable commercialement : une clôture qui
passe par un échange humain est une occasion de retenir le client. Mais sur le principe,
un client doit pouvoir sortir sans négocier.

### 4.2 Les tarifs ne se modifient pas depuis la console

La console affiche les formules mais ne permet pas de les changer. Une hausse de prix
suppose aujourd'hui une intervention en base de données.

Avec trois formules et des prix annoncés comme des hypothèses à tester, c'est une gêne
réelle dès la première correction tarifaire.

### 4.3 La durée d'essai est figée à 14 jours dans le code

Impossible d'accorder 30 jours à un prospect important sans modifier le code. Le
contournement existe — l'éditeur peut prolonger un essai au cas par cas — mais la
valeur par défaut n'est pas réglable.

---

## 5. Ce que je recommande

**Ne pas appliquer le plan.** Il a été écrit pour un autre dépôt et une autre
technologie, et il propose de construire ce qui existe déjà. Le suivre ferait courir
un risque de régression sur un ensemble aujourd'hui stable et testé.

En revanche, trois de ses idées valent d'être retenues. Par ordre de valeur :

1. **La modification des tarifs depuis la console** — la plus utile, puisque les prix
   sont explicitement des hypothèses à tester.
2. **La durée d'essai réglable** — petit travail, utile en négociation commerciale.
3. **La demande de clôture par le client** — correct sur le principe, peu urgent.

Aucun de ces trois points ne justifie un chantier de 5 lots. L'ensemble représente un
lot modeste.

Pour mémoire, les priorités identifiées hors de ce plan restent, elles, entières :
le fonctionnement hors connexion (une station ivoirienne perd le réseau), le client et
sa plaque d'immatriculation qui n'existent toujours pas, et les prérequis d'une
seconde instance de serveur.

---

## 6. Méthode de l'audit

Toutes les affirmations ci-dessus proviennent d'une lecture du dépôt, pas d'une
supposition : inventaire des dépendances déclarées, recherche des tables dans le schéma,
extraction des routes par analyse du code, relevé des noms de tests, vérification des
points d'entrée. Aucun fichier n'a été modifié pendant l'audit.
