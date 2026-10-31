# Console de l'éditeur

**Date : 20 octobre 2026 · Statut : livré**

Ce document décrit la console réservée au créateur de l'application : ce
qu'elle permet, pourquoi elle est **une application séparée** et non un écran
de plus dans le produit, et comment l'activer.

Elle répond d'abord au constat n°1 de `RESTE-A-FAIRE.md` — *« il n'existe
aucun back-office, aucun super-administrateur, aucune route d'activation »* —
puis à une exigence venue ensuite : **qu'aucune passerelle ne relie la console
à une station**, ni visible dans un menu, ni atteignable en devinant une URL.

> **Si vous ne lisez qu'un paragraphe.** La console vit sous `/console`, avec
> sa propre page de connexion, ses propres comptes et son propre cookie. Un
> compte de station ne peut pas y entrer ; un compte de console ne peut pas
> entrer dans une station. Ce ne sont pas deux rôles du même système, ce sont
> deux systèmes.

---

## 1. Ce que la console permet

Cinq familles, correspondant aux cinq raisons d'ouvrir cet écran.

### 1.1 Savoir où en est l'argent

Indicateurs du parc — stations, essais en cours, actifs, expirés, résiliés,
**échéances dépassées**, revenu mensuel récurrent — puis la file des
encaissements : intentions de paiement déclarées par les clients et en attente
de confirmation, demandes de forfait supérieur.

Et, sous **Revenus**, le registre complet : courbe sur douze mois, impayés,
produits constatés d'avance, exports comptables. Voir le §5.

### 1.2 Dépanner un client au téléphone

Fiche d'une station : forfait, échéance, jours restants, membres avec leur
dernière connexion, historique d'abonnement. De quoi répondre à « depuis quand
suis-je bloqué ? » sans ouvrir la base.

| Geste | Effet | Réversible |
|---|---|---|
| **Confirmer** un encaissement déclaré | active le forfait pour N mois | oui (suspension) |
| **Activer** un forfait directement | la station passe en `active` | oui |
| **Décliner** une demande | clôt la demande, **ne touche pas** à l'abonnement | oui |
| **Prolonger** un essai | repousse l'échéance d'un essai en cours | oui |
| **Réinitialiser** un mot de passe | produit un jeton de 60 min à dicter | sans objet |

### 1.3 Gérer finement les comptes

Retrouver une **personne** dans tout le parc à partir de son adresse, de son
nom ou de son numéro — l'entrée qui manquait, puisque le support reçoit
l'appel d'une personne et non d'une station. Puis : la retirer d'une station
sans toucher à ses autres, changer son rôle, **transférer la propriété** d'une
station dont le propriétaire est parti, bloquer un compte compromis partout à
la fois, fermer ses sessions. Le détail au §6.

Également : suspendre la station entière (lecture seule) et **supprimer une
organisation**, en deux temps, décrits au §4.

### 1.4 Répondre à une demande d'aide

File des demandes ouvertes, **triée par échéance d'engagement** et non par
date d'arrivée : un Business arrivé à midi passe devant un Starter arrivé le
matin. Fil de discussion, notes internes invisibles du client, et un
diagnostic technique qui nomme la cause d'un blocage sans se connecter à la
place du client. Le détail au §7.

### 1.5 Surveiller

Deux surveillances distinctes, qu'il ne faut pas confondre.

**Le signal métier** : journal de toutes les interventions de l'éditeur,
filtrable par station, et détection des stations **dormantes** (aucun lavage
depuis 14 jours) — le meilleur signal avancé d'un client qui s'en va.

**La santé technique** : taux d'erreur, latence, pannes regroupées par cause,
requêtes anormalement lentes. Mesurés sur **tout** le trafic, pas seulement
sur les incidents, parce qu'un nombre d'erreurs sans dénominateur ne veut rien
dire. Le détail au §8.

### Le modèle économique que cela suppose

**Activation manuelle assistée.** Le paiement est encaissé hors application —
mobile money, virement, espèces — puis confirmé ici avec sa référence. Aucun
agrégateur n'est intégré à ce stade, et c'est volontaire : un contrat marchand
CinetPay ou Wave demande RCCM, CNI, IBAN ivoirien et trois à sept jours de
validation, et **le prélèvement récurrent sur mobile money reste l'exception**
en Afrique de l'Ouest (voir `WORKFLOW-PAIEMENT.md`). La console permet de
vendre dès maintenant sans rien jeter plus tard : `activateSubscription()`
restera le point d'entrée unique, qu'un humain l'appelle ou un webhook.

---

## 2. Activer la console

```bash
# .env
PLATFORM_ADMIN_EMAILS=vous@exemple.ci
PLATFORM_ADMIN_PASSWORD=UnMotDePasseLongEtUnique
```

Puis redémarrer. Au démarrage, `syncPlatformOperators()` **crée** les comptes
d'amorçage manquants, réactive ceux qui reviennent, et **désactive** les seuls
comptes `bootstrap` absents de la liste en supprimant leurs sessions. Les
comptes créés depuis **Console → Opérateurs** (`managed_by = 'console'`) ne
sont ni réactivés, ni désactivés, ni rétrogradés par cette liste. Le journal indique :

```
[console] Operateur cree : vous@exemple.ci
```

Rendez-vous ensuite sur **`/console`** et connectez-vous. Variable vide ⇒
aucun nouvel amorçage ; les opérateurs déjà gérés dans la Console conservent
leur accès. Sans aucun opérateur actif, la Console reste fermée.

### Changer le mot de passe d'un opérateur

`PLATFORM_ADMIN_PASSWORD` ne sert **qu'à l'amorçage** : il ne réécrit jamais un
mot de passe existant. Le chemin normal est **Console → Opérateurs → Mot de
passe** : un secret provisoire est affiché une seule fois et toutes les
sessions du compte sont révoquées. La commande ci-dessous reste un recours de
secours, notamment si plus aucun administrateur ne peut se connecter :

```bash
# Arrêter le serveur si la base est la base embarquée (PGlite : un seul
# processus peut l'ouvrir à la fois), puis :
npm run console:password -- vous@exemple.ci
npm run console:password -- vous@exemple.ci "MonNouveauMotDePasse"
```

