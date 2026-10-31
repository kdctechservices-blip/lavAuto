# Module Équipes — présences, attribution du travail, rendement

> Lot livré le 21 octobre 2026. Ce document tient lieu de rapport final
> (§17 du cahier des charges) et de référence pour la suite.

## 1. État initial, constaté par l'audit

| Déjà présent | Détail |
| --- | --- |
| `workers` | station, nom, téléphone, quartier, fonction, statut, date d'entrée |
| Écran `/team` | liste des laveurs et des comptes ayant accès |
| Droits | `worker:read / create / update / delete`, déjà dans la matrice |
| `wash_assignments` | table nue : `(wash_id, worker_id)`, sans rôle ni horodatage |
| `audit_logs` | journal réutilisable |
| `recharts` | déjà installé, avec un composant maison `ui/chart.tsx` |

| Absent | Conséquence |
| --- | --- |
| Présences | rien du tout : ni pointage, ni absence, ni horaire |
| Rendement | aucun indicateur, aucune agrégation |
| Rôle dans une affectation | impossible de distinguer qui a mené le travail |

## 2. La collision, et comment elle a été tranchée

Le cahier des charges demande des tâches « affectées, en cours, terminées »,
des heures de début et de fin, un temps moyen de réalisation et des « tâches
en retard ».

**WashPilot ne peut rien en faire, et ce n'est pas un manque : c'est une
décision de produit.** Le lavage s'enregistre *après coup*, comme sur une
caisse enregistreuse. Le code le dit sans ambiguïté :

```sql
INSERT INTO washes(…, status, …) VALUES(…, 'completed', …)
```

Tout lavage naît terminé. Le terme `in_progress` n'apparaît nulle part dans
l'API. Il n'existe donc ni tâche en cours, ni chronomètre, ni durée.

Construire ces indicateurs aurait produit des colonnes vides à perpétuité —
exactement ce que le cahier des charges interdit par ailleurs : « ne présente
pas un temps moyen si les données de début et de fin sont absentes »,
« n'invente pas de résultats de performance ». **Ces indicateurs ne sont donc
pas construits, et l'écran de rendement dit pourquoi**, plutôt que d'afficher
des tirets sans explication.

Ce qui reste — présences, attribution juste, volumes, régularité — représente
l'essentiel de la demande et fonctionne parfaitement sur ce modèle.

## 3. Règles métier retenues

### 3.1. Ne pas déduire une absence d'un silence

`not_recorded` (personne n'a rien saisi) et `absent_declared` (quelqu'un a
constaté une absence) sont deux états distincts, comptés séparément, affichés
différemment. Le premier est un trou dans la saisie, le second une information
sur la personne.

Une absence **déclarée** ne devient jamais **non justifiée** toute seule. La
requalification passe par une correction explicite, motivée et nominative.
L'API refuse même de déclarer directement une absence non justifiée : qualifier
est une décision, pas une saisie.

### 3.2. Pas d'heure de référence inventée

Sans horaire configuré, personne n'est en retard — le champ vaut `null`, pas
zéro. Une station ouvre à 6 h, une autre à 9 h ; un défaut universel
fabriquerait des retards imaginaires dès le premier jour.

Quand un horaire existe, le retard se compte **depuis l'heure prévue**, pas
depuis la fin de la tolérance : la tolérance dit quand on le signale, pas quand
il commence.

Résolution de l'horaire applicable, du plus précis au plus général :
exception du jour → jour de la semaine → tous les jours, et ce qui vise une
personne l'emporte sur ce qui vise la station.

### 3.3. Une donnée absente n'est pas un zéro

Pas d'heure de sortie, donc pas de temps de travail : la réponse est
« inconnu ». Un zéro se moyenne, se classe et se reproche ; un inconnu appelle
une correction.

Le rendement horaire est **suspendu** si un seul pointage de la période est
resté incomplet : un total amputé d'une journée gonflerait mécaniquement le
ratio et flatterait la personne à tort.

