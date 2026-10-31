# Grille tarifaire — hypothèses, écarts et marche à suivre

Date : 20 octobre 2026. Monnaie : franc CFA (XOF), par station et par mois.

Ce document contient le **raisonnement commercial**, qui n'a pas sa place sur
la page publique. La page affiche les prix ; ce fichier explique pourquoi.

---

## 1. Les trois forfaits

| Forfait | Positionnement | Prix mensuel | Pour qui |
|---|---|---|---|
| **Starter** | Entrée de gamme | **10 000 FCFA** | Petites stations qui veulent abandonner le cahier de caisse |
| **Pro** | Offre principale | **20 000 FCFA** | Stations à plusieurs laveurs, besoin de contrôle opérationnel |
| **Business** | Stations structurées | **35 000 FCFA** | Grosses stations, propriétaires multi-sites |

Trois forfaits, pas davantage : au-delà, le gérant compare au lieu de choisir.

### Contenu

**Starter** — Enregistrement des lavages et des prestations · Catalogue de
services et prix · Recettes par mode de paiement · Suivi simple des dépenses ·
Rapport quotidien.

**Pro** — Tout Starter, plus : Gestion des équipes et des attributions · Suivi
des sessions de caisse · Suivi des dépenses et des marges opérationnelles ·
Rapports détaillés et exports · Historique des opérations et traçabilité ·
Assistance prioritaire.

**Business** — Tout Pro, plus : Gestion multi-sites selon les limites du
forfait · Vue consolidée du propriétaire · Permissions avancées · Rapports
consolidés · Accompagnement à la mise en service.

---

## 2. Pourquoi ces prix — et pourquoi ce n'est pas sur la page

> Ces prix sont des **hypothèses commerciales à tester** auprès des gérants
> ivoiriens, pas des tarifs validés par le marché. Ils restent dans une gamme
> qui mérite d'être testée pour un SaaS professionnel.
>
> À titre de comparaison indicative, AutoAfrique, fournisseur de logiciels de
> gestion automobile en Afrique de l'Ouest, affiche des forfaits de 15 000 et
> 45 000 FCFA par mois pour des activités voisines. Ce n'est **pas** une
> preuve que les gérants de stations de lavage accepteront ces prix : l'activité
> diffère, la capacité à payer aussi.

Ce paragraphe est resté hors de la page vitrine, pour deux raisons :

1. **Annoncer à un prospect que vos prix sont des hypothèses non validées
   détruit la vente.** Une page tarifaire doit affirmer un prix ; le doute se
   teste par les conversions et les entretiens, pas en l'écrivant au visiteur.
2. **Citer un concurrent nommément sur sa propre page tarifaire se retourne
   contre soi** : cela installe la comparaison sur le terrain du prix, envoie
   le lecteur chercher l'autre offre, et expose à une contestation si le tarif
   cité évolue.

La page porte à la place une phrase sobre et vérifiable : prix en francs CFA,
par station et par mois, sans engagement caché.

**Comment tester réellement les prix** : faire varier le prix affiché par
cohortes, mesurer le taux de passage essai → abonnement, et surtout mener des
entretiens avec une dizaine de gérants. Trois forfaits affichés ne valident
rien à eux seuls.

---

## 3. Essai gratuit

**14 jours, sans carte bancaire**, puis conversion vers un abonnement payant.

Cette durée est dans la fourchette de 7 à 14 jours recommandée, et elle est
**déjà en place** : `TRIAL_DAYS = 14` dans `server/entitlements.ts`, avec
compte à rebours, bandeau d'alerte et bascule en lecture seule à l'échéance
(voir `ESSAI-GRATUIT.md`).

À l'échéance, l'espace reste **consultable** : les données ne sont ni bloquées
ni supprimées, seuls les nouveaux enregistrements exigent un forfait. C'est ce
qui distingue une restriction d'une prise d'otage, et c'est ce qui permet de
reconquérir un gérant parti trois mois.

Le principe « ne pas laisser toutes les fonctionnalités gratuites
indéfiniment » est respecté par la bascule en lecture seule — à une réserve
près, traitée ci-dessous.

---

## 4. ✅ Vitrine et produit alignés (20 octobre 2026)

L'écart documenté ici pendant un mois est résolu. La page publique et le
catalogue applicatif annoncent désormais les mêmes forfaits aux mêmes prix :