Sans second argument, un secret est tiré au hasard et affiché une seule fois.
La commande crée le compte s'il n'existe pas, le réactive, et **ferme ses
sessions ouvertes** — un ancien secret ne peut pas continuer à s'en servir.
Elle applique le schéma et réaligne les opérateurs sur
`PLATFORM_ADMIN_EMAILS`, exactement comme un démarrage du serveur.

### Ces comptes n'ont rien à voir avec les comptes de station

C'est le changement de fond de cette version. Auparavant, le droit
d'administration était un drapeau `platform_admin` posé sur un compte
ordinaire : la même personne, le même mot de passe, la même session servaient à
exploiter une station et à administrer la plateforme. Désormais les opérateurs
vivent dans leur propre table, `platform_operators`, sans lien avec `users`.

`PLATFORM_ADMIN_PASSWORD` ne sert **qu'à l'amorçage** : il pose le mot de passe
des comptes créés au démarrage. Il ne réécrit jamais un mot de passe existant,
et peut être retiré du fichier une fois les comptes en place.

Les installations antérieures sont reprises automatiquement :
`migrateLegacyPlatformAdmins()` recopie les anciens porteurs du drapeau dans la
nouvelle table puis éteint la colonne. Le mot de passe de station n'est **pas**
repris : l'accès est réamorcé avec un secret propre à la Console, ce qui
préserve la séparation des deux systèmes.

### Vous n'avez pas besoin d'exploiter une station

La console ne demande ni organisation, ni abonnement, ni parcours de mise en
service. Elle est montée **avant** la garde de session des stations dans
`server/app.ts`, et déclarée comme branche sœur de `RootLayout` dans
`App.tsx` — l'imbriquer dedans lui aurait imposé cette garde.

---

## 3. Les décisions structurantes

### 3.1 Deux applications, pas deux rôles

Pile complète et distincte à chaque étage :

| | Station | Console |
|---|---|---|
| URL | `/` | `/console` |
| Cookie | `washpilot_session` | `washpilot_console` |
| En-tête | `Bearer` | `Console` |
| Durée de session | 30 jours | **2 jours** |
| Table des comptes | `users` | `platform_operators` |
| Préfixe d'API | `/api/v1/...` | `/api/v1/console/...` |
| Garde | `requireSession` + `requireTenantContext` | `requireOperator` |

Les deux cookies ne se croisent jamais. Prouvé en conditions réelles : une
session de station appelant `/api/v1/console/metrics` reçoit **404** ; un
cookie de console appelant `/api/v1/subscription` reçoit **401**.

La session courte est délibérée : un poste de console ouvert chez un
partenaire est un risque bien plus lourd qu'une caisse ouverte en station.

### 3.2 Aucune passerelle depuis le produit

Rien dans l'application station ne mentionne la console : ni entrée de menu,
ni lien dans l'avatar, ni redirection après connexion. Un test parcourt `src/`
et **échoue si `/console` apparaît ailleurs que dans `src/console/` et la
déclaration de route d'`App.tsx`**. L'ancienne page `/admin` et son client API
ont été supprimés du dépôt, pas seulement masqués.

### 3.3 Le refus est un 404, jamais un 403

Un 403 confirme l'existence de ce qu'il protège. Toute requête de console sans
opérateur valide reçoit `404 not_found`, le corps exact d'une route inexistante.
Pour qui sonde l'application, la console n'existe pas.

### 3.4 Toute intervention est inscrite chez le client