Une pause ne se retranche que si elle a été **relevée**. Une pause prévue par
l'horaire mais non pointée ne retire rien.

### 3.4. Un lavage à plusieurs reste un lavage

Trois nombres, trois significations, jamais confondues :

| Nombre | Ce qu'il dit |
| --- | --- |
| Participations | à combien de lavages la personne a pris part |
| Dont responsable | combien elle a menés, si un responsable principal est désigné |
| **Parts** | quelle fraction du travail de la station lui revient |

La part vaut `1000 / nombre de participants`, en millièmes pour éviter les
flottants. Un lavage à trois donne 333 millièmes à chacun, soit 999 : un
millième se perd à l'arrondi, sans conséquence, **parce que le total de la
station ne se calcule jamais en sommant les parts** — il se lit sur la table
des lavages. La part sert à comparer des personnes, pas à produire un total.

Un lavage annulé sort des services effectués : un travail défait ne se
comptabilise pas.

## 4. Fichiers créés ou modifiés

**Créés**

| Fichier | Rôle |
| --- | --- |
| `server/attendance-rules.ts` | cœur de règles pur, sans base ni HTTP |
| `server/attendance.ts` | routes présences, horaires, rendement |
| `src/app/team-attendance/page.tsx` | écran « Équipe du jour » |
| `src/app/team-performance/page.tsx` | écran « Rendement », avec graphiques |
| `tests/attendance-rules.test.ts` | 27 tests unitaires |
| `tests/attendance.test.ts` | 26 tests d'intégration |

**Modifiés** : `server/db.ts` (schéma), `server/permissions.ts`,
`server/entitlements.ts`, `server/api.ts` (responsable principal),
`server/app.ts`, `server/organization-deletion.ts`, `server/backup.ts`,
`src/lib/permissions.tsx`, `src/lib/subscription.tsx`, `src/config/routes.tsx`,
`src/components/app-sidebar.tsx`, `tests/permissions.test.ts`,
`tests/entitlements.test.ts`.

## 5. Changements de schéma

Aucune donnée existante n'est perdue : les deux nouvelles tables sont vides au
départ, et les colonnes ajoutées à `wash_assignments` ont une valeur par défaut
— les affectations déjà enregistrées deviennent des participations.

```
work_schedules       site ou personne, jour de semaine ou date précise,
                     début, fin, pause prévue, tolérance, période de validité
attendance_records   un relevé par personne et par jour (contrainte d'unicité),
                     arrivée, départ, pause relevée, statut, motif,
                     auteur, correcteur, motif de correction
wash_assignments     + assignment_role ('principal' | 'participant')
                     + assigned_at, assigned_by
                     + index unique : un seul responsable principal par lavage
workers              + photo_url
```

Les heures sont en `timestamptz`. La Côte d'Ivoire est à UTC+0 toute l'année,
sans heure d'été : l'heure locale et l'heure UTC coïncident. Une station hors
de ce fuseau demanderait de porter le fuseau sur la station.

## 6. API

| Route | Droit | Objet |
| --- | --- | --- |
| `GET /work-schedules` | `attendance:read` | horaires configurés |
| `POST /work-schedules` | `attendance:correct` | définir un horaire |
| `DELETE /work-schedules/:id` | `attendance:correct` | retirer un horaire |
| `GET /attendance?date=` | `attendance:read` | équipe du jour et son récapitulatif |
| `POST /attendance/check-in` | `attendance:manage` | pointer une arrivée |
| `POST /attendance/check-out` | `attendance:manage` | pointer un départ |
| `POST /attendance/absence` | `attendance:manage` | signaler une absence ou un congé |
| `PATCH /attendance/:id` | `attendance:correct` | corriger, requalifier — tracé |
| `GET /attendance/history` | `attendance:read` | historique filtrable |
| `GET /team-performance` | `attendance:read` | rendement et série journalière |

