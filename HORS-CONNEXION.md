# Fonctionnement hors connexion

Date : 21 octobre 2026 · Modules : `public/sw.js`, `src/lib/offline-queue.ts`,
`src/lib/offline-sync.ts`, `src/lib/offline-db.ts`

Une station de lavage à Yopougon perd le réseau. Le caissier a trois voitures devant
lui. Soit il note sur un bout de papier — et on revient au cahier que ce produit
remplace —, soit l'application encaisse quand même. Ce document décrit ce qui a été
construit pour le second cas, et ce qui ne l'a pas été.

---

## 1. Ce qui marche sans réseau

**L'application s'ouvre.** Un service worker garde en mémoire la page et ses fichiers.
Le caissier retrouve son écran au lieu du message d'erreur du navigateur.

**Le catalogue est là.** Prestations, tarifs, stations, catégories de véhicule,
laveurs : les quatre listes nécessaires pour composer un lavage sont conservées
depuis la dernière fois qu'elles ont été vues.

**Le lavage s'enregistre.** Il est écrit sur l'appareil et part tout seul au retour
du réseau. Le caissier voit un bandeau qui lui dit combien d'enregistrements
attendent.

**L'application s'installe** sur l'écran d'accueil du téléphone, avec deux raccourcis :
enregistrer un lavage, ouvrir la caisse.

---

## 2. La règle qui compte le plus

**La clé d'idempotence est tirée au moment de la saisie, jamais au moment de l'envoi.**

Sans cette règle, voici ce qui arriverait : la requête part, le réseau coupe avant que
la réponse revienne, l'application réessaie. Le serveur, lui, avait bien enregistré le
lavage. Il en enregistre un second. Le client a payé une fois, la caisse en compte
deux, et le comptage du soir ne tombe plus juste.

Avec la clé figée à la saisie, le serveur reconnaît la seconde tentative et renvoie le
premier enregistrement sans rien créer.

C'est le test `la clé d'idempotence ne change pas d'une tentative à l'autre`, et une
mutation volontaire a confirmé qu'il échoue dès qu'on régénère la clé.

---

## 3. Les quatre autres règles

**Premier entré, premier sorti, un seul envoi à la fois.** L'ordre des opérations de
caisse ne se discute pas, et deux envois en parallèle arriveraient dans le désordre.

**Une coupure arrête le défilement.** Revenir en ligne une seconde ferait sinon échouer
trente envois d'affilée, pour une raison qui n'a rien à voir avec leur contenu.

**Un refus ne bloque pas la file.** Une opération que le serveur rejette
définitivement — caisse fermée entre-temps, prestation supprimée — est mise de côté et
montrée au gérant avec la raison exacte. Les suivantes partent quand même : une seule
ligne fautive ne doit pas retenir la recette de la journée. Rien ne disparaît sans une
décision humaine.

**Un enregistrement appartient à qui l'a fait.** Si le caissier du matin laisse des
lignes en attente et que celui du soir se connecte, elles ne partent pas sous le compte
du second — le journal attribuerait l'encaissement à la mauvaise personne.

---

## 4. Ce qui ne part PAS en différé, et pourquoi

Seules deux opérations sont mises en file : **l'enregistrement d'un lavage** et **une
dépense**. Pour y figurer, une opération doit remplir deux conditions : être protégée
par une clé d'idempotence côté serveur, et être **autonome**.

Autonome signifie : ne dépendre d'aucun identifiant qu'une autre opération de la file
viendrait tout juste de créer.

C'est pourquoi **l'ouverture d'une session de caisse est exclue**. Si elle partait en
différé, un lavage en espèces enregistré ensuite désignerait une session qui n'existe
pas encore côté serveur, et serait rejeté à l'arrivée. La règle d'exploitation qui en
découle est simple : **la caisse s'ouvre en ligne, le matin.** Les ventes de la journée,
elles, peuvent attendre.

Sont également exclues les annulations (l'état a pu changer entre-temps) et toutes les
modifications (une modification différée écraserait une correction faite par quelqu'un
d'autre).

---

## 5. Ce qui n'est jamais mis en cache

- **Les écritures.** Une écriture servie depuis un cache ferait croire à un
  encaissement qui n'a jamais atteint le serveur.
- **Les rapports, les revenus, le journal.** Un chiffre d'affaires périmé affiché sans
  avertissement est pire qu'une page qui dit « hors ligne ».
- **La console de l'éditeur**, qui n'a rien à faire sur le téléphone d'une station.

À la déconnexion, les données d'API gardées sur l'appareil sont effacées : sur un
téléphone partagé entre deux caissiers, le catalogue et les tarifs d'une station n'ont
pas à rester lisibles après le départ du premier. Les opérations encore en attente, en
revanche, sont **conservées** — elles appartiennent à leur auteur et repartiront à sa
prochaine connexion.

---

## 6. Limites assumées

**Les rapports ne fonctionnent pas hors connexion.** C'est volontaire (§5).

**Un lavage en espèces exige une caisse ouverte en ligne** (§4).

**Le stock n'est pas déduit tant que le lavage n'est pas parti.** La déduction a lieu
côté serveur ; un inventaire consulté pendant une coupure ignore donc les ventes en
attente.

**Rien ne purge la file automatiquement.** Une opération refusée reste affichée jusqu'à
ce que quelqu'un la renvoie ou l'abandonne. C'est délibéré : une recette ne disparaît
pas toute seule.

**Le service worker ne s'active qu'en production.** En développement, il est au
contraire désenregistré — mettre en cache des modules non compilés conduirait à déboguer
une version fantôme de son propre code.

---

## 7. Comment le vérifier

```bash
NODE_ENV=test npx tsx --test tests/offline-queue.test.ts   # 14 tests, la logique
NODE_ENV=test npx tsx --test tests/pwa.test.ts             # 11 tests, le manifeste
```

Les tests du manifeste vérifient que **tout ce qu'il annonce existe** : chaque icône est
sur le disque, chaque raccourci mène à une route déclarée. Ce dernier test a déjà servi :
le raccourci « nouveau lavage » pointait vers `/washes/nouveau`, qui n'existe pas et
serait tombé sur la route `/washes/:washID`.

En conditions réelles, dans un navigateur : ouvrir l'application, la laisser charger,
passer en mode avion dans les outils de développement, enregistrer un lavage, puis
rétablir le réseau. Le bandeau doit annoncer l'attente, puis disparaître.