Chaque action écrit **deux** traces : une dans `platform_audit_logs` (vue de
l'éditeur) et une dans les `audit_logs` **de la station concernée**, visible du
propriétaire dans son journal. Si l'éditeur intervient sur des données, le
client doit pouvoir le lire chez lui. C'est la règle « on délègue
l'enregistrement, jamais la réécriture » appliquée à l'éditeur lui-même.

### 3.5 Aucune coupure automatique

Un abonnement `active` dont l'échéance est passée **n'est jamais coupé par le
système**. Il est signalé `past_due` dans les indicateurs, et un humain décide.
Un virement peut avoir deux jours de retard ; couper la caisse d'un client en
plein samedi après-midi pour cela serait indéfendable.

### 3.6 Prolonger un forfait payant est refusé

`extend-trial` sur un abonnement actif renvoie **409 `subscription_active`**.
Prolonger « l'essai » d'un client qui paie est une façon déguisée d'offrir des
jours sans trace comptable. Le geste légitime est une activation avec sa
référence.

---

## 4. La suppression d'organisation, en deux temps

Le non-but « la console ne supprime pas » est **levé** : un client a le droit
de partir, et de voir ses données disparaître. Mais une suppression immédiate
est irréparable, et une suppression différée sans coupure laisse un client
convaincu d'être parti continuer à travailler.

D'où deux temps :

| Temps | Route | Effet |
|---|---|---|
| **1. Programmer** | `POST /organizations/:id/schedule-deletion` | accès **coupé immédiatement**, purge datée à +30 jours |
| **1 bis. Annuler** | `POST /organizations/:id/cancel-deletion` | données intactes, accès rétabli |
| **2. Purger** | `POST /organizations/:id/purge` | effacement définitif, 22 tables |

Points décidés :

- **La coupure est immédiate, pas différée.** Programmer la suspension
  résilie l'abonnement et efface les sessions ouvertes. `requireTenantContext`
  refuse alors toute requête avec `403 organization_deleted`. Un délai de grâce
  protège les données, pas l'usage.
- **Annuler ne rend pas l'abonnement.** La station retrouve ses données et sa
  connexion, pas son forfait : il faut le réactiver explicitement. Une
  annulation de suppression n'est pas un cadeau commercial.
- **La purge exige le nom exact** de la station dans `confirm_name`, comparé
  après `trim()`. Sinon `400 confirmation_mismatch`.
- **Un utilisateur membre d'une autre station survit** à la purge. Seuls les
  comptes dont c'était la seule appartenance disparaissent.
- **Les écritures de l'éditeur survivent.** `platform_audit_logs` est écrit
  *après* la purge, avec `organization_id` à `null` : la trace de la
  suppression ne peut pas être effacée par la suppression elle-même.
- Les purges échues s'exécutent dans le même `tick()` que les relances
  (`server/reminders.ts`), une fois par heure.

**Si vous ajoutez une table portant `organization_id`**, ajoutez-la à
`PURGE_ORDER` dans `server/organization-deletion.ts`, ou à `PURGE_EXEMPT` si
elle doit survivre. Un test compare ces deux listes au schéma réel via
`information_schema` et **échoue** si une table n'est dans ni l'une ni l'autre.
C'est le garde-fou qui évite qu'une purge laisse des orphelins six mois après.

---

## 5. Les revenus

### 5.1 Un registre, parce qu'il n'y en avait pas

Avant cette version, **aucune table ne contenait l'argent encaissé**. Les
paiements passés par le parcours client vivaient dans `payment_intents` ;
ceux saisis directement dans la console — un virement, des espèces — ne
laissaient qu'une ligne d'audit, le montant enfoui dans du JSON. Toute courbe
bâtie là-dessus aurait sous-estimé les recettes sans prévenir.

`subscription_payments` est désormais la seule source de vérité du chiffre
d'affaires, et elle est écrite **à un seul endroit** :
`activateSubscription()`. C'est le même point de passage unique que pour
l'activation, et pour la même raison — le jour où un webhook d'agrégateur
activera des forfaits, il alimentera le registre sans qu'on y pense.

Une intention de paiement n'y entre pas : elle peut échouer ou rester en
attente. **Déclarer n'est pas payer.**

### 5.2 Deux lectures du même argent

Un client qui règle six mois d'avance verse tout en une fois. Le lire comme
un seul mois donne une pointe suivie de cinq mois morts ; on en conclut que
l'activité s'effondre. La console affiche donc les deux ensemble :

| Lecture | Ce qu'elle répond | Sur le graphique |
|---|---|---|
| **Encaissement** | de quoi je paie mes factures | les barres |
| **Revenu reconnu** | est-ce que ça croît vraiment | la ligne |

L'étalement se fait **au prorata des jours**, pas par mois entier : une
période du 15 mars au 15 juin couvre quatre mois civils, et un découpage en
tiers décalerait la courbe d'une quinzaine. Le dernier mois absorbe
l'arrondi, de sorte que la somme des parts égale toujours le montant exact.
Un test de propriété le vérifie sur deux mille montants — quelques cas
choisis à la main passent même avec un arrondi faux, c'est l'erreur qui a
d'abord échappé à la suite.

S'y ajoute une troisième grandeur, **l'encaissé d'avance** : la part des
périodes qui courent encore. Ce n'est pas du bénéfice, c'est une dette — si
le client part demain, elle lui est due.

### 5.3 Impayés

Deux natures, délibérément séparées :

- **à risque** — des stations `active` dont l'échéance est passée. Elles
  travaillent toujours, puisque rien n'est coupé automatiquement, mais ne
  paient plus. Une station programmée pour suppression en sort : on ne lui
  réclamera rien.
- **en attente** — le client affirme avoir payé, l'éditeur n'a pas vérifié.

### 5.4 Exports

Deux formats, même registre, exportant **tout** l'historique et non la page
affichée. CSV à point-virgule avec BOM UTF-8, faute de quoi Excel en français
affiche « StÃ©phane ».

**Détaillé** — une ligne par encaissement, avec les dates de début et de fin
de période.

**Journal SYSCOHADA** — écritures équilibrées, sur la base de l'encaissement
(celle du Système Minimal de Trésorerie, que retiennent la plupart des très
petites entités). Un cabinet tenant une comptabilité d'engagement voudra en
plus constater les produits d'avance : l'export détaillé porte pour cela les
périodes que le journal n'exprime pas.

| Canal | Compte débité |
|---|---|
| Espèces | **571** Caisse siège social |
| Virement | **521** Banques locales |
| Orange Money, MTN, Moov, Wave | **552** Monnaie électronique, téléphone portable |
| *(contrepartie)* | **7065** Services vendus sur internet |

Le compte 552 n'est pas un détail. Le SYSCOHADA révisé a créé la classe 55
précisément pour que le mobile money cesse d'être rangé en caisse ou en
banque par approximation : un encaissement Wave n'est ni l'un ni l'autre, et
tout mettre en 571 rendrait le rapprochement du portefeuille impossible.

Les comptes sont regroupés dans `SYSCOHADA_ACCOUNTS`
(`server/revenue.ts`) : un cabinet qui tient un plan différent n'a qu'un seul
endroit à corriger. `VAT_RATE` vaut `0` — l'éditeur n'est pas assujetti à ce
stade — et le compte **4431** est déjà déclaré pour le jour où il le sera.

### 5.5 Corriger une erreur

Une ligne de registre ne se modifie ni ne se supprime : on écrit son
inverse, avec un motif. C'est la règle « annulation tracée plutôt que
suppression », qui n'est plus ici une préférence mais une obligation — un
journal dont on peut retirer une ligne ne prouve rien. Dans l'export, une
contrepassation s'écrit en **sens inversé** et non en montant négatif : un
journal ne contient pas de nombres négatifs.

Elle touche l'argent, **pas le droit d'accès** : l'abonnement reste actif.
Si l'activation était une erreur, il faut aussi suspendre, et c'est un geste
distinct.

### 5.6 Le registre survit à la suppression du client

`subscription_payments` figure dans `PURGE_EXEMPT`. Purger une station
efface ses données mais pas le chiffre d'affaires qu'elle a payé : l'argent
a bien été reçu, il reste au bilan. La ligne est conservée, son
`organization_id` passé à `null`, et le nom recopié à l'écriture la garde
lisible dans un export.

---

## 6. Les comptes

Le reste de la console est organisé par station. Cette famille existe parce que
**le support reçoit l'appel d'une personne, pas d'une station** : « bonjour, je
n'arrive plus à me connecter », sans nom de station et souvent sans savoir quel
rôle elle occupe.

### 6.1 Deux états qu'il ne faut pas confondre

C'est la distinction qui structure toute la famille, et l'avoir manquée a
produit un défaut livré en production (§6.5).

| | Porté par | Dit quoi | Portée |
|---|---|---|---|
| **Appartenance** | `organization_members.status` | travaille-t-elle encore dans *cette* station ? | une station |
| **Compte** | `users.status` | peut-elle se connecter, *où que ce soit* ? | tout le parc |

Quelqu'un qui travaille sur deux stations peut quitter l'une sans perdre
l'autre. Un compte compromis doit pouvoir être coupé partout d'un seul geste.
Ce sont deux besoins réels, donc **deux gestes distincts** — jamais une case
unique « désactiver ».

Vérifié de bout en bout : un caissier retiré de sa station **se connecte
toujours** (son compte est vivant) mais reçoit `403 membership_disabled` sur la
station. `requireTenantContext` relit l'appartenance à chaque requête, donc le
retrait est immédiat — et aucune session n'est supprimée, sans quoi la personne
serait déconnectée de ses autres stations, où elle n'a rien fait.

### 6.2 Les gestes

| Geste | Route | Portée | Garde-fou |
|---|---|---|---|
| Retirer de cette station | `POST /organizations/:id/members/:userId/status` | une station | — |
| Changer le rôle | `POST /organizations/:id/members/:userId/role` | une station | `last_owner`, `role_unchanged` |
| Bloquer le compte partout | `POST /accounts/:userId/status` | tout le parc | `last_owner` sur **toutes** ses stations |
| Déconnecter tous les appareils | `POST /accounts/:userId/revoke-sessions` | tout le parc | — |
| Réinitialiser le mot de passe | `POST /organizations/:id/members/:userId/reset-password` | le compte | lien valable 1 h |

Tous exigent un **motif d'au moins cinq caractères**, inscrit dans le journal du
client *et* dans celui de l'éditeur.

### 6.3 Pourquoi l'éditeur peut changer un rôle

La question se pose : toucher à la hiérarchie d'un client, est-ce légitime ?

Le cas qui tranche est celui du **propriétaire parti sans successeur**. Plus
personne ne peut inviter, facturer ni gérer l'équipe, et le client ne peut pas
s'en sortir seul — c'est précisément le moment où il appelle. Refuser serait
d'ailleurs incohérent : l'opérateur peut déjà suspendre l'abonnement et
programmer la suppression de la station entière.

Le **transfert de propriété se fait en deux temps**, et l'ordre est imposé par
le garde-fou lui-même : nommer d'abord le nouveau propriétaire, rétrograder
l'ancien ensuite. Tenter l'inverse renvoie `409 last_owner`. Il n'y a donc
aucun instant où la station se retrouve sans administrateur.

Un changement de rôle **efface les permissions accordées à titre exceptionnel**
à cette personne dans cette station. Elles avaient été consenties pour l'ancien
périmètre ; les conserver donnerait au nouveau rôle des droits que personne n'a
décidés — un gérant rétrogradé caissier garderait l'accès au journal d'audit.
La réponse indique combien ont été retirées, et l'écran le dit à l'opérateur.

### 6.4 Le garde-fou du dernier propriétaire

Bloquer un compte ou retirer un rôle est refusé (`409 last_owner`) si la
personne est le **dernier propriétaire actif** d'au moins une station. Le
contrôle porte sur **toutes** ses stations, pas seulement celle qu'on regarde :
quelqu'un peut être second propriétaire ici et seul propriétaire ailleurs. Le
message nomme les stations bloquantes.

Les stations déjà programmées pour suppression sont exclues du contrôle — y
préserver un propriétaire n'a plus d'objet.

La fiche d'une personne affiche cet avertissement **avant** qu'on essaie, et le
bouton de blocage est désactivé tant que la situation dure.

### 6.5 Le défaut corrigé au passage

`POST /organizations/:id/members/:userId/status` répondait **500** depuis sa
mise en service. Elle écrivait `users.status = 'disabled'`, valeur que la
contrainte `users_status_check` refuse — cette colonne n'accepte que `active`
ou `inactive`. La route confondait les deux états du §6.1 : elle prétendait
retirer quelqu'un d'une station et bloquait son compte partout.

Les 265 tests passaient. **Aucun ne l'exerçait** : la route avait été livrée
sans jamais être appelée de bout en bout. C'est la leçon retenue — une suite
verte ne dit rien d'un chemin que personne n'a parcouru. Les 20 tests de
`tests/console-accounts.test.ts` commencent par cette régression.

### 6.6 Ce que cette famille ne fait pas

- **Changer l'adresse e-mail d'un compte.** L'adresse est l'identifiant de
  connexion ; la modifier depuis la console permettrait de rediriger un compte
  vers une boîte que l'opérateur contrôle. Le client la change lui-même.
- **Se connecter à la place d'un client.** Décision de la §3, inchangée.
- **Supprimer un compte.** Un compte n'est purgé que lorsque sa dernière
  station l'est (§4).

## 7. L'assistance

Jusqu'ici, une demande d'aide était un message WhatsApp : aucune trace, donc
aucun moyen de savoir combien de demandes sont ouvertes, depuis quand, ni si
l'on a répondu. WhatsApp reste le canal de discussion — c'est celui que les
gérants utilisent réellement, et lutter contre serait perdre. Ce qui change,
c'est que la conversation a maintenant une mémoire.

### 7.1 Les deux chemins, et pourquoi les deux

Le client ouvre sa demande **dans l'application** : elle est datée, rattachée
à sa station et à son forfait, et la réponse se lit au même endroit des
semaines plus tard. Le lien **WhatsApp** reste proposé juste en dessous, pour
l'urgence. Les deux cohabitent parce qu'ils ne servent pas à la même chose :
WhatsApp va plus vite et se perd dans le fil, l'écrit garde une trace et reçoit
une réponse suivie. L'interface le dit en ces termes au client.

### 7.2 « Assistance prioritaire » : ce que le mot engage

La page tarifaire vendait « assistance prioritaire » sans définition.
`TARIFS.md` §6 refusait d'écrire la moindre ligne tant que l'arbitrage
n'était pas fait : promettre *prioritaire* sans délai mesurable est une
promesse qu'on ne peut ni tenir ni démentir.

Le mot engage désormais **un délai de première réponse** :

| Forfait | Première réponse | Garanti |
|---|---|---|
| Business | 4 heures ouvrées | oui |
| Pro | 1 jour ouvré | oui |
| Starter | 3 jours ouvrés | oui |
| Essai, abonnement échu | 5 jours ouvrés | **non**, indicatif |

Journée d'assistance : **lundi-vendredi, 8 h – 18 h, heure d'Abidjan**. Le
calcul tient en UTC sans bibliothèque de fuseaux parce que la Côte d'Ivoire est
à UTC+0 toute l'année, sans heure d'été — hypothèse écrite en tête de
`server/support-sla.ts`, à revisiter si le produit sort de cette zone.

Une demande du samedi soir démarre lundi 8 h : le client n'est pas pénalisé
pour avoir écrit la nuit, et l'éditeur ne s'engage pas sur des heures où
personne ne travaille.

### 7.3 La priorité n'est pas un badge, c'est un ordre de traitement

La file est **triée par échéance**, pas par date d'arrivée. Un Business arrivé
à midi passe devant un Starter arrivé le matin. Aucune règle de tri
particulière n'a été écrite : l'engagement ordonne la file à lui seul, et c'est
ce qui rend la priorité réelle plutôt que décorative.

Trois propriétés qui rendent la mesure honnête :

- **L'engagement est figé au dépôt.** Il a été pris sous le forfait de ce
  jour-là ; si le client rétrograde ensuite, la promesse tient.
- **Une note interne n'arrête pas le compteur.** Sans cela, l'éditeur
  tiendrait son engagement en se parlant à lui-même.
- **Une réponse tardive reste tardive.** `breached` ne s'efface pas une fois
  la réponse envoyée. On ne réécrit pas l'histoire, sinon la mesure ne vaut
  rien.

### 7.4 Les notes internes

L'opérateur peut écrire des notes que le client ne verra jamais. C'est utile
— « déjà appelé la semaine dernière pour le même sujet » — et c'est risqué :
une fuite serait un désastre de confiance, pire que l'absence de la
fonctionnalité.

La protection n'est donc pas une discipline mais **une structure** : un seul
chemin de lecture, `threadMessages()`, dont le paramètre `includeInternal`
n'a **pas de valeur par défaut**. Une route qui l'oublie ne compile pas. Les
routes client passent `false`, la route console passe `true`, et c'est le seul
endroit du produit où une note interne sort.

Le compteur de messages renvoyé au client **exclut** lui aussi les notes :
sans cela, le client verrait qu'on lui cache un message, ce qui est pire que
de ne rien lui montrer. Quatre mutations distinctes vérifient cette
étanchéité (§11).

### 7.5 Le diagnostic, à la place de l'usurpation

« Pourquoi je ne peux pas enregistrer un lavage ? » est la question la plus
fréquente au téléphone, et la plus pénible à élucider à l'aveugle. C'est aussi
celle que le « se connecter en tant que » prétendait résoudre — refusé au §3,
et toujours refusé.

`GET /organizations/:id/members/:userId/diagnostic` évalue les causes dans
l'ordre où elles mordent et nomme celle qui bloque :

1. le compte est bloqué au niveau de la plateforme ;
2. la personne a été retirée de la station ;
3. la station est programmée pour suppression ;
4. l'abonnement est en lecture seule ;
5. un plafond du forfait est atteint.

Il montre aussi les **droits effectifs** en distinguant ce qui vient du rôle
de ce qui a été accordé à la personne — la distinction qui explique pourquoi
deux caissiers de la même station n'ont pas les mêmes droits.

**Aucun montant n'y figure.** La limite a été posée là : expliquer des
blocages, pas ouvrir la comptabilité du client. Les compteurs sont des nombres
d'objets ; le journal d'activité est réduit aux noms d'actions, parce que
`metadata` contient des sommes. Un test vérifie structurellement qu'aucune
chaîne monétaire n'apparaît dans la réponse — une évolution future qui
ajouterait un champ de montant le ferait tomber.

### 7.6 Ce que l'assistance ne fait pas

- **Pas d'usurpation d'identité**, toujours (§3). Le diagnostic répond à la
  question sans ouvrir la porte.
- **Pas de notification au client.** Une réponse ne déclenche aucun e-mail :
  le client la découvre en revenant, ou parce qu'on lui a écrit sur WhatsApp.
  C'est la limite la plus gênante de cette version — voir §12.
- **Pas de pièces jointes.** Une capture d'écran vaut souvent dix lignes de
  description ; elle passe aujourd'hui par WhatsApp.

## 8. La surveillance

### 8.1 Le problème, dit franchement

Avant cette version, une erreur 500 partait dans `console.error` et
disparaissait avec le processus. Ce n'est pas une crainte théorique : la route
de suspension d'un membre a répondu 500 pendant toute une version sans que
personne ne le sache. Ce n'est pas la production qui l'a révélée, c'est un
test écrit après coup. Entre-temps, le seul moyen d'apprendre qu'une chose
était cassée, c'était qu'un client appelle.

Un client qui appelle est déjà un client mécontent. Et tous n'appellent pas :
la plupart réessaient, renoncent, et s'en vont sans rien dire.

### 8.2 Tout le trafic, pas seulement les incidents

La console enregistre **chaque requête**, et pas uniquement celles qui
échouent. La raison tient en une phrase : sans dénominateur, un nombre
d'erreurs ne veut rien dire. Douze erreurs sur douze requêtes et douze sur
cent mille décrivent deux situations sans aucun rapport, et seule la seconde
autorise à dormir.

Le coût habituel de cette exhaustivité, c'est une table qui grossit aussi vite
que le trafic. Elle est évitée par deux mécanismes :

**L'agrégation.** Les requêtes sont comptées par tranche de cinq minutes,
croisée avec la route, la méthode et la classe de statut. Une tranche porte un
nombre d'appels, une durée cumulée et une durée maximale. Mille requêtes sur
la même route en cinq minutes tiennent en une ligne. Le volume est donc borné
par le nombre de routes, pas par le trafic.

**La normalisation des chemins.** `/api/v1/washes/<identifiant>` devient
`/api/v1/washes/:id` avant d'être compté. Sans cela, chaque lavage créerait sa
propre ligne et la table de supervision grossirait exactement comme les
données qu'elle est censée surveiller. C'est ce qui rend l'agrégation possible.

Conséquence utile : les taux affichés sont des **comptages exacts**, pas des
estimations. « 0,3 % d'erreurs » est le résultat d'une division entre deux
nombres entiers connus. Un échantillonnage aurait été moins coûteux à écrire
et aurait donné un chiffre qu'on n'aurait pas pu opposer à un client.

### 8.3 Deux registres, deux usages

| Table | Contenu | Rétention | Répond à |
|---|---|---|---|
| `request_metrics` | compteurs agrégés par tranche de 5 min | 90 jours | « Est-ce que ça va ? » |
| `error_events` | détail des pannes et des lenteurs | 30 jours | « Pourquoi ? » |

Les compteurs vivent plus longtemps que les détails, parce qu'ils pèsent
infiniment moins et qu'une comparaison d'un trimestre à l'autre a du sens.
Garder trois mois de corps de requête n'en aurait aucun.

Une requête est considérée **lente** au-delà de 2 secondes. Une lenteur est
enregistrée comme un incident à part entière, même quand la requête réussit :
c'est elle qu'on retrouvera derrière « l'application rame le vendredi soir »,
et elle ne laisse aucune trace ailleurs.

### 8.4 Les corps de requête, et la seule chose qu'on refuse d'y mettre

Le corps des requêtes est conservé. C'est un choix assumé : sans lui,
reproduire un bug suppose de redemander au client ce qu'il avait tapé, ce
qu'il ne sait généralement plus. Le corps contient donc des montants et des
noms de clients.

**Les identifiants de connexion en sont exclus.** Un corps de
`POST /auth/login` contient un mot de passe en clair ; l'écrire dans une table
de supervision transformerait un outil de diagnostic en fuite de données. Et
aucun mot de passe n'est jamais nécessaire pour comprendre une erreur : on a
besoin de savoir *qu'un* mot de passe a été envoyé, jamais lequel.

Le masquage s'applique avant écriture, récursivement, à tout champ dont le nom
évoque un identifiant — `password`, `new_password`, `secret`, tout ce qui se
termine par `token` ou `_key`, plus une liste de refus explicite (`pin`,
`cvv`, `card_number`, `apikey`, `authorization`, `cookie`). La valeur est
remplacée par `[masqué]`.

Deux garde-fous automatiques l'accompagnent :

- un test relit **le code source du serveur** et échoue si un nouveau champ
  d'identifiant y apparaît sans être reconnu comme sensible ;
- un autre vérifie chaque entrée de la liste de refus individuellement, avec
  la liste réécrite en dur dans le test. Itérer sur la constante exportée
  aurait été une tautologie : supprimer une entrée l'aurait aussi retirée du
  test, qui aurait continué à passer.

**Ouvrir un corps laisse une trace.** La consultation du détail d'un incident
écrit une ligne `monitoring.error.read` dans `platform_audit_logs`, avec
l'opérateur, la station et la route. Consulter des compteurs agrégés n'engage
personne ; lire ce qu'un gérant a saisi, si. La journalisation a lieu *avant*
la réponse : si elle échoue, la lecture échoue aussi.

### 8.5 La console seule, pas d'alerte

Aucun e-mail, aucun message automatique quand le taux d'erreur monte. C'est un
arbitrage, pas un oubli.

Une alerte mal réglée se neutralise toute seule : après la troisième fausse
alerte à deux heures du matin, on crée un filtre et plus personne ne les lit.
Les seuils ne peuvent être réglés honnêtement qu'après avoir observé le
comportement normal du service, et ce comportement n'est pas encore connu — la
première mesure date de cette version. L'écran existe maintenant ; les seuils
viendront quand il y aura des semaines de chiffres à regarder.

### 8.6 Ce que la surveillance ne fait pas

- **Pas d'astreinte téléphonique.** Les alertes partent par e-mail et modèle
  WhatsApp approuvé (§12.3) ; aucun appel vocal ni astreinte n'est simulé.
- **Pas de trace des requêtes réussies au détail.** Seuls les compteurs
  agrégés les décrivent. Un succès n'a pas besoin d'être reproduit.
- **Pas de rapprochement entre un incident et une demande d'assistance.** Si un
  client écrit « ça ne marche pas » à 14 h et qu'une panne a eu lieu à 14 h, le
  lien se fait à l'œil. L'automatiser demanderait de deviner, et une
  association fausse coûterait plus cher que l'absence d'association.
- **Pas de mesure côté navigateur.** Tout est mesuré côté serveur : une page
  lente à cause du réseau du client reste invisible ici.

## 9. Les routes

Toutes sous `/api/v1/console`, toutes derrière `requireOperator`.

**Identité** — `POST /auth/login` · `POST /auth/logout` · `GET /auth/me`

**Lecture** — `GET /metrics` · `GET /organizations?q=&status=&limit=&offset=` ·
`GET /organizations/:id` · `GET /organizations/:id/members` ·
`GET /upgrade-requests?pending=` · `GET /plans` ·
`GET /payment-intents?status=&declared=` · `GET /audit?organization_id=&limit=` ·
`GET /revenue?months=` · `GET /revenue/export?format=detail|journal&from=&to=` ·
`GET /accounts?q=&limit=` · `GET /accounts/:userId` ·
`GET /support?status=&limit=` · `GET /support/:id` ·
`GET /organizations/:id/members/:userId/diagnostic` ·
`GET /monitoring?hours=` · `GET /monitoring/errors?kind=&route=&limit=` ·
`GET /monitoring/errors/:id` · `GET /monitoring/alerts` ·
`GET /reconciliation` · `GET /reconciliation/batches/:id` ·
`GET /operators` (admin)

**Écriture** — `POST /organizations/:id/activate {plan_code, months≤36,
payment_reference?, note?}` · `/suspend {reason}` · `/extend-trial {days≤90,
reason}` · `/schedule-deletion {reason≥10, grace_days?}` · `/cancel-deletion` ·
`/purge {confirm_name}` · `POST /members/:userId/reset-password` ·
`POST /members/:userId/status {status: active|disabled, reason≥3}` ·
`POST /members/:userId/role {role, reason≥5}` ·
`POST /accounts/:userId/status {status: active|inactive, reason≥5}` ·
`POST /accounts/:userId/revoke-sessions {reason≥5}` ·
`POST /support/:id/messages {body, internal}` ·
`POST /support/:id/status {status: open|resolved}` ·
`POST /upgrade-requests/:id/decline {reason 3-300}` ·
`POST /payment-intents/:reference/confirm {note?, channel?}` ·
`POST /revenue/:id/reverse {reason≥10}` ·
`POST /reconciliation/batches` · `POST /reconciliation/run` ·
`POST /reconciliation/discrepancies/:id/resolve {note}` ·
`POST /operators` · `PATCH /operators/:id` ·
`POST /operators/:id/reset-password` · `POST /operators/:id/revoke-sessions` ·
`PUT /monitoring/alerts/settings` · `POST /monitoring/alerts/test`
(les cinq dernières familles d'administration sensible sont réservées à l'admin
pour opérateurs et alertes ; le support est en lecture seule sur toutes).

### Deux subtilités qui comptent

**Toute activation converge vers `activateSubscription()`**, dans
`server/subscription-service.ts`. Confirmation d'encaissement, activation
directe, futur webhook : un seul endroit calcule les dates, purge le cache et
écrit la trace. C'est ce qui permettra de brancher un agrégateur sans
réécrire la console.

**`actorUserId` est nullable.** Un opérateur de console n'est pas un
utilisateur de station : il ne peut pas être l'auteur d'une ligne d'audit
`audit_logs` au sens habituel. L'auteur est alors `null`, et le libellé porte
l'adresse de l'opérateur.

---

## 10. Ce que la console ne fait pas, volontairement

- **Pas d'usurpation d'identité.** Aucun « se connecter en tant que ». Voir
  les données d'un client est une chose, agir en son nom une autre.
- **Pas d'édition des limites de forfaits.** Le prix est modifiable avec motif
  et trace ; les plafonds (`max_users`, `max_workers`, `max_sites`) restent
  versionnés avec le code et les migrations.
- **Pas de modification des données d'exploitation.** La console ne corrige
  pas un lavage, ne touche pas une caisse. Elle administre des abonnements et
  des comptes.
- **Pas de changement d'adresse e-mail.** L'adresse est l'identifiant de
  connexion : la modifier depuis la console permettrait de rediriger un compte
  vers une boîte que l'opérateur contrôle.
- **Pas de notification pour une note interne.** Seule une réponse publique
  notifie le demandeur, dans sa cloche et par e-mail si Resend est configuré.
- **Pas de notification pour chaque geste d'administration.** Suspensions,
  suppressions et rapprochements restent journalisés sans spammer le client ;
  les relances d'échéance conservent leur comportement propre.
- **Pas de message WhatsApp libre.** Une alerte proactive utilise uniquement
  le modèle Meta approuvé et les destinataires configurés ; un incident ne
  contourne pas les règles de la Cloud API (§12.3).

---

## 11. Vérification

```bash
# Suite complète (377 tests)
NODE_ENV=test npm test

# Ciblé
NODE_ENV=test npx tsx --test tests/platform-admin.test.ts    # 26 tests
NODE_ENV=test npx tsx --test tests/console-deletion.test.ts  # 12 tests
NODE_ENV=test npx tsx --test tests/revenue.test.ts           # 23 tests
NODE_ENV=test npx tsx --test tests/console-accounts.test.ts  # 20 tests
NODE_ENV=test npx tsx --test tests/support-sla.test.ts       # 20 tests
NODE_ENV=test npx tsx --test tests/support-requests.test.ts  # 23 tests
NODE_ENV=test npx tsx --test tests/pricing-promises.test.ts  #  5 tests
NODE_ENV=test npx tsx --test tests/monitoring.test.ts        # 26 tests
```

Parcours manuel utile, serveur lancé :

```bash
# 1. Entrer dans la console
curl -s -c /tmp/c.txt -X POST localhost:3000/api/v1/console/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@washpilot.ci","password":"ConsoleWashPilot2026!"}'

# 2. Vérifier l'étanchéité : une session de station doit recevoir 404
curl -s -b /tmp/station.txt localhost:3000/api/v1/console/metrics

# 3. Vérifier l'étanchéité inverse : le cookie de console doit recevoir 401
curl -s -b /tmp/c.txt localhost:3000/api/v1/subscription
```

Les quatre comportements de la suppression sont couverts par un **test par
mutation** : neutraliser la coupure immédiate, autoriser une purge non
programmée, retirer une table de `PURGE_ORDER` ou supprimer la clause
protégeant les comptes multi-stations font chacun échouer la suite.

La famille « comptes » l'est aussi : réécrire `users.status` depuis la route
d'appartenance (le défaut du §6.5), retirer le garde-fou du dernier
propriétaire, conserver les permissions exceptionnelles lors d'un changement de
rôle, ou ignorer les stations en suppression dans le garde-fou — les quatre
sont détectés.

L'assistance l'est également, sur cinq mutations : faire fuir les notes
internes par le fil, les laisser arrêter le compteur d'engagement, trier la
file par date d'arrivée plutôt que par échéance, ouvrir les demandes d'un
collègue à tout le monde, ou compter les notes internes dans le compteur
affiché au client.

La surveillance a été éprouvée sur **sept mutations, toutes détectées** :
désactiver le masquage, retirer une seule entrée de la liste de refus, cesser
de normaliser les identifiants dans les chemins, arrondir le taux d'erreur à
l'entier, ne plus journaliser la lecture d'un corps, purger sans respecter la
rétention, et revenir au `console.error` seul.

La deuxième mérite un mot, parce qu'elle a d'abord **échappé** à la suite. La
première version de la mutation ne neutralisait que la liste de refus, et les
règles par sous-chaîne rattrapaient tout : les tests passaient. En cherchant
pourquoi, sept champs sont apparus — `pwd`, `pin`, `cvv`, `card_number`,
`apikey`, `authorization`, `cookie` — que seule la liste protégeait, et
qu'aucun test ne couvrait. Deux tests ont été ajoutés avant de poursuivre. La
mutation qui ne tue personne est celle qui apprend quelque chose.

Le masquage est également vérifié **de bout en bout** sur un serveur réel : une
requête portant un vrai mot de passe provoque une vraie panne, puis la table
entière est fouillée pour s'assurer que la chaîne n'y figure nulle part.

L'arithmétique des heures ouvrées est couverte autrement : `addBusinessHours`
consomme un solde, `businessHoursBetween` balaie les journées. Deux
raisonnements indépendants, confrontés sur **six mille tirages**. C'est ce
contrôle qui a rattrapé un exemple écrit à la main — et faux — dans le test
lui-même.

---

## 12. Rôles, alertes et rapprochement

### 12.1 Déléguer sans partager le compte du créateur

L'écran **Opérateurs** gère les comptes de la Console : création, nom, rôle,
activation/désactivation, réinitialisation du mot de passe et révocation des
sessions. Le mot de passe provisoire n'apparaît que dans la réponse de
création/réinitialisation ; il n'est ni listé, ni journalisé, ni stocké en
clair. Un changement d'accès exige un motif. Le compte connecté ne peut pas se
retirer son propre accès admin, et un verrou transactionnel protège aussi le
dernier administrateur actif.

| Rôle | Lecture | Écriture d'exploitation | Opérateurs et réglages d'alertes |
|---|---|---|---|
| `admin` | oui | oui | oui |
| `supervisor` | oui | oui | non |
| `support` | oui | **non** | non |

Le garde `requireConsoleWrite` est appliqué dans le routeur Express, pas
seulement dans la navigation. Les boutons d'écriture sont également masqués au
support. Les routes `/operators` ainsi que la configuration et le test des
alertes ont un second garde `requireConsoleAdmin`. Les changements de rôle
sont relus depuis la base à chaque requête : une session déjà ouverte ne
conserve pas un ancien droit.

### 12.2 Prévenir le client d'une réponse publique

Une réponse publique d'assistance et sa notification `SUPPORT_REPLY` sont
validées dans la **même transaction**. Elle cible le demandeur, avec le type
`support_request` et l'identifiant du ticket : la cloche ouvre directement
`/support?request=<id>`. L'e-mail est tenté **après** le commit ; une clé
Resend absente ou un refus du fournisseur ne retire ni la réponse ni la
notification, et l'opérateur voit l'état de remise.

Une note interne reste invisible du client et ne crée **aucune** notification
ou e-mail. Elle ne clôt pas non plus l'engagement de première réponse.

### 12.3 Alerter au lieu d'attendre un appel

**Surveillance → Alertes proactives** règle : activation, taux de 5xx, trafic
minimum, nombre de requêtes lentes, fenêtre, cooldown et destinataires. Le
minimum de trafic évite « 100 % d'erreurs » sur un seul appel ; le cooldown est
réservé sous verrou transactionnel pour éviter les doublons entre instances.
Chaque événement et chaque remise, réussie ou refusée, restent consultables.

Les e-mails utilisent Resend. WhatsApp utilise la Cloud API avec un **modèle
approuvé à deux variables** (titre, détail), car une alerte proactive sort du
fenêtrage de 24 h. Les secrets Meta ne sont pas enregistrés en base. Un test
manuel est disponible sans activer la surveillance automatique.

```dotenv
RESEND_API_KEY=...
MAIL_FROM=WashPilot CI <alertes@exemple.ci>
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ALERT_TEMPLATE=washpilot_operations_alert
WHATSAPP_ALERT_TEMPLATE_LANGUAGE=fr
MONITORING_ALERT_INTERVAL_MINUTES=5
```

### 12.4 Rapprocher sans réécrire la comptabilité

**Rapprochement** accepte un CSV ou un JSON (2 000 lignes maximum par lot).
Les alias courants sont normalisés : `reference` / `merchant_reference`,
`transaction_id` / `provider_reference`, `amount` en francs ou `amount_cents`,
`status`, `paid_at`. Les montants texte acceptent espaces et virgule décimale.
Les lignes non payées sont conservées mais ignorées par la correspondance.

Le moteur compare d'abord les références marchand/opérateur, puis les montants.
Une correspondance exacte pose `reconciled_at` sur le paiement. Les autres cas
ouvrent un écart : montant différent, ligne absente du registre, encaissement
absent du relevé ou référence ambiguë. Un opérateur clôt l'écart avec un motif.
**Aucun écart ne change un montant et aucune ligne de relevé n'active un
abonnement.** La confirmation manuelle de l'encaissement reste nécessaire.

Le connecteur facultatif appelle une URL qui reçoit `from` et `to` en ISO et
renvoie CSV ou JSON (`entries`, `data`, ou tableau direct). La cadence suit la
fenêtre pour ne pas réimporter le même relevé à chaque passage horaire ; le
bouton de la Console force un contrôle immédiat.

```dotenv
RECONCILIATION_ENABLED=true
RECONCILIATION_PROVIDER=wave
RECONCILIATION_STATEMENT_URL=https://agregateur.exemple/releves
RECONCILIATION_STATEMENT_TOKEN=...
RECONCILIATION_LOOKBACK_HOURS=24
```

Sur un serveur, alertes et rapprochement sont planifiés dans
`startReminderScheduler()` ; sur Vercel, le cron sécurisé existant appelle les
deux moteurs en plus des relances. Il ne s'agit toujours **pas** d'une
intégration d'encaissement en ligne ni d'un webhook d'activation.

---

## 13. Prochaines marches

1. **Brancher un agrégateur de paiement** si le contrat marchand est obtenu :
   son webhook appellera `activateSubscription()` et la file de confirmation
   deviendra le mode dégradé. Le rapprochement de relevé livré au §12.4 ne
   remplace pas cette intégration.
2. **Rapprocher les versements bancaires nets** en plus des transactions :
   frais de l'agrégateur, date de valeur et lot de payout demandent un modèle
   distinct des encaissements de chaque abonnement.
3. **Ajouter un canal de remise supplémentaire** si l'exploitation en a
   besoin, en conservant l'historique, le cooldown et les tests de remise.