| Forfait | Code en base | Prix | Utilisateurs | Laveurs | Stations |
|---------|--------------|------|--------------|---------|----------|
| Starter | `starter` | 10 000 F | 2 | 3 | 1 |
| Pro | `pro` | 20 000 F | 10 | 20 | 1 |
| Business | `business` | 35 000 F | illimité | illimité | illimité |

**Ce que la migration a fait.** `UPDATE plans SET code='starter' WHERE
code='free'`, exécuté **avant** le seed. L'ordre compte : le seed utilise
`ON CONFLICT(code)`, donc insérer « starter » sans renommer d'abord aurait créé
une quatrième ligne en laissant « free » orpheline — avec tous les abonnements
en cours pointant dessus. En renommant, les abonnements suivent sans une seule
réécriture, puisqu'ils référencent `plans.id`, pas le code.

**Le piège désamorcé.** `server/onboarding.ts` décidait d'ouvrir un essai avec
`price_cents === 0`. Aucun forfait n'étant plus gratuit, ce test serait devenu
faux pour tout le monde : plus aucun essai, sans erreur, sans journal, sans
rien. Le déclenchement ne dépend plus du prix — tout forfait choisi ouvre
14 jours d'essai. Un test (`aucun forfait n'est gratuit`) verrouille la
situation pour que personne ne réintroduise la condition.

**Conséquence sur l'essai : on essaie ce que l'on achète.** L'essai ne débloque
plus les options des forfaits supérieurs. Tant qu'un forfait à 0 F existait,
offrir un aperçu de Pro avait du sens. Maintenant que le client choisit et
essaie un forfait payant, lui donner Pro pendant 14 jours rendrait les trois
offres indiscernables au moment exact du choix, et ferait du quinzième jour une
perte de fonctionnalités — le meilleur moyen de faire fuir quelqu'un qui venait
de s'habituer. Pour essayer autre chose, on change de forfait pendant l'essai ;
le décompte, lui, ne repart pas à zéro.

---

## 5. Où vivent les prix

`src/config/pricing.ts` est la **source unique** de la section tarifaire :
noms, positionnements, prix, listes de fonctionnalités et durée d'essai
annoncée. La section `src/app/landing/components/pricing-section.tsx` ne fait
que la mettre en forme — aucun prix n'est écrit en dur dans le JSX.

Depuis l'alignement, **deux fichiers doivent changer ensemble** : ce fichier
pour la vitrine, et le seed `plans` de `server/db.ts` pour le catalogue
applicatif. Le test « les trois forfaits publics existent en base, au même
prix » (`tests/plan-guardrails.test.ts`) échoue si l'un part sans l'autre.

---

## 6. État de couverture des promesses (20 octobre 2026)

Les seize fonctionnalités annoncées sont **toutes construites**, à deux
exceptions documentées, et **réservées au forfait qui les vend** depuis la pose
des garde-fous (section 7).

| Forfait | Promesse | État |
| --- | --- | --- |
| Starter | Enregistrement des lavages et prestations | ✅ |
| Starter | Catalogue de services et prix | ✅ |
| Starter | Recettes par mode de paiement | ✅ |
| Starter | Suivi simple des dépenses | ✅ |
| Starter | Rapport quotidien | ✅ |
| Pro | Gestion des équipes et attributions | ⚠️ différenciée par le plafond (voir 7.2) |
| Pro | Suivi des sessions de caisse | ⚠️ disponible aussi en Starter (voir 7.2) |
| Pro | Suivi des dépenses et marges opérationnelles | ✅ |
| Pro | Stock des consommables : niveaux, seuils, inventaire | ✅ *(ajouté 21/10)* |
| Pro | Déduction automatique du stock à chaque lavage | ✅ *(ajouté 21/10)* |
| Pro | Rapports détaillés et exports | ✅ |
| Pro | Historique des opérations et traçabilité | ✅ *(ajouté)* |
| Pro | Assistance prioritaire | ✅ *(délai de réponse mesuré)* |
| Business | Gestion multi-sites selon les limites du forfait | ✅ *(écran ajouté)* |
| Business | Vue consolidée du propriétaire | ✅ *(ajouté)* |
| Business | Permissions avancées | ✅ |
| Business | Rapports consolidés | ✅ *(ajouté)* |
| Business | Accompagnement à la mise en service | 🤝 service humain |

**« Assistance prioritaire » — arbitré.** Le mot engage désormais **un délai
de première réponse, affiché au client et mesuré**. C'était la seule des trois
options envisagées (délai affiché, canal distinct, tri de file) qui rende la
promesse vérifiable par celui qui la paie.

| Forfait | Première réponse | Garanti |
|---|---|---|
| Starter | 3 jours ouvrés | oui |
| Pro | 1 jour ouvré | oui |
| Business | 4 heures ouvrées | oui |
| Essai, abonnement échu | 5 jours ouvrés | **non** — indicatif, rien n'a été acheté |

Journée d'assistance : **du lundi au vendredi, 8 h – 18 h, heure d'Abidjan**.
Une demande déposée le samedi soir voit son compteur démarrer le lundi à 8 h ;
le client n'est pas pénalisé pour avoir écrit la nuit, et l'éditeur ne
s'engage pas sur des heures où personne ne travaille.

Trois conséquences assumées :

1. **La priorité n'est pas un badge, c'est un ordre de traitement.** La file
   de la console est triée par échéance. Un Business arrivé à midi passe
   devant un Starter arrivé le matin — sans règle de tri particulière,
   l'échéance suffit à produire la priorité.
2. **L'engagement est figé au dépôt de la demande.** Il a été pris sous le
   forfait en vigueur ce jour-là ; si le client rétrograde ensuite, la
   promesse tient.
3. **L'éditeur devient réfutable.** Une demande dépassée est comptée et
   visible. C'est tout l'intérêt de la mesure, et tout son risque : les délais
   retenus sont volontairement prudents, parce qu'une seule personne tient
   l'assistance. Les relever est facile ; les abaisser après les avoir
   annoncés ne l'est pas.

Les valeurs vivent dans `RESPONSE_COMMITMENT_HOURS` (`server/support-sla.ts`),
que la page tarifaire duplique nécessairement côté navigateur.
`tests/pricing-promises.test.ts` interdit la dérive entre les deux — et garde
aussi `PUBLIC_TRIAL_DAYS`, qui portait jusqu'ici un commentaire « doit rester
égal à TRIAL_DAYS » que rien ne vérifiait.

### Les garde-fous, maintenant posés

Les trois décisions annoncées ici ont été prises. Voir la section 7.

---

## 7. Les garde-fous par forfait

### 7.1 La règle de cumul avec le RBAC

Deux verrous, deux questions distinctes, dans cet ordre :

| Verrou | Question | Refus | Code HTTP |
|--------|----------|-------|-----------|
| **Rôle** (`requirePermission`) | Cette **personne** a-t-elle le droit ? | définitif | 403 `forbidden` |
| **Forfait** (`requireCapability`) | Cette **organisation** l'a-t-elle souscrit ? | achetable | 402 `plan_upgrade_required` |

**Le rôle se vérifie en premier, et l'ordre n'est pas interchangeable.**
Proposer de passer au forfait supérieur à un caissier l'enverrait réclamer une
dépense à son patron pour une fonction qu'il n'aurait, de toute façon, pas le
droit d'utiliser. Un refus de rôle est une fin de non-recevoir ; un refus de
forfait est une invitation à acheter, et ne doit s'afficher que lorsque
l'achat débloque réellement quelque chose.

**La réponse à la question posée** — « un gérant en Starter, que voit-il de
l'historique ? » : **rien, exactement comme le propriétaire.** Le verrou de
forfait ne connaît pas les rôles. `audit:read` dit « ce rôle peut consulter
l'historique » ; le forfait Starter dit « cette organisation n'a pas souscrit
la traçabilité ». Les deux reçoivent le même écran d'argumentaire, parce que
ce n'est pas une question de personne. La différence entre eux n'apparaît
qu'une fois l'organisation passée en Pro : propriétaire et gérant y accèdent,
le caissier non — et le caissier, lui, n'a jamais vu passer la moindre
proposition d'achat.

Côté interface, `useAccess(permission, capability)` applique la même priorité,
et le composant `PlanGate` distingue visuellement les deux refus : bouclier et
aucun bouton pour le rôle, étincelle et « Voir les forfaits » pour le forfait.

### 7.2 Où chaque fonction est bloquée

| Fonction | Forfait minimum | Point de blocage serveur |
|---|---|---|
| Historique des opérations | Pro | `requireCapability("audit.read")` sur `/audit-logs` |
| Suivi du stock | Pro | `requireCapability("stock.manage")` sur les **11** routes de stock |
| Regroupement semaine / mois | Pro | 402 dans `/reports/summary` si `granularity ≠ day` |
| Export des rapports | Pro | `reports.export` (construit côté client, gardé à l'affichage) |
| Vue et rapports consolidés | Business | `by_site` vide hors `reports.consolidated` |
| Plusieurs stations | Business | `max_sites` via `assertSiteCapacity` |

**Ce qui n'est délibérément pas gardé**, bien que la page publique le range
sous Pro :

- **Les sessions de caisse.** Un paiement en espèces et une dépense en espèces
  exigent tous deux une session ouverte. Gardée au niveau Pro, la caisse
  rendrait un client Starter incapable d'encaisser un billet — l'opération la
  plus courante d'une station de lavage à Abidjan. On ne casse pas la boucle
  centrale du produit pour faire respecter une ligne d'argumentaire.
- **La gestion des équipes.** Un lavage s'attribue à des laveurs ; sans
  laveurs, la fiche de lavage Starter perd son intérêt. La différenciation
  passe par le **plafond**, déjà appliqué : 3 laveurs en Starter, 20 en Pro,
  illimité en Business. C'est la limite qui se vend, pas la fonction.

**Le cas du stock, arbitré le 21 octobre 2026.** La décision est « le stock
bascule en Pro ». Elle soulevait une difficulté : la déduction automatique est
déclenchée par l'**enregistrement d'un lavage**, qui est précisément ce que
Starter vend. Trois règles la résolvent :

1. **Les onze routes de stock répondent 402** sur Starter. Le verrou est au
   serveur ; masquer l'entrée de menu n'aurait été qu'un décor.
2. **Enregistrer un lavage reste ouvert à Starter**, et ne déduit rien. On
   n'écrit pas dans un stock que le client ne peut ni consulter ni corriger :
   une station rétrogradée retrouve son stock **figé** là où il était, à
   inventorier, plutôt que silencieusement faussé.
3. **La contrepassation à l'annulation n'est pas soumise au forfait.** S'il
   n'y a rien à contrepasser, elle ne fait rien ; s'il y a quelque chose,
   c'est qu'une consommation a bien eu lieu, et la laisser en place
   fausserait un stock déjà écrit.

Rien n'est supprimé à la rétrogradation : produits, mouvements et recettes
restent en base et réapparaissent intacts dès le retour en Pro.

Ces deux lignes de la grille publique sont donc **tenues en partie seulement**.
Recommandation : reformuler la ligne Pro « Suivi des sessions de caisse » en
quelque chose qui décrit un vrai écart — par exemple le rapprochement de caisse
détaillé ou l'historique des écarts, qui relèvent bien de la traçabilité Pro.
La copie publique n'a pas été modifiée sans arbitrage de votre part.

### 7.3 Que devient une organisation qui rétrograde

**Principe non négociable : aucune donnée saisie n'est jamais supprimée ni
masquée par un changement de forfait.** La lecture et l'export restent ouverts,
indéfiniment, sur la totalité de l'historique. Couper l'accès à des données
déjà saisies est le moyen le plus sûr de perdre un client — et, pour un gérant
qui doit justifier une recette, une faute.

Ce qui change, c'est la capacité à en produire de nouvelles :

1. **Création bloquée immédiatement** (409 `plan_site_limit`). Pas de délai de
   grâce ici : on ne laisse personne aggraver un dépassement.
2. **14 jours de grâce sur l'existant.** Toutes les stations continuent de
   fonctionner normalement. Un bandeau annonce l'échéance et ce qui va se
   passer. Le propriétaire choisit lesquelles garder actives.
3. **Au terme du délai**, les stations excédentaires passent en lecture seule
   (402 `site_over_plan_limit` sur lavage, caisse et dépense). Leur historique
   reste entièrement lisible et exportable.

**Quelles stations restent actives ?** Les plus anciennes, par date de
création. Le critère devait être déterministe et explicable : « la station
historique reste » se comprend sans un mot d'explication, « celle dont
l'identifiant est le plus petit » ne se comprend jamais. Le propriétaire
recompose son choix à tout moment en désactivant une station pour en réactiver
une autre — et la réactivation repasse par le plafond, sinon le détour
désactiver/réactiver contournerait la limite.

**Remonter de forfait ne demande aucune manipulation** : tout se rouvre à
l'instant. Le client vient de payer, il doit retrouver son outil intact.
