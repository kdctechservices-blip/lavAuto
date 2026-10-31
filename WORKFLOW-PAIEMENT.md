# Encaisser un abonnement : le workflow qui fonctionne

**Date : 20 octobre 2026**

Réponse à la question : *un client veut souscrire après son essai. Comment
suis-je prévenu, comment je valide — et peut-on automatiser pour que je ne
valide pas chaque souscription à la main ?*

---

## La réponse courte

**Oui, on peut automatiser entièrement.** Il faut un agrégateur de paiement
(CinetPay ou PayDunya en Côte d'Ivoire) et un webhook. Compter 2 à 5 jours
ouvrés de vérification d'identité d'entreprise, puis 1 à 2 jours de code.

**Mais ne commencez pas par là.** Tant que vous avez moins de 30 clients,
l'activation manuelle vous coûte moins cher que 3 % de commission, et elle
vous apprend des choses qu'un webhook ne vous dira jamais — pourquoi un
client hésite, ce qu'il attendait, pourquoi il a payé 20 000 au lieu de
35 000.

La bonne décision n'est donc pas *manuel ou automatique*, c'est **construire
de façon que le passage de l'un à l'autre ne soit pas une réécriture**. C'est
ce qui a été fait : les deux chemins se rejoignent sur une seule fonction.

---

## 1. Le workflow, étape par étape

### Ce que voit le client

```
Essai expiré → lecture seule
   │
   ├─ « Choisir un forfait » depuis son tableau de bord
   │     POST /api/v1/subscription/checkout {plan_code, months}
   │     → référence WP-K7M4XP2B, montant 20 000 F
   │
   ├─ Il paie par Orange Money / Wave / MTN / Moov
   │     sur votre numéro marchand, en mettant WP-K7M4XP2B dans le motif
   │
   └─ « J'ai payé » + la référence rendue par son opérateur
         POST /subscription/checkout/WP-K7M4XP2B/declare {transaction_reference}
         → « Activation dès vérification »
```

### Ce que vous voyez, vous

```
Notification         → e-mail à SUPPORT_EMAIL + compteur dans /admin
Votre file           → GET /admin/payment-intents?declared=true
                        station · forfait · montant · référence déclarée
Votre vérification   → vous ouvrez votre appli Wave ou Orange Money
                        vous cherchez la référence du client
Votre validation     → un bouton
                        POST /admin/payment-intents/WP-K7M4XP2B/confirm
```

**Durée réelle de votre intervention : environ 15 secondes.** Vous ne
ressaisissez ni le forfait, ni la durée, ni le montant — l'intention les
porte déjà, donc rien ne peut être saisi de travers.

### Le point qui compte

Une déclaration du client **n'active rien**. C'est une affirmation, pas une
preuve. Le test `déclarer un paiement n'active rien` verrouille ce
comportement. Sans cela, n'importe qui s'offre le forfait Business en
cliquant « j'ai payé ».

---

## 2. Comment vous êtes prévenu

Trois canaux, par ordre de fiabilité :

| Canal | Latence | Fiabilité |
|---|---|---|
| Compteur dans `/admin` | immédiat | totale, c'est la base de données |
| E-mail à `SUPPORT_EMAIL` | secondes | dépend de Resend |
| WhatsApp (lien dans l'app) | immédiat | dépend du client |

**Ne vous reposez pas sur l'e-mail.** Il tombe en spam, Resend a des quotas,
et vous finirez par ne plus les lire. La file dans `/admin` est la source de
vérité : si elle est vide, personne n'attend.

Prenez l'habitude d'ouvrir `/admin` une fois par jour. À 30 clients, cela
représente environ 10 minutes par semaine.

---

## 3. Passer à l'automatique

### Ce qu'il faut savoir avant de choisir

**CinetPay** est la référence en Côte d'Ivoire : basée à Abidjan, elle couvre
Orange Money CI, MTN MoMo CI, Wave CI, Moov Money CI et les cartes en une
seule API, avec une documentation en français [1](https://blog.iambeezy.app/fr/mobile-money-api-integration-orange-money-wave-ci-2026/). Comptez 1,5 à 3,5 % de
commission selon le volume, et un reversement à J+1 à J+3 [2](https://kolonell.com/en/blog/payment-gateway-cote-divoire-wave-orange-mtn-2026).

Pour ouvrir le compte marchand il faut le **RCCM, la pièce d'identité du
gérant, un IBAN ivoirien et un justificatif d'adresse** ; activation en 3 à
7 jours ouvrés [2](https://kolonell.com/en/blog/payment-gateway-cote-divoire-wave-orange-mtn-2026).

**PayDunya** est l'alternative multi-pays si vous visez le Sénégal ou le Mali
ensuite. Mêmes ordres de grandeur.

**Wave Business API** mérite un détour : environ 1 % de commission contre 2 à
3 % pour un agrégateur, API directe avec webhooks signés en HMAC-SHA256, et
c'est gratuit pour une micro-entreprise sous 10 millions FCFA par mois [3](https://kolonell.com/en/blog/payment-gateway-cote-divoire-wave-orange-mtn-2026). Wave
représente environ 40 % des transactions mobile money en CI. L'inconvénient :
Wave seul, donc vos clients Orange devront passer ailleurs.

### Le point dur, à connaître avant de promettre quoi que ce soit

> **Le prélèvement automatique récurrent n'existe quasiment pas en mobile
> money.** Seuls Orange Money CI et MTN MoMo CI le gèrent nativement via leur
> API ; le module d'abonnement de CinetPay est en bêta depuis 2025 [4](https://kolonell.com/en/blog/payment-gateway-cote-divoire-wave-orange-mtn-2026).
> Paystack indique que son canal mobile money ne permet pas les paiements
> récurrents [5](https://support.paystack.com/fr/articles/3416578).

**Conséquence directe sur votre produit :** ne vendez pas un « abonnement qui
se renouvelle tout seul ». Vendez une **période prépayée**, et automatisez le
*rappel*, pas le prélèvement :

```
J-7, J-3, J-1 avant échéance → e-mail avec un lien de paiement prêt
Le client clique, paie en 30 secondes, la période se prolonge
```

C'est fait : `server/reminders.ts` relance désormais aussi les forfaits
payants, à **J-7, J-3, J-1 et une fois l'échéance dépassée**. Le ton diffère
de celui des relances d'essai — on ne cherche pas à convaincre un client qui
paie déjà, on lui évite une interruption.

Un détail qui aurait pu passer inaperçu : les relances d'essai ne partent
qu'une fois dans la vie d'une station, mais celles de renouvellement doivent
repartir **à chaque période**. `activateSubscription()` efface donc les
relances `renewal_%` à chaque activation. Sans cela, un client n'aurait reçu
son avertissement J-7 qu'une seule fois, et tous les renouvellements suivants
seraient passés à la trappe.

### Le flux automatique

```
1. Client → POST /subscription/checkout
2. Serveur → CinetPay /v2/payment {transaction_id: WP-K7M4XP2B, amount, notify_url}
            → renvoie une payment_url
3. Client paie sur la page CinetPay (Orange / Wave / MTN / Moov / carte)
4. CinetPay → POST votre webhook
5. Serveur  → VÉRIFIE le statut en rappelant l'API CinetPay
            → activateSubscription() → intention marquée « paid »
6. Client   → revient sur /subscription/retour, voit son forfait actif
```

### Les cinq pièges qui font échouer les intégrations

**1. Ne jamais croire la redirection du navigateur.** Le retour sur votre
site n'est pas une preuve de paiement : un client malin, ou un simple bug
réseau, ferait croire à un paiement qui n'a pas eu lieu [6](https://www.pirabellabs.com/blog/paiement-en-ligne-mobile-money-afrique-ouest-2026). Seul le webhook,
**revérifié côté serveur**, fait foi.

**2. L'idempotence n'est pas optionnelle.** Le même webhook peut arriver deux
fois par retransmission réseau — chose courante sur les réseaux d'ici [7](https://sentur.net/mobile-money-backend-afrique-ouest/).
C'est la raison du `UNIQUE` sur `payment_intents.reference` et du passage
conditionnel `pending → paid` dans la requête SQL elle-même. Le test
`deux validations simultanées n'activent qu'un seul mois` le prouve.

**3. Le webhook n'arrive pas toujours.** Prévoyez un rattrapage : toutes les
quelques minutes, réinterrogez l'API sur les intentions restées en attente.
Ne laissez jamais un paiement coincé indéfiniment [7](https://sentur.net/mobile-money-backend-afrique-ouest/).

**4. Tout statut inconnu se traite comme « en attente », jamais comme
« réussi »** [7](https://sentur.net/mobile-money-backend-afrique-ouest/). Dans le doute, on réinterroge plutôt que de livrer à
l'aveugle.

**5. Les clés d'API vivent dans les variables d'environnement**, jamais dans
le dépôt Git, jamais côté navigateur [7](https://sentur.net/mobile-money-backend-afrique-ouest/).

---

## 4. Ce qui est déjà en place

| Brique | État |
|---|---|
| Table `payment_intents` (référence UNIQUE, idempotence) | ✅ |
| `POST /subscription/checkout` — ouvrir une intention | ✅ |
| `POST /subscription/checkout/:ref/declare` — déclarer | ✅ |
| `GET /admin/payment-intents?declared=true` — votre file | ✅ |
| `POST /admin/payment-intents/:ref/confirm` — un clic | ✅ |
| `activateSubscription()` — **point de passage unique** | ✅ |
| Écran client (choisir → payer → déclarer) | ✅ |
| File de validation dans `/admin` | ✅ |
| Relances d'échéance J-7 / J-3 / J-1 / dépassée | ✅ |
| Webhook d'agrégateur | ⬜ à brancher quand vous aurez les clés |

### Pourquoi `activateSubscription()` est la pièce importante

Trois déclencheurs sont prévus — validation manuelle, webhook, rattrapage —
et **ils appellent tous la même fonction**. Si chacun écrivait sa propre
requête SQL, le jour où l'un corrige un défaut (les jours payés perdus lors
d'un renouvellement anticipé, le `plan_changed_at` oublié qui supprime le
délai de grâce), les deux autres garderaient le bug.

C'est la panne classique des systèmes d'abonnement : deux chemins
d'activation qui divergent lentement, jusqu'au jour où un client paie et
n'obtient rien.

Brancher CinetPay revient donc à écrire **un adaptateur** qui appelle cette
fonction. Rien d'autre ne bouge.

---

## 5. Configuration

```bash
# .env — mode manuel (défaut, aucun contrat requis)
PAYMENT_PROVIDER=manual
PAYMENT_MERCHANT_NUMBER=+225 07 00 00 00 00
PAYMENT_MERCHANT_NAME=WashPilot CI
SUPPORT_EMAIL=vous@exemple.ci
```

Le numéro marchand et le nom sont affichés au client avec sa référence. Sans
eux, l'écran reste utilisable mais le client ne sait pas où payer.

---

## 6. Ce que je recommande, concrètement

**Maintenant → vos 30 premiers clients :** restez en manuel. Ouvrez `/admin`
chaque matin. Vous apprendrez plus en dix conversations de validation qu'en
six mois de webhooks silencieux.

**Dès le premier client payant :** lancez la demande de compte marchand
CinetPay en parallèle. C'est de l'administratif, cela n'attend pas le code,
et les 3 à 7 jours d'activation passent plus vite si vous les démarrez tôt.

**Avant l'automatisation :** rien à faire, les relances sont en place. Elles
sont ce qui rapporte le plus par heure de travail — un client qui oublie de
renouveler est perdu pour une raison idiote.

**Vers 30-50 clients :** branchez le webhook. À ce stade la commission de 3 %
coûte moins cher que votre temps, et le délai de validation devient un motif
de mécontentement.

**Ne faites jamais :** promettre un prélèvement automatique mensuel. Le rail
mobile money ne le permet pas de façon fiable, et un client qui croit être
prélevé puis se retrouve en lecture seule ne revient pas.
