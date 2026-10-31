# Le reçu de lavage, format 80 mm

**Date : 21 octobre 2026**

Réponse à la demande : *créer un système de reçu pour le paiement d'un service
de lavage.*

---

## Avant tout le reste : ce document n'est pas un reçu normalisé

C'est le point le plus important de cette page, et il conditionne tout le
reste du travail.

Depuis décembre 2025, la Côte d'Ivoire impose la **Facture Normalisée
Électronique (FNE)** et, pour les ventes au comptant à un particulier, le
**Reçu Normalisé Électronique (RNE)**. L'obligation ne dépend pas de
l'assujettissement à la TVA : elle vise **toutes les entreprises, quel que
soit leur régime fiscal**, du réel normal au régime de l'entreprenant. La DGI
a lancé des opérations de contrôle sur l'ensemble du territoire **à partir du
1ᵉʳ septembre 2026**.

Un RNE valide porte trois marques, et ces trois marques ne peuvent venir que
de la plateforme de la DGI :

1. un **QR code de certification**, vérifiable depuis n'importe quel
   téléphone ;
2. le **visuel officiel FNE** ;
3. un **numéro fiscal unique**, attribué en temps réel par la DGI au moment où
   elle valide la transaction.

**Aucune de ces trois marques ne peut être fabriquée par WashPilot.** Le
modèle est dit « clearance » : la DGI valide *avant* que le document soit
remis au client. Sans appel à leur plateforme, il n'y a pas de RNE, point.