Toutes exigent la capacité de forfait **`team.tracking`** (Pro et Business).

## 7. Droits et forfait

| | `attendance:read` | `attendance:manage` | `attendance:correct` |
| --- | --- | --- | --- |
| Propriétaire | ✅ | ✅ | ✅ |
| Gérant | ✅ | ✅ | ❌ délégable |
| Caissier | ❌ | ❌ | ❌ |
| Agent de lavage | ❌ | ❌ | ❌ |

Le gérant pointe : il est sur place, c'est lui qui voit qui arrive. La
**correction** reste au propriétaire — définir l'heure prévue et réécrire
l'heure constatée sont le même pouvoir, celui de décider de ce qui servira
peut-être à juger quelqu'un. Les deux sont donc derrière la même permission.

Le rôle est évalué **avant** le forfait : un caissier reçoit 403, jamais une
invitation à payer pour une page qui ne le concernera pas.

**`team.tracking` est une vraie fonction de forfait**, hors de
`WRITE_CAPABILITIES` — une vérification automatique l'empêche d'y entrer par
inadvertance, ce contournement rendant le forfait inopérant.

## 8. Écrans

**Équipe du jour** (`/equipe`) — sélecteur de date, cinq compteurs (effectif,
présents, retards, absences, non pointés), tableau avec pointage d'arrivée et
de départ, déclaration d'absence et correction. Un bandeau apparaît quand aucun
horaire n'est configuré, pour dire que les retards ne sont pas calculés.

**Rendement** (`/rendement`) — période 7 / 30 / 90 jours, quatre compteurs,
**deux graphiques** (lavages par jour ; répartition du travail en parts), puis
le détail par laveur. Un encadré final dit ce que ces chiffres ne disent pas.

## 9. Tests exécutés

| | |
| --- | --- |
| Suite complète | **615 / 615** |
| Ajoutés par ce module | 53 (27 unitaires, 26 d'intégration) |
| Mutations éprouvées | 7, **toutes détectées** |
| `tsc -b` / build / lint | 0 · ✓ · 0 erreur, 21 warnings (inchangé) |

Mutations : forfait non exigé · correction ouverte au gérant · silence traité
comme une absence · chacun compte un lavage entier · pointage incomplet valant
zéro heure · horaire par défaut inventé · lavages annulés comptés.

**Vérifié en conditions réelles** : le même pointage de 10 h 45 est « présent,
aucun retard » sans horaire, puis « en retard de 225 minutes » une fois
l'horaire 7 h – 18 h posé — la preuve qu'aucune heure n'est inventée. Un lavage
à trois donne 999 millièmes au total et jamais trois lavages. Gérant en 403 sur
la correction, caissier en 403 sur la lecture.

## 10. Limites restantes et suite

1. **Pas de reprise ni d'événement qualité.** La table `wash_quality_events`
   n'est pas créée, donc pas de taux de reprise. C'est le prochain lot naturel,
   et il demandera de décider comment une reprise se constate sans workflow de
   lavage.
2. **Pas de durée de réalisation**, pour la raison exposée au §2.
3. **Pas d'export PDF ni Excel** du rendement. L'export CSV existant du projet
   n'a pas été étendu à ce module.
4. **Un relevé par personne et par jour.** Une station à deux vacations
   demanderait d'ajouter une plage à la clé d'unicité.
5. **Pas d'interface pour l'agent de lavage.** Les permissions sont délégables,
   mais aucun écran ne lui est dédié : un laveur ne consulte pas encore ses
   propres affectations.
6. **Incohérence préexistante à arbitrer** : la capacité `team.manage` — qui
   gouverne l'écran `/team` historique — figure dans `WRITE_CAPABILITIES`, où
   le forfait est ignoré. La page tarifaire annonce pourtant les équipes comme
   une fonction Pro. Ce module n'y touche pas pour ne rien retirer aux clients
   Starter actuels, mais la contradiction mérite une décision commerciale.
