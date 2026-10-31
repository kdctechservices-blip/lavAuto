# Audit des 11 fonctions cœur — WashPilot CI (LAVAUTO)

Date : 20 octobre 2026 · Portée : les 11 fonctions métier essentielles d'une
station de lavage en Côte d'Ivoire.

Pour chaque fonction : ce qui existait, ce qui manquait, ce qui a été livré, et
comment le vérifier soi-même.

---

## Tableau de bord de l'audit

| # | Fonction | Avant | Après | Livré dans cette itération |
|---|----------|-------|-------|-----------------------------|
| 1 | Enregistrement d'un lavage | Complet mais peu utilisable au pouce | Opérationnel sur mobile | Cibles tactiles 44 px, clavier numérique, barre total collante, bouton « Appoint exact » |
| 2 | Catalogue des prestations | Complet | Inchangé | — (aucun défaut constaté) |
| 3 | Encaissements | **Incomplet** : mobile money bloqué en attente, sans issue | Complet | Module `payments`, page Encaissements, confirmation, paiement partiel |
| 4 | Caisse | Solide | Renforcé | Les encaissements espèces alimentent automatiquement la caisse ouverte |
| 5 | Dépenses | Complet | Inchangé | — |
| 6 | Suivi des laveurs | **Absent des rapports** | Complet | Classement « Activité par laveur » (serveur + écran + export) |
| 7 | Rapports | Jour uniquement, CA incohérent | Complet | Granularité jour/semaine/mois, encaissements confirmés vs à confirmer, CSV enrichi |
| 8 | Multi-station | Filtré partout, **non testé** | Garanti par les tests | Suite d'isolation inter-stations (5 tests) |
| 9 | Sécurité et données | Contrôle par rôle grossier, **aucune sauvegarde** | Complet | Export JSON, `pg_dump`/`pg_restore`, écran « Données et sauvegarde », puis **permissions par action** (voir `RBAC-PERMISSIONS.md`) |
| 10 | Essai et abonnement | Essai livré, **sans relance ni issue** | Complet | Relances J-3 / J-1 / échéance, demande d'activation de forfait |
| 11 | Assistance | **Absente** | Complet | Bouton WhatsApp flottant avec message pré-rempli |

Vérifications automatiques : **113 tests** (50 avant cette itération, 80 après
la mise à niveau fonctionnelle, 113 après l'ajout du contrôle d'accès).

---

## 1. Enregistrement d'un lavage

**Constat.** Le formulaire était fonctionnel (station, catégorie de véhicule,
prestations multiples, moyen de paiement, montant reçu) et correctement protégé
par une clé d'idempotence — un double-clic ne crée pas deux lavages. En
revanche, il avait été dessiné pour une souris : cases à cocher de 16 px,
champ de quantité de 24 px de haut, total visible seulement après défilement.
Or un lavage se saisit debout, sur téléphone, parfois sous la pluie.

**Livré.**

- Cibles tactiles portées à 44 px minimum (recommandation d'accessibilité
  mobile), vignette de prestation surlignée quand elle est sélectionnée.
- `inputMode="numeric"` sur les montants et quantités : le clavier du
  téléphone s'ouvre directement sur les chiffres.
- Barre de récapitulatif collante en bas du formulaire : le total à encaisser
  et le bouton « Enregistrer » restent sous le pouce.
- Bouton « Appoint exact » qui recopie le total dans le montant reçu — le cas
  le plus fréquent en station.

**À vérifier.** Ouvrir « Nouveau lavage » sur un téléphone : le total reste
visible pendant la sélection des prestations.

---

## 2. Catalogue des prestations

**Constat.** Catégories de services, catégories de véhicules, prix par type de
véhicule, activation/désactivation, contrôle d'accès par rôle : rien à
redire. Aucune modification apportée — un audit doit aussi savoir ne rien
toucher.

---

## 3. Encaissements (fonction la plus défaillante)

**Constat.** C'était le trou le plus coûteux du produit. À la création d'un
lavage réglé en Orange Money, MTN MoMo, Moov Money ou Wave, le paiement était
inséré avec le statut `pending`… et **aucun écran, aucune route ne permettait
de le confirmer**. Conséquences concrètes :

- l'argent réellement reçu n'apparaissait nulle part comme encaissé ;
- un lavage réglé en deux fois (acompte + solde) était impossible ;
- le chiffre d'affaires affiché divergeait de la réalité.

**Livré.** Un module d'encaissement complet (`server/payments.ts`) :