Les lavages auto **ne sont pas** dans la liste des activités dispensées
(eau/électricité/téléphone, pharmacies, banques et assurances, compagnies
aériennes, stations-service *pour le carburant uniquement*, Poste de Côte
d'Ivoire, pétroliers sous contrat de partage).

### Ce que cela a changé dans le code

Le reçu produit ici est un **justificatif commercial** : la preuve, remise au
client, de ce qu'il a commandé et de ce qu'il a payé. Il lève une
contestation au comptoir et justifie une entrée de caisse en interne.

Et il **n'imite aucune mention fiscale**. Pas de QR code, pas de « TVA », pas
de numéro présenté comme normalisé, pas le mot « facture ». Un papier qui
ressemblerait à un RNE sans en être un exposerait la station à l'amende
qu'elle croit éviter — de l'ordre de 10 000 FCFA par document non conforme
pour une microentreprise (plafond 500 000 FCFA par contrôle), 30 000 FCFA sous
le régime du réel simplifié (plafond 3 000 000 FCFA).

Un test échoue si quelqu'un ajoute plus tard une de ces mentions :

```
test("le reçu n'imite aucune mention fiscale")
  → interdit : tva, fne, normalis, dgi, qr, facture, cachet fiscal, ttc
```

**Ce qui resterait à faire** pour une vraie conformité : s'inscrire sur
`fne.dgi.gouv.ci`, obtenir les accès marchands, et appeler leur API au moment
de l'encaissement pour recevoir le numéro fiscal et le QR code. C'est un
chantier à part entière, qui engage la station et non l'éditeur. Noté dans
« Prochaines marches ».

À noter pour le cas fréquent : sous un régime forfaitaire, l'obligation ne
s'applique qu'aux achats **d'au moins 5 000 FCFA**. Beaucoup de lavages
simples passent sous ce seuil — mais pas une formule complète.

Sources : [fne.dgi.gouv.ci](https://www.fne.dgi.gouv.ci/) ·
[communiqué de contrôle, août 2026](https://www.koaci.com/article/2026/08/26/cote-divoire/economie/cote-divoire-operation-de-controle-de-la-facturation-normalisee-electronique-a-partir-du-1er-septembre-voici-les-entreprises-visees_199883.html) ·
[guide pratique PME 2026](https://cleoerp.com/fr/blog/fne-cote-divoire-guide-pratique-pme-2026)

---

## Les trois arbitrages

### 1. Largeur : 80 mm

Le format de caisse classique. 80 mm de papier donnent **72 mm imprimables**
sur la quasi-totalité des modèles — le reste est la marge mécanique du
chariot, et écrire dedans fait disparaître le bord droit des montants.

En police A, cela fait **48 caractères par ligne**. C'est la largeur sur
laquelle le rendu texte est aligné, et celle que les tests vérifient.

### 2. Portée : le lavage entier, pas le versement

Un lavage peut être réglé en plusieurs fois. Le reçu couvre le lavage
complet : toutes les prestations, tous les règlements déjà reçus, et le solde
restant s'il y en a un.

Il y a donc **un reçu par lavage**, et non un par encaissement. Quand le
lavage n'est pas soldé, le papier porte une ligne `RESTE A PAYER` : le client
repart avec un document exact plutôt qu'avec rien.

### 3. Réimpression : DUPLICATA, et c'est tracé

La première émission est l'original. Les suivantes portent la mention
`*** DUPLICATA ***`, leur numéro de copie et la date de réimpression.

La raison n'est pas cosmétique : **un reçu est une preuve de paiement**. Deux
papiers indiscernables pour un seul versement permettent de justifier deux
fois la même somme — au client qui conteste, au gérant qui compte la caisse,
ou à l'inverse de couvrir un retrait. La mention rend la chose visible, la
trace la rend vérifiable.

Chaque émission écrit une ligne dans `audit_logs`, et les deux gestes sont
distincts :

| Geste | Action journalisée |
|---|---|
| Première impression | `receipt.issued` |
| Toute réimpression | `receipt.reprinted` |

`GET /washes/:id/receipt/history` répond à « combien de papiers circulent pour
ce lavage, et qui les a sortis ».

---

## Ouvrir le reçu, c'est l'émettre

La route est un **POST**, pas un GET. C'est délibéré.

Un aperçu gratuit en lecture permettrait d'ouvrir le reçu autant de fois qu'on
veut, d'imprimer depuis le navigateur à chaque fois, et le compteur de copies
ne bougerait pas. La mention DUPLICATA n'aurait alors plus aucun sens :
l'original pourrait être tiré à dix exemplaires.

Le prix de cette rigueur est modeste : consulter un reçu pour vérifier un
montant consomme un numéro de copie. C'est assumé — l'information « ce lavage
a donné lieu à 4 papiers » vaut plus que le confort d'un aperçu gratuit.

---

## L'impression

Par le **navigateur**, via `window.print()` et une feuille `@page`.

```css
@page { size: 80mm auto; margin: 3mm; }
```

Pourquoi pas un pilote ESC/POS : il imposerait une bibliothèque
supplémentaire — interdite par la règle « aucune nouvelle dépendance » — et un
pont local à installer sur chaque poste. La voie navigateur sort correctement
d'une imprimante de comptoir USB, d'un modèle Bluetooth sous Android et d'un
export PDF, sans rien installer.

Deux détails qui font la différence sur une thermique :

- **`visibility: hidden` plutôt que `display: none`** pour masquer le reste de
  la page. Le reçu vit dans un portail de dialogue ; `display:none` casserait
  la mise en page de ses ancêtres, alors que `visibility` conserve l'arbre et
  n'imprime rien. Le reçu est ensuite sorti du flux et collé en haut à gauche.
- **Tout en noir, aucun aplat.** Une imprimante thermique ne connaît que le
  noir : un fond gris sort en bavure et mange le papier.

Pour les pilotes qui n'acceptent que du texte brut, la réponse de l'API porte
aussi un champ `text` : le même reçu rendu sur 48 colonnes, prêt à être envoyé
tel quel. Le bouton « Copier le texte » le met dans le presse-papiers.

---

## Qui peut imprimer

Permission **`payment:read`**.

Remettre au client la preuve de ce qu'il a payé appartient à qui voit les
encaissements : le caissier, le gérant, le propriétaire. Un **agent de lavage**
ne voit pas les paiements et n'imprime pas — il n'a pas l'information
nécessaire pour répondre à une contestation sur un montant.

Un **lavage annulé ne donne aucun reçu** (409 `wash_cancelled`). Le papier
prouverait un paiement pour une prestation qui n'a pas eu lieu. Le bouton
disparaît aussi de l'écran, pour ne pas proposer un geste qui sera refusé.

---

## Les routes

```
POST /api/v1/washes/:id/receipt          → 201 { receipt, text }
GET  /api/v1/washes/:id/receipt/history  → 200 { issues[] }
```

Codes de refus : `404 wash_not_found` (y compris pour le lavage d'une autre
station — introuvable, pas interdit), `409 wash_cancelled`,
`403 forbidden`, `400 invalid_id`.

---

## Ce que le reçu ne fait pas

- **Il n'est pas un RNE.** Voir le premier chapitre : c'est la limite
  principale, et elle n'est pas contournable depuis le produit.
- **Pas de TVA.** Le produit ne modélise aucune taxe : les prix sont des
  montants uniques. Afficher un taux supposerait de connaître le régime fiscal
  de la station, que WashPilot ne lui demande pas.
- **Pas de logo imprimé.** Une thermique rend mal les aplats, et le nom de la
  station en gras est plus lisible qu'un dessin baveux.
- **Pas d'envoi au client.** Ni SMS, ni WhatsApp, ni e-mail. Le reçu est un
  papier qu'on tend. Un envoi supposerait de collecter le numéro du client à
  chaque lavage, ce que le comptoir n'a pas le temps de faire.
- **Pas de reçu par encaissement.** C'est l'arbitrage retenu : un reçu par
  lavage. Un client qui verse un acompte puis le solde repart avec deux
  papiers portant le même numéro, le second marqué DUPLICATA.

---

## Vérification

```bash
# Suite complète (377 tests)
NODE_ENV=test npm test

# Ciblé
NODE_ENV=test npx tsx --test tests/receipt.test.ts   # 18 tests
```

Les colonnes sont vérifiées **au caractère près** : chaque ligne de montant
doit faire exactement 48 caractères, et un libellé trop long doit être tronqué
sans jamais pousser le montant hors du papier. C'est le genre de défaut qui ne
se voit pas en relisant du code et saute aux yeux sur le rouleau.

**Sept mutations, toutes détectées** : supprimer la troncature des libellés
longs, ne plus signaler les duplicata, figer le numéro de copie à 1, émettre
un reçu pour un lavage annulé, compter les paiements remboursés comme payés,
ajouter une mention fiscale inventée, et élargir la permission à `wash:read`
(ce qui aurait laissé les agents de lavage imprimer).

Parcours manuel, serveur lancé :

```bash
# Original, puis réimpression
curl -s -X POST localhost:3000/api/v1/washes/$W/receipt -H "Authorization: Bearer $T"
curl -s -X POST localhost:3000/api/v1/washes/$W/receipt -H "Authorization: Bearer $T"

# Combien de papiers circulent
curl -s localhost:3000/api/v1/washes/$W/receipt/history -H "Authorization: Bearer $T"
```

---

## Prochaines marches

1. **S'inscrire à la FNE et émettre de vrais RNE.** Le seul moyen de rendre le
   reçu opposable à l'administration. Demande des accès marchands DGI et un
   appel à leur plateforme au moment de l'encaissement, avec un mode dégradé
   quand elle ne répond pas (le client ne doit pas attendre au comptoir).
2. **Choix 58 mm / 80 mm en réglage de station**, pour les imprimantes
   Bluetooth portables. Le rendu texte est déjà paramétré par une largeur ; il
   reste à exposer le choix et à adapter la feuille d'impression.
3. **Logo de la station**, si un jour les tests sur matériel montrent un rendu
   acceptable.