| Route | Rôle | Effet |
|-------|------|-------|
| `GET /api/v1/payments` | tous | Journal filtrable par statut et par canal, avec totaux par canal |
| `POST /api/v1/washes/:id/payments` | propriétaire, responsable, caissier | Encaisse tout ou partie du solde (clé d'idempotence obligatoire) |
| `POST /api/v1/payments/:id/verify` | propriétaire, responsable | Confirme la réception d'un paiement mobile money |

Règles métier appliquées :

- **Espèces** → confirmé immédiatement **et** écrit dans la caisse ouverte de
  la station (mouvement d'entrée). Si l'appelant ne précise pas la session, le
  serveur prend celle qui est ouverte sur la station du lavage ; s'il n'y en a
  aucune, l'encaissement est refusé avec un message explicite.
- **Mobile money** → enregistré « à confirmer », puis confirmé manuellement
  quand le SMS de l'opérateur arrive.
- Le montant ne peut jamais dépasser le solde restant ; un lavage annulé ou
  déjà réglé est refusé ; un remboursement ne compte pas comme encaissé.
- Chaque opération est tracée (`payment.recorded`, `payment.verified`).

Côté écran, une page **Encaissements** (`/payments`) : quatre totaux, la
répartition par canal avec les colonnes confirmé / à confirmer, et un journal
filtrable où chaque ligne en attente porte son bouton « Confirmer ». Sur la
fiche d'un lavage, le solde restant est affiché avec un bouton
« Encaisser le solde » et un bouton « Solde entier ».

**À vérifier.** Créer un lavage payé en Wave sans montant, ouvrir sa fiche,
encaisser la moitié : le lavage passe à « Partiellement réglé », la ligne
apparaît « À confirmer » dans `/payments`, et « Confirmer » la bascule en
« Confirmé ».

---

## 4. Caisse

**Constat.** La mécanique était saine : ouverture avec fonds de caisse,
mouvements d'entrée et de sortie, clôture avec comptage, écart calculé et motif
obligatoire au-delà d'un seuil. Le défaut n'était pas dans la caisse mais à
côté : les encaissements n'y entraient pas systématiquement.

**Livré.** Tout encaissement en espèces crée désormais son mouvement de caisse,
quel que soit l'écran d'origine. Vérifié en conditions réelles : solde
théorique passé de 31 000 à 34 000 FCFA après un encaissement de 3 000 FCFA.

---

## 5. Dépenses

**Constat.** Création, modification, catégories, bénéficiaire, pièce
justificative, sortie de caisse associée : complet. Aucune modification.

---

## 6. Suivi des laveurs

**Constat.** Les laveurs étaient bien affectés aux lavages
(`wash_assignments`), mais **cette donnée n'était exploitée nulle part**.
Impossible de répondre à « combien de voitures Jean-Marc a-t-il lavées cette
semaine ? », alors que la réponse était en base.

**Livré.** Le rapport renvoie désormais un classement `top_workers` (laveur,
rôle, nombre de lavages, chiffre d'affaires associé), affiché dans un tableau
« Activité par laveur » et inclus dans l'export CSV. Les rôles sont affichés
en clair : Laveur, Laveur polyvalent, Chef d'équipe, Caissier, Responsable.

**À vérifier.** Rapports → période « Cette semaine » → tableau « Activité par
laveur ». Sur les données de démonstration : Jean-Marc Koffi 2 lavages,
Ibrahim Touré 1 lavage.

---

## 7. Rapports

**Constat.** Trois défauts : granularité journalière uniquement (illisible
au-delà d'un mois) ; chiffre d'affaires calculé différemment sur le tableau de
bord et dans les rapports ; aucune distinction entre l'argent réellement reçu
et l'argent annoncé.

**Livré.**

- Granularité **Jour / Semaine / Mois** (semaine commençant le lundi), avec
  raccourcis Aujourd'hui, Cette semaine, Ce mois, 90 jours, 12 mois.
- Même définition du chiffre d'affaires partout (tous les paiements non
  remboursés), et séparation explicite **confirmé / à confirmer**, avec un
  bandeau d'alerte quand des encaissements attendent confirmation.
- Export CSV enrichi : granularité, séries avec dates de fin de période,
  répartition par canal, activité par laveur.
- La granularité est validée par liste blanche avant d'atteindre le SQL
  (aucune interpolation de paramètre utilisateur dans la requête).

**À vérifier.** `GET /api/v1/reports/summary?from=…&to=…&granularity=year`
renvoie `invalid_granularity` ; `granularity=week` renvoie une série
hebdomadaire.

---

## 8. Multi-station (isolation des données)

**Constat.** Toutes les requêtes filtraient bien par `organization_id`, mais
**aucun test ne le garantissait**. Une fuite inter-stations est le type de
régression qui passe inaperçu jusqu'au jour où un client voit le chiffre
d'affaires d'un concurrent.

**Livré.** `tests/tenant-isolation.test.ts` crée une seconde station complète
(site, catalogue, laveur, lavage, prestation, paiement) à côté de la station de
démonstration, puis vérifie que :

1. les lavages d'une station n'apparaissent jamais chez l'autre ;
2. l'identifiant d'un lavage d'une autre station reste introuvable (c'est
   exactement la requête de la fiche de lavage) ;
3. l'export de sauvegarde d'une station ne contient aucune donnée de l'autre,
   y compris dans les tables enfants jointes ;
4. les agrégats financiers sont cloisonnés ;
5. laveurs, prestations, sites et catégories de véhicules restent invisibles.

---

## 9. Sécurité, contrôle d'accès et sauvegarde

**Constat.** Le contrôle d'accès par rôle couvrait 100 % des écritures, les
sessions et l'audit étaient en place. En revanche : **aucun mécanisme de
sauvegarde**. Pour une station dont toute la comptabilité vit dans l'outil,
c'est le risque majeur.

**Livré, à deux niveaux.**

1. **Export applicatif** — `GET /api/v1/backup/export` produit un fichier JSON
   contenant l'intégralité des données de la station (18 ensembles : station,
   équipe, abonnement, sites, catalogue, laveurs, clients, lavages et leurs
   lignes, affectations, paiements, caisses, mouvements, dépenses, journal
   d'audit). Réservé au propriétaire et au responsable, tracé
   (`backup.exported`), et **volontairement autorisé même lorsque l'essai est
   terminé** : les données d'un client ne doivent jamais être prises en otage.
2. **Sauvegarde serveur** — `scripts/db-backup.sh` (pg_dump format custom,
   purge automatique au-delà de 30 jours) et `scripts/db-restore.sh`
   (pg_restore avec confirmation explicite).

Un écran **Paramètres → Données et sauvegarde** réunit le tout : volumétrie,
bouton de téléchargement, date du dernier export, procédure de restauration et
rappel des droits par rôle.

**Règle d'exploitation recommandée.** Une sauvegarde quotidienne automatique,
7 quotidiennes + 1 mensuelle conservées, copie hors du serveur, et **un test de
restauration par trimestre** : une sauvegarde jamais restaurée n'est pas une
sauvegarde.

**À vérifier.** Paramètres → Données et sauvegarde → « Télécharger la
sauvegarde ». Le fichier obtenu se nomme
`washpilot-sauvegarde-<station>-<date>.json`.

---

## 10. Essai gratuit, relances et passage au forfait payant

**Constat.** L'essai de 14 jours et la réduction d'accès à l'échéance étaient
livrés, mais sans aucune relance : le gérant découvrait la bascule en lecture
seule en pleine journée de travail. Et une fois décidé à payer, aucun chemin
ne lui était proposé.

**Livré.**

- **Trois relances par e-mail**, une seule fois chacune : J-3, J-1 (« dernier
  jour »), et à l'échéance (« votre espace est en lecture seule »). Chaque
  relance rappelle que les données restent consultables et exportables.
- Anti-doublon garanti en base : la table `subscription_reminders` réserve la
  relance avant l'envoi, donc deux instances du serveur ne peuvent pas envoyer
  le même message deux fois.
- Planificateur interne toutes les heures (`REMINDERS_INTERVAL_MINUTES`),
  sans dépendance à un cron externe ; désactivable par `REMINDERS_ENABLED`.
- **Demande d'activation de forfait** depuis Paramètres → Forfait : la demande
  est tracée, l'assistance est notifiée par e-mail, et le gérant reçoit un lien
  WhatsApp pré-rempli pour finaliser le paiement (mobile money, espèces ou
  virement — aucun paiement n'est saisi dans l'application).

**Séquence vérifiée** sur les données de démonstration : J+10 → aucune
relance · J+3 → `trial_j3` · repasse immédiate → aucune (anti-doublon) ·
J+1 → `trial_j1` · J-1 → `trial_expired` · repasse → aucune.

---

## 11. Assistance

**Constat.** Aucun canal d'aide dans l'application. En Côte d'Ivoire,
l'assistance se fait sur WhatsApp : exiger un e-mail revient à n'être
joignable par personne.

**Livré.** Un bouton « Aide » flottant, présent sur tous les écrans connectés,
ouvre une carte proposant WhatsApp (canal principal) et l'e-mail (recours). Le
message WhatsApp est pré-rempli avec le nom du gérant, la station, le forfait
et **l'écran depuis lequel il écrit** — l'assistance sait de quoi on parle dès
le premier message.

Configuration : `SUPPORT_WHATSAPP` et `SUPPORT_EMAIL`. Hors production, un
numéro de démonstration est affiché et signalé comme tel.

---

## Comment tout vérifier

```bash
npm test                       # 113 tests (permissions, encaissements, rapports,
                               # relances, assistance, isolation multi-station)
./node_modules/.bin/tsc -b     # typage
npm run lint                   # 0 erreur
npm run build                  # build de production
```

Vérifications manuelles conseillées, dans l'ordre : créer un lavage réglé en
Wave → l'encaisser partiellement → le confirmer depuis `/payments` → consulter
les rapports en granularité semaine → télécharger la sauvegarde → ouvrir le
bouton d'aide.

---

## Ce qui n'a volontairement pas été fait

- **Remboursements.** Le statut `refunded` existe et est correctement ignoré
  dans tous les calculs, mais aucun écran ne déclenche un remboursement. Un
  lavage comportant un paiement confirmé ne peut donc pas être annulé. C'est un
  choix prudent : un remboursement touche la caisse, la comptabilité et
  l'audit ; il mérite sa propre itération plutôt qu'un bouton improvisé.
- **Paiement en ligne du forfait.** Aucune intégration d'agrégateur mobile
  money : la demande d'activation passe par l'assistance. Tant que le volume de
  stations reste faible, un rappel téléphonique convertit mieux qu'un
  formulaire de carte bancaire.
- **Notifications WhatsApp automatiques** (reçu envoyé au client après lavage) :
  nécessite un compte WhatsApp Business API, donc un budget et une validation
  Meta. Le canal d'assistance actuel ne requiert rien.

---

## 12. Mise à niveau sur les services annoncés dans la grille tarifaire

La page tarifaire promet seize fonctionnalités réparties sur trois forfaits.
L'inventaire ligne à ligne a montré que **douze étaient livrées**, une relève
de l'accompagnement humain, une reste à arbitrer, et **quatre manquaient**.
Cette section décrit ce qui a été construit pour combler l'écart. Les
restrictions par forfait ne sont **pas** encore posées : à ce stade, les
fonctions existent pour tous, l'étape suivante consistera à les réserver.

### 12.1 Ce qui manquait réellement

| Promesse | Forfait | État avant | Nature du manque |
| --- | --- | --- | --- |
| Historique des opérations et traçabilité | Pro | Table `audit_logs` alimentée par dix écritures | Aucune lecture possible : les traces s'accumulaient sans être consultables |
| Gestion multi-sites | Business | CRUD serveur complet et déjà protégé | Aucun écran : la fonctionnalité était inatteignable |
| Vue consolidée du propriétaire | Business | — | `server/reports.ts` ne mentionnait pas une seule fois la notion de site |
| Rapports consolidés | Business | — | Idem |

Trois promesses soupçonnées manquantes se sont révélées présentes : le rapport
quotidien (`granularity=day`), les marges opérationnelles (`net_cents`) et les
permissions avancées. L'« assistance prioritaire » n'a aucune notion de
priorité dans `server/support.ts` : c'est un engagement de délai, à trancher
commercialement avant d'être codé. L'« accompagnement à la mise en service »
est un service humain, hors logiciel.

### 12.2 Historique des opérations

**Le choix structurant : l'historique est en lecture seule.** `server/audit-log.ts`
n'expose aucune route d'écriture, de modification ou de suppression — pas même
pour le propriétaire. Un historique que l'on peut retoucher ne prouve rien ; il
perdrait exactement la valeur pour laquelle il est vendu. Une erreur se corrige
en enregistrant l'opération inverse, qui laisse à son tour sa trace. Un test
vérifie que `POST`, `PATCH`, `PUT` et `DELETE` sont tous rejetés.

Les traces existaient déjà : annulation de lavage, remboursement, clôture de
caisse avec écart, dépense créée/modifiée/supprimée, changement de droits,
refus d'accès, sauvegarde, fin d'intégration. Le travail a consisté à les
rendre lisibles :

- `GET /api/v1/audit-logs` — filtres `action`, `entity_type`, `actor_user_id`,
  `from`, `to`, pagination (`limit` plafonné à 200). Tri antichronologique
  avec départage par identifiant, sans quoi deux écritures de la même
  transaction s'intervertiraient d'un appel à l'autre.
- `GET /api/v1/audit-logs/filters` — ne propose que les valeurs **réellement
  présentes** dans l'organisation. Une liste déroulante remplie d'actions
  jamais survenues renvoie l'utilisateur vers des écrans vides.
- Les codes techniques sont traduits côté serveur (`AUDIT_ACTION_LABELS`), pas
  côté écran : l'export CSV et le tableau disent ainsi exactement la même
  chose. Une action inconnue retombe sur son code plutôt que de disparaître.
- Les actions automatiques, sans auteur, sont attribuées à « Système ».
- Un refus d'accès est marqué « Vigilance » : c'est le seul événement qui
  mérite d'attirer l'œil dans une liste par ailleurs routinière.

**Nouveau droit `audit:read`** (« Consulter l'historique des opérations »),
accordé au propriétaire et au gérant, refusé par défaut au caissier et à
l'agent de lavage, mais délégable au cas par cas. Le total passe à
28 permissions.

**Écran `/history`** : filtres par période, opération, objet et auteur ; lignes
dépliables affichant le détail (motif d'un remboursement, écart de caisse) ;
export CSV de la page affichée, séparateur point-virgule et BOM UTF-8 pour
qu'Excel en locale française l'ouvre correctement du premier coup.

### 12.3 Gestion multi-sites

Le serveur était déjà complet et correctement protégé — lecture avec
`wash:read`, écriture avec `settings:manage`. Seul l'écran manquait.
`/sites` expose la création, la modification, l'activation/désactivation et la
suppression.

**Désactiver plutôt que supprimer.** Le serveur refuse (409 `site_in_use`) la
suppression d'une station à laquelle des lavages, caisses, dépenses ou
travailleurs sont rattachés, et l'écran relaie ce message en orientant vers la
désactivation. Une station fermée conserve son activité dans les rapports des
mois précédents ; la supprimer trouerait la comptabilité. La suppression reste
possible pour une station créée par erreur, jamais encore utilisée.

La limite de stations du forfait (`max_sites`) est affichée à titre indicatif
et désactive le bouton d'ajout lorsqu'elle est atteinte — c'est une information,
pas encore un garde-fou serveur.

### 12.4 Vue consolidée et rapports consolidés

`/reports/summary` accepte désormais `site_id` et renvoie deux choses nouvelles.

**Le filtre par station.** L'identifiant est validé (400 `invalid_site`) puis
vérifié en base contre l'organisation (404 `site_not_found`) avant d'atteindre
la moindre requête. Répondre 200 avec zéro ligne pour une station étrangère
révélerait son existence ; on répond comme pour un identifiant inventé. Le
filtre traverse les huit requêtes du rapport — résumé, dépenses, série
temporelle, prestations, moyens de paiement, postes de dépense, laveurs. La
table `payments` ne porte pas de `site_id` : le rattachement passe par
`wash_id → washes.site_id`.

**La ventilation `by_site`**, qui est la vue du propriétaire proprement dite :
une ligne par station — lavages, encaissements, dépenses, solde — **toujours
calculée, même lorsqu'un filtre de station est posé**. C'est l'intérêt de la
vue : comparer les points de vente sans perdre le détail de celui que l'on est
en train de regarder, et sans changer de filtre trois fois. Une station ouverte
mais sans activité apparaît à zéro plutôt que de disparaître du tableau, sans
quoi on croirait l'avoir fermée.

Les dépenses et la marge suivent la règle déjà en place : sans
`report:financial`, elles valent `null` par station comme au total, tandis que
le chiffre d'affaires reste visible. Le tableau et le sélecteur de station
n'apparaissent qu'à partir de deux stations : un filtre à une seule valeur
n'apporte rien.

L'export CSV porte la mention du périmètre en tête, intègre le bloc par station
et nomme le fichier d'après la station filtrée — un rapport détaché de l'écran
ne doit pas pouvoir être confondu avec le consolidé.

### 12.5 Vérification

29 tests ajoutés, 152 au total.

- `tests/audit-log.test.ts` (17) — libellés, droits par rôle, contenu des
  entrées, ordre antichronologique, filtres, pagination sans doublon, borne de
  fin incluse, absence de route d'écriture, cloisonnement entre organisations.
- `tests/multi-site-reports.test.ts` (12) — rejet d'un identifiant malformé
  avant le SQL, 404 sur une station étrangère, égalité entre la somme des
  stations filtrées et le total consolidé, propagation du filtre aux moyens de
  paiement, postes de dépense et série temporelle, ventilation conservée sous
  filtre, station vide affichée à zéro, masquage financier par station.
