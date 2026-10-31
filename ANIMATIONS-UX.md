# Effets visuels & animations — plan d'amélioration UX

**Projet :** WashPilot CI (LAVAUTO) · **Date :** 20 octobre 2026
**Stack motion disponible (déjà installée) :** `framer-motion` 14.3 · `tw-animate-css` 1.4 · Tailwind 4.3 · Base UI 1.8 (animations `data-*`) · Recharts 3.10 · React Router 7.18 (View Transitions natives)

> ## ✅ Statut : les 3 lots sont implémentés
>
> Tout ce qui suit a été **appliqué au code** (branche `arena/bddec9ba-lavauto`), sans aucune nouvelle dépendance npm.
> Détail des fichiers créés/modifiés en **[§12 Journal d'implémentation](#12-journal-dimplémentation)**.
> Vérifications : `tsc -b` ✅ 0 erreur · `npm test` ✅ 35/35 · `npm run build` ✅ · `npm run lint` ✅ inchangé (1 erreur + 8 avertissements pré-existants).

> **TL;DR — les 5 meilleurs rapports impact/effort**
> 1. **Squelettes de chargement** sur Lavages / Caisse / Dépenses / Équipe (aujourd'hui : « Chargement… » en texte brut).
> 2. **Compteurs animés** sur les montants FCFA des cartes KPI (le chiffre « monte » en 600 ms).
> 3. **Apparition échelonnée des lignes** de tableau (CSS pur, 0 JS, 0 Ko).
> 4. **Transitions de page** via l'API View Transitions (React Router le gère nativement) — dont un **effet de continuité** entre la ligne d'un lavage et sa fiche détail.
> 5. **Brancher `use-circular-transition.ts`** sur le bouton thème : le code est déjà écrit… et **jamais importé**.

---

## 1. État des lieux (mesuré dans le dépôt)

| Constat | Détail |
|---|---|
| `framer-motion` utilisé dans **7 fichiers** | 5 sur la landing (`hero`, `gallery`, `navbar`, `product-demo`, `landing-motion`), `auth-page-layout`, `dashboard-metrics` |
| **0 animation sur les pages métier** | `cash-drawer`, `expenses`, `reports`, `onboarding` : aucune occurrence de `motion.` ni `animate-` |
| `animate-spin` ×22, `animate-pulse` ×7 | Les loaders existent, mais ce sont surtout des **spinners**, pas des squelettes |
| `Skeleton` présent sur **4 écrans seulement** | `dashboard`, `reports`, 3 étapes d'`onboarding`, `sidebar` |
| Chargements en texte brut | « Chargement du catalogue… », « Chargement de la caisse… », « Chargement de l'équipe… », « Chargement… » |
| Barre de progression de route | ✅ Déjà en place (`.route-progress` dans `index.css` + `root-layout.tsx`), avec garde `prefers-reduced-motion` |
| Toasts | ✅ Base UI : empilement, swipe, `cubic-bezier(0.22,1,0.36,1)` — **déjà excellent**, ne pas y toucher |
| `prefers-reduced-motion` | Partiel : 2 règles CSS + `useReducedMotion()` sur la landing. **Pas de garde globale** |
| Code mort | `src/hooks/use-circular-transition.ts` (transition circulaire de thème) **n'est importé nulle part** |
| Poids | Le chunk `AreaChart` pèse **375 Ko** (107 Ko gzip) — toute animation lourde sur les graphiques doit rester sobre |

**Diagnostic :** la vitrine (landing + auth) est soignée, **l'application métier est statique**. C'est exactement l'inverse de ce qu'il faudrait : c'est dans l'app qu'un gérant passe 8 h par jour, et c'est là que l'absence de feedback visuel crée du doute (« mon encaissement est-il parti ? »).

---

## 2. Principes directeurs (contexte WashPilot)

**Barème de durées** — rester dans ces bornes, sinon l'app paraît lente :

| Interaction | Durée | Courbe |
|---|---|---|
| Survol, focus, pression | 100–150 ms | `ease-out` |
| Apparition d'un élément, accordéon | 200–300 ms | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Transition de page / modale | 300–400 ms | `ease-out` (entrée) / `ease-in` (sortie, plus rapide) |
| Compteur de montant | 600–800 ms | `easeOutExpo` |
| Confettis / célébration | ≤ 1 500 ms, **une seule fois** | — |

**Règles non négociables pour une app de caisse :**
- ❌ **Jamais** animer un montant **pendant la saisie** ou au moment du contrôle de caisse : le chiffre doit être lisible instantanément. Les compteurs animés sont réservés aux **tableaux de bord en lecture seule**.
- ❌ Jamais de spinner plein écran > 300 ms sans squelette : le gérant doit voir **la structure** de l'écran arriver.
- ✅ N'animer que `transform` et `opacity` (compositées GPU). Jamais `width`, `height`, `top`, `box-shadow` sur des listes.
- ✅ Contexte ivoirien : beaucoup d'Android d'entrée de gamme en 3G/4G → budget **60 fps sur un Moto G**, pas sur un MacBook.
- ✅ Toute animation doit avoir un **sens fonctionnel** (origine/destination, succès/échec, attente) — jamais décorative dans l'app.

---

## 3. Lot 1 — Performance perçue (impact maximal, risque nul)

### 1.1 Squelettes de chargement sur les 4 pages métier

Remplacer les textes « Chargement… » par la **forme** du contenu attendu. C'est le gain de perception le plus fort : l'écran paraît ~30 % plus rapide à charger sans changer une ligne de backend.

Nouveau composant partagé `src/components/ui/table-skeleton.tsx` :

```tsx
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border" role="status" aria-busy="true" aria-label="Chargement des données">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b px-4 py-3 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className="h-4 flex-1"
              style={{ animationDelay: `${(r * cols + c) * 40}ms`, maxWidth: c === 0 ? "none" : "7rem" }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
```

À brancher dans : `washes/page.tsx` (l. 499), `cash-drawer/page.tsx` (l. 265), `expenses/page.tsx` (l. 402), `team/page.tsx` (l. 276 et 338).

### 1.2 Garde globale `prefers-reduced-motion`

Un seul endroit à modifier, `src/App.tsx` :

```tsx
import { MotionConfig } from "framer-motion"

<MotionConfig reducedMotion="user">
  <RouterProvider router={router} />
</MotionConfig>
```

Et dans `index.css`, la règle de sécurité qui couvre **toutes** les animations CSS futures :

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 1.3 Compteurs animés sur les montants (lecture seule)

`src/hooks/use-count-up.ts` :

```ts
export function useCountUp(target: number, duration = 700) {
  const reduce = useReducedMotion()
  const [value, setValue] = useState(target)
  const previous = useRef(target)

  useEffect(() => {
    if (reduce) { setValue(target); previous.current = target; return }
    const from = previous.current
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 4)          // easeOutQuart
      setValue(Math.round(from + (target - from) * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
      else previous.current = target
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, duration, reduce])

  return value
}
```

Cibles : les 4 `SummaryCard` du dashboard, les cartes de `reports/page.tsx`, le solde théorique de la caisse (hors mode clôture). Ajouter `tabular-nums` sur ces chiffres pour éviter le tremblement de largeur :

```tsx
<p className="mt-3 text-2xl font-bold tracking-tight tabular-nums">{formatFCFA(animated)}</p>
```

### 1.4 Apparition échelonnée des lignes de tableau (CSS pur, 0 Ko)

Dans `index.css` :

```css
@keyframes row-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
.row-in {
  animation: row-in 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: calc(var(--row, 0) * 28ms);
}
```

Usage (plafonner le délai à ~10 lignes pour que la 50ᵉ n'attende pas) :

```tsx
<TableRow className="row-in" style={{ "--row": Math.min(index, 10) } as React.CSSProperties}>
```

### 1.5 Transitions de page natives (React Router 7)

React Router 7.18 expose `viewTransition` : aucun paquet à installer.

```tsx
<Link to="/washes" viewTransition>Nouveau lavage</Link>
// ou : navigate("/dashboard", { viewTransition: true })
```

```css
::view-transition-old(root) { animation: fade-out 120ms ease-in both; }
::view-transition-new(root) { animation: fade-in 200ms ease-out both; }
```

**Effet de continuité (le plus spectaculaire)** : donner le même `view-transition-name` à la ligne du lavage dans la liste et au titre de sa fiche → la ligne « se déplie » en page de détail. Avec `useViewTransitionState("/washes/" + wash.id)` :

```tsx
const isTransitioning = useViewTransitionState(`/washes/${wash.id}`)
<TableRow style={{ viewTransitionName: isTransitioning ? "wash-card" : undefined }}>
```

Dégradation propre : Firefox ignore l'API, la navigation reste instantanée.

### 1.6 Bouton : attente → succès

Aujourd'hui `AuthSubmitButton` affiche « Patientez… » + spinner. Ajouter un **troisième état** : une coche qui apparaît 800 ms avant la fermeture de la modale. Cela supprime le doute sur les actions d'argent (encaissement, clôture de caisse).

```tsx
{state === "success"
  ? <CheckCircle2 className="size-4 animate-in zoom-in-50 duration-300" />
  : state === "pending"
    ? <LoaderCircle className="size-4 animate-spin" />
    : <ArrowRight className="size-4" />}
```

### 1.7 Brancher la transition de thème déjà codée

`src/hooks/use-circular-transition.ts` implémente un révélateur circulaire (View Transitions + variables `--x/--y`) mais **n'est utilisé nulle part**. Il suffit de l'appeler depuis le bouton de thème et d'ajouter le CSS correspondant :

```css
::view-transition-new(root) { clip-path: circle(0% at var(--x) var(--y)); animation: reveal 450ms ease-out forwards; }
@keyframes reveal { to { clip-path: circle(150% at var(--x) var(--y)); } }
```

---

## 4. Lot 2 — Lisibilité des flux métier

### 2.1 Assistant d'onboarding (5 étapes)
- **Glissement horizontal directionnel** entre les étapes (`AnimatePresence mode="wait"`, `x: +24 / -24` selon avant/arrière) : l'utilisateur comprend où il va.
- **Barre de progression** qui se remplit (`transform: scaleX()`, jamais `width`).
- **Pastilles d'étape** : coche qui « pop » (`zoom-in-50`) quand une étape est validée.
- **Célébration finale** à la confirmation : confettis légers (≈ 40 particules, `transform` uniquement, 1,2 s, une seule fois, désactivés en reduced-motion) — c'est le moment où le gérant a terminé sa configuration, il mérite un marqueur émotionnel.

### 2.2 Caisse (`cash-drawer`)
- Badge « Caisse ouverte » : **pulsation très douce** (2 s, opacité 0,6 → 1) pour signaler l'état actif en périphérie de vision.
- Solde théorique : compteur animé à chaque mouvement enregistré.
- Clôture : l'écart apparaît avec une transition de **couleur** (vert si 0, ambre si faible, rouge si élevé) + un léger `shake` (6 px, 250 ms) si l'écart dépasse un seuil. Jamais pendant la saisie du montant compté.

### 2.3 Lavages & dépenses
- **Flash de la ligne créée** : la nouvelle entrée arrive surlignée puis se fond en 1,2 s — le gérant voit immédiatement *ce qui vient d'être ajouté*.
  ```css
  @keyframes row-flash {
    from { background: color-mix(in oklch, var(--color-primary) 16%, transparent); }
    to   { background: transparent; }
  }
  ```
- **Suppression** : la ligne se replie (`height` → `grid-template-rows: 0fr`, technique Tailwind 4) au lieu de disparaître brutalement.
- **UI optimiste** : afficher la ligne en opacité 60 % + bordure pointillée pendant l'appel réseau, puis la « solidifier » au succès (ou la retirer avec un toast d'erreur). Combiné à l'idempotence déjà en place côté serveur, c'est sans risque de double encaissement.

### 2.4 Modales
Base UI expose `data-starting-style` / `data-ending-style` : ajouter un **fond flouté progressif** (`backdrop-blur-0` → `backdrop-blur-sm`) et une entrée `scale(0.96) → 1`. Sortie 30 % plus rapide que l'entrée (règle d'asymétrie).

### 2.5 Graphiques (Recharts)
- Harmoniser `animationDuration={600}` et `animationEasing="ease-out"` sur tous les graphiques (dashboard + rapports).
- Curseur de survol personnalisé + ligne de référence animée.
- Apparition **une seule fois** (`isAnimationActive` désactivé au re-render de filtre) : un graphique qui rejoue son animation à chaque changement de période devient fatigant.

### 2.6 États vides
Les écrans vides sont aujourd'hui un simple cadre pointillé. Leur ajouter une illustration légère (SVG inline) avec un flottement de 3 s (`translateY ±4 px`) et un **bouton d'action principal** : l'état vide devient un guide, pas un cul-de-sac.

### 2.7 Sidebar : indicateur actif glissant
Avec `layoutId` de framer-motion, la pastille de l'élément actif **glisse** d'un item à l'autre au lieu de clignoter :

```tsx
{isActive && <motion.span layoutId="sidebar-active" className="absolute inset-0 -z-10 rounded-lg bg-sidebar-accent" transition={{ type: "spring", stiffness: 380, damping: 32 }} />}
```

---

## 5. Lot 3 — Signature de marque (vitrine)

| Effet | Où | Note |
|---|---|---|
| Parallax léger du héros (≤ 40 px, `useScroll` + `useTransform`) | `hero-section.tsx` | Désactiver sous 768 px |
| Dégradé animé « eau/mousse » en fond de section | `cta-section`, `hero` | GPU only (`background-position`), 12 s |
| Cartes tarifs avec inclinaison 3D au survol (≤ 6°) | `pricing-section.tsx` | `transform-style: preserve-3d` |
| Compteurs de preuve sociale au scroll | `problem-section` / `features` | Réutilise `useCountUp` |
| Barre de navigation qui se compacte au scroll | `navbar.tsx` | `height` → préférer `scale` + `padding` |
| Mini-sparkline au survol des cartes KPI | `dashboard` | Données `daily` déjà disponibles |
| Écran de démarrage logo « bulle » ≤ 400 ms | `RootFallback` | Ne jamais dépasser 400 ms |

---

## 6. Récapitulatif effort / impact

| # | Effet | Impact UX | Effort | Fichiers |
|---|---|---|---|---|
| 1.1 | Squelettes 4 pages | 🔥🔥🔥 | S | 4 pages + 1 composant |
| 1.2 | Garde reduced-motion globale | 🔥🔥 (a11y) | XS | `App.tsx`, `index.css` |
| 1.3 | Compteurs de montants | 🔥🔥🔥 | S | 1 hook + 3 écrans |
| 1.4 | Lignes échelonnées | 🔥🔥 | XS | `index.css` + 4 tableaux |
| 1.5 | Transitions de page + continuité lavage | 🔥🔥🔥 | M | `routes`, `washes`, CSS |
| 1.6 | Bouton attente → succès | 🔥🔥 | S | `auth-form-elements`, `button` |
| 1.7 | Transition de thème circulaire | 🔥 | XS | brancher le hook existant |
| 2.1 | Onboarding animé + célébration | 🔥🔥🔥 | M | `onboarding/*` |
| 2.2 | Caisse : pulsation, compteur, écart | 🔥🔥 | M | `cash-drawer` |
| 2.3 | Flash / collapse / UI optimiste | 🔥🔥🔥 | M-L | `washes`, `expenses` |
| 2.4 | Modales floutées | 🔥 | XS | `ui/dialog` |
| 2.5 | Graphiques harmonisés | 🔥 | S | `dashboard`, `reports` |
| 2.6 | États vides illustrés | 🔥🔥 | M | transverse |
| 2.7 | Sidebar glissante | 🔥 | S | `app-sidebar` |
| 3.x | Vitrine | 🔥 (conversion) | M-L | `landing/*` |

---

## 7. Accessibilité — contraintes à respecter

- `prefers-reduced-motion` : couvert globalement par 1.2 ; **tester réellement** (DevTools → Rendering → Emulate CSS media).
- Aucune animation clignotante > 3 Hz (risque photosensible).
- Les boucles infinies (pulsation, dégradé) doivent être **subtiles** et jamais dans la zone de lecture active.
- Les zones qui se remplissent dynamiquement portent `aria-busy="true"` pendant le chargement et `role="status"` pour l'annonce vocale.
- Le focus clavier ne doit jamais être « perdu » pendant une transition de page (React Router gère le focus root ; vérifier après ajout des View Transitions).

## 8. Performance — garde-fous

- Uniquement `transform` / `opacity`. Vérifier dans DevTools → Layers qu'aucune animation ne déclenche de *layout*.
- `will-change` seulement pendant l'animation, jamais en permanence.
- Listes longues : `content-visibility: auto` + plafonner le `stagger` à 10 éléments.
- Le chunk `AreaChart` fait déjà 375 Ko : garder les graphiques en `lazy` (c'est le cas) et ne pas ajouter de librairie d'animation supplémentaire — `framer-motion` et `tw-animate-css` suffisent à tout ce qui précède.
- **Aucune dépendance npm nouvelle n'est nécessaire** pour les lots 1 et 2 (y compris les confettis, faisables en CSS).

## 9. Anti-patterns à éviter ici

| ❌ À ne pas faire | Pourquoi |
|---|---|
| Animer les montants pendant la saisie / le comptage de caisse | Erreurs de lecture sur de l'argent réel |
| Spinner plein écran | Masque la structure, paraît plus lent qu'un squelette |
| Confettis à chaque enregistrement | Perte de sens, fatigue |
| Parallax sur mobile | Saccades sur Android d'entrée de gamme |
| Transitions > 400 ms sur des actions répétées (créer un lavage ×50/jour) | Devient une taxe de temps |
| Rejouer l'animation d'un graphique à chaque filtre | Distrayant, coûteux en CPU |

---

*Document d'architecture UX — à lire avec `ANALYSE-COMPLETE.md` (analyse technique) ; les lots sont indépendants et peuvent être livrés séparément.*

---

## 12. Journal d'implémentation

*Section ajoutée après réalisation. Tout a été codé avec les librairies déjà présentes : `framer-motion`, `tw-animate-css`, Tailwind 4, Base UI. **Zéro nouvelle dépendance.***

### 12.1 Briques créées (réutilisables)

| Fichier | Rôle |
|---|---|
| `src/hooks/use-count-up.ts` | Anime un nombre vers sa valeur (easeOutQuart, rAF). Renvoie la valeur finale si `prefers-reduced-motion`. |
| `src/hooks/use-success-flash.ts` | Drapeau « ça vient de réussir » qui se réarme seul (coche verte des boutons). |
| `src/hooks/use-media-query.ts` | `useSyncExternalStore` → pas d'effet, pas de clignotement. `useIsDesktop()` = ≥ 768 px. |
| `src/components/ui/animated-number.tsx` | Chiffre animé + `tabular-nums` (largeur stable). |
| `src/components/ui/table-skeleton.tsx` | `TableSkeleton` / `CardsSkeleton`, `role="status"` + `aria-busy`. |
| `src/components/ui/submit-button.tsx` | Bouton 3 états : repos → attente → succès. |
| `src/components/ui/empty-state.tsx` | État vide illustré, icône en flottement 3,6 s. |
| `src/components/ui/sparkline.tsx` | Mini-courbe SVG (~1 Ko, sans Recharts). |
| `src/components/ui/confetti.tsx` | Confettis CSS, 1,4 s, une seule fois, désactivés en mouvement réduit. |
| `src/components/ui/count-up-on-view.tsx` | Compteur déclenché à l'entrée dans l'écran (`useInView`, `once`). |
| `src/components/ui/tilt-card.tsx` | Inclinaison 3D ≤ 6°, souris uniquement. |

### 12.2 Fondations

- **`src/index.css`** : `row-in`, `row-flash`, `pulse-soft`, `float-soft`, `shake-x`, `gradient-pan`, `confetti-fall`, `progress-fill` ; transitions de page `::view-transition-*` ; révélation circulaire du thème (`html[data-theme-transition]`) ; **garde globale `prefers-reduced-motion`** (`*`, `*::before`, `*::after` + pseudo-éléments de view-transition).
- **`src/App.tsx`** : `<MotionConfig reducedMotion="user">` englobe toute l'application.

### 12.3 Lot 1 — performance perçue

- Squelettes à la place des « Chargement… » : **Lavages** (historique, catalogue, employés), **Caisse**, **Dépenses**, **Équipe** (+ comptes), **Prestations**, **Catégories** (×2), **Rapports** (tableaux), **Fiche lavage**, **Forfait**.
- Compteurs animés : cartes du **tableau de bord**, `DashboardMetrics`, **Rapports**, solde théorique de la **caisse**. *Jamais* sur le montant compté ni sur une saisie.
- Apparition échelonnée (`row-in`, 28 ms/ligne, plafonnée à 10) sur tous les tableaux métier.
- Transitions de page React Router (`viewTransition`) : sidebar, raccourcis du tableau de bord, liens de fiche — **plus la continuité** ligne de lavage → titre de la fiche (`view-transition-name: wash-reference`).
- Bouton attente → succès : lavage, dépense, connexion, inscription.
- Bascule de thème branchée dans l'en-tête (`SiteHeader`) sur `use-circular-transition` — le fichier n'était importé nulle part ; il gère désormais aussi le thème « système ».

### 12.4 Lot 2 — flux métier

- **Onboarding** : étapes qui glissent (`AnimatePresence`), barre de progression en `scaleX`, confettis + coche à la confirmation serveur, cartes de forfait inclinables.
- **Caisse** : pastille verte qui respire (session ouverte), solde animé, écart coloré (vert/rouge) + `shake-x` quand il est non nul, badges Entrée/Sortie.
- **Lavages / Dépenses** : surlignage (`row-flash`) de la ligne qui vient d'être créée, lignes estompées pendant une mise à jour (Prestations, Équipe), survol de ligne.
- **Modales** : fond assombri + flou 3 px, ouverture 200 ms / fermeture 120 ms (sortie plus vive que l'entrée).
- **Recharts** : `animationDuration={600}` partout ; la courbe du tableau de bord **ne se rejoue pas** au changement de période.
- **États vides illustrés** : Lavages, Dépenses, Équipe, Caisse, Prestations, Rapports.
- **Sidebar** : indicateur actif unique qui **glisse** d'un élément à l'autre (`layoutId`, ressort 380/32).

### 12.5 Lot 3 — vitrine

- **Hero** : parallax ≤ 40 px (désactivé < 768 px et en mouvement réduit), dégradé animé 16 s, chiffres d'exemple qui se composent.
- **Navbar** : compactée au défilement (72 → 60 px, ombre portée, baseline masquée).
- **Fonctionnalités** : cartes inclinables ≤ 6°.
- **Démo produit** : compteurs déclenchés au scroll.
- **Tableau de bord** : mini-courbe de tendance révélée au survol d'une carte d'indicateur.

### 12.6 Accessibilité & performance

- Une seule garde CSS globale + `MotionConfig reducedMotion="user"` : **tout** se désactive avec le réglage système, y compris confettis, parallax, tilt et transitions de page.
- Animations limitées à `transform` / `opacity` (plus `background-color` sur le flash de ligne, non bloquant).
- Zones en chargement : `role="status"` + `aria-busy="true"` ; boutons en attente : `aria-busy`.
- Aucun octet de dépendance ajouté ; le poids du bundle est inchangé (les nouveaux composants pèsent quelques Ko).

---

## 13. Système d'élévation 3D et jetons Framer Motion (20 octobre 2026)

Deuxième passe : les animations existantes étaient justes mais **dispersées**.
Chaque écran choisissait sa durée (200 ms ici, 300 ms là), son déplacement
(`-translate-y-0.5` ou `-translate-y-1`) et son ombre (`shadow-sm`,
`shadow-lg shadow-black/5`). Trois cartes qui apparaissent à trois vitesses ne
donnent pas « trois animations », elles donnent une impression de lenteur
irrégulière.

Cette passe ajoute deux fondations et y raccorde l'existant.

### 13.1 Jetons de mouvement — `src/lib/motion.ts`

Source unique des durées, courbes et variantes. Plus aucune valeur en dur
dans les écrans.

| Jeton | Valeur | Usage |
|---|---|---|
| `DURATION.hover` | 120 ms | Survol, pression, bascule |
| `DURATION.enter` | 240 ms | Apparition d'un élément |
| `DURATION.exit` | 180 ms | Disparition — toujours plus rapide que l'entrée |
| `DURATION.page` | 340 ms | Changement d'écran, ouverture de modale |
| `DURATION.counter` | 700 ms | Décompte d'un chiffre clé |

Courbes : `EASE.out` (`cubic-bezier(0.22, 1, 0.36, 1)`) par défaut — démarrage
franc, arrivée amortie. Ressorts : `SPRING.snappy` (survol), `SPRING.soft`
(apparition), `SPRING.pointer` (suivi de curseur).

Gestes : `HOVER_LIFT` = `scale 1.01` + `y -2px`. **1 %, pas 5 %** : sur une
grille de quatre indicateurs, un agrandissement visible chevauche les voisines
et fait trembler la grille entière. C'est l'ombre qui porte le message,
l'échelle ne fait que l'appuyer.

### 13.2 Élévations — `src/index.css`

Une élévation n'est pas une ombre, c'est une lumière zénithale. Chaque niveau
empile quatre couches :

1. **biseau haut** — liseré clair sur la bordure supérieure (la lumière) ;
2. **biseau bas** — liseré sombre sur la bordure inférieure (le contact) ;
3. **liseré** — contour d'1 px qui détache la surface du fond ;
4. **ombre portée** — diffusion ambiante + ombre directionnelle.

Les couches 1 et 2 donnent le relief *sur la bordure*, la 4 donne la hauteur.

| Classe | Rôle |
|---|---|
| `.elev-1` → `.elev-4` | Hauteur fixe. 1 = carte posée, 4 = modale |
| `.edge-3d` | Relief seul, sans ombre portée (en-têtes, champs, segments) |
| `.surface-3d` | Surface interactive : décolle au survol et au focus clavier |
| `.glow-primary\|success\|warning\|danger` | Lueur colorée sur la bordure — un **état**, jamais une décoration |
| `.glow-static` | Lueur permanente plutôt que révélée au survol |
| `.glow-breathe` | Lueur qui respire. Réservée à ce qui exige une action |
| `.scene-3d` / `.layer-3d` | Perspective partagée pour l'inclinaison au pointeur |

**Pourquoi un pseudo-élément.** `box-shadow` n'est pas compositée par le GPU :
l'animer force un recalcul du flou à chaque image. L'ombre haute est donc
peinte sur `::after` et seule son `opacity` varie. Le contrat « uniquement
`transform` et `opacity` » reste tenu, y compris sur les Android d'entrée de
gamme visés par le projet.

Deux conséquences qui se sont révélées à l'usage, et qui sont traitées :

- `overflow-hidden` sur une carte **rogne l'ombre du pseudo-élément**. La
  carte interactive ne le porte donc pas ; la carte statique le garde (elle en
  a besoin pour arrondir les images).
- Les ombres neutres utilisent un alpha explicite (`oklch(0 0 0 / 0.1)`) et
  non `color-mix(… var(--foreground) …)` : le compilateur CSS replie
  `color-mix` sur la couleur **opaque** pour les vieux navigateurs, ce qui
  aurait donné des pavés noirs. Une ombre est noire dans les deux thèmes de
  toute façon.

En thème sombre, le biseau clair passe de 75 % à 10 % d'opacité — à 75 % il
dessinerait une arête fluorescente — et les ombres sont creusées, car elles
portent moins sur fond noir.

### 13.3 Primitives — `src/components/ui/motion.tsx`

| Composant | Usage |
|---|---|
| `<Surface>` | Surface élevée, niveau et lueur paramétrables |
| `<ElevatedCard>` | Carte d'indicateur : cascade à l'entrée, décollement au survol, enfoncement au clic |
| `<MotionCard>` | La `Card` de la bibliothèque, animée (`motion.create`) — les sous-composants gardent leurs variables CSS |
| `<Tilt3D>` | Inclinaison vers le curseur, **avec l'ombre qui se déporte à l'opposé** — c'est ce décalage, plus que la rotation, qui fait lire l'objet comme physique |
| `<Stagger>` / `<StaggerItem>` | Cascade pilotée par les variantes, pas par des délais calculés dans chaque écran |
| `<FadeIn>` | Apparition simple, au montage ou à l'entrée dans la fenêtre |
| `<Pressable>` | Retour au survol et à la pression pour un enfant non-`motion` |
| `<PageTransition>` / `<PopIn>` | Entrée d'écran, entrée en surimpression |

### 13.4 Raccordements

- **Transition de page centralisée dans `BaseLayout`**, avec `key={pathname}` :
  déclarée une fois, elle s'applique à tous les écrans. Tentée d'abord par
  écran, l'approche a été abandonnée — un `div` intercalé casse le `flex-1`
  du `<main>`.
- **Primitives de la bibliothèque** : `Card` (`elev-1`, variante
  `interactive`), `Dialog` (`elev-4`), menus / popovers / select / hover-card
  (`elev-3`), panneau latéral (`elev-4`), toast (`elev-3`).
- **Boutons** : pression `scale 0.98`, relief de bordure, et décollement
  réservé à l'action principale — si tous les boutons décollent, plus aucun ne
  ressort. L'ordre des variantes Tailwind fait gagner `active` sur `hover`,
  vérifié dans le CSS compilé.
- **Navigation** : l'indicateur actif coulissant (`layoutId`) prend du relief ;
  l'icône de l'entrée survolée avance.
- **Tableau de bord** : indicateurs en `ElevatedCard`, raccourcis en cascade
  avec lueur primaire, panneaux en `Surface`.
- **Styles ad hoc remplacés** : 8 occurrences de
  `shadow-lg shadow-black/5 … duration-300 hover:-translate-y-1` dans
  `dashboard-metrics.tsx`, plus les cartes de `reports` et le choix de forfait
  de l'onboarding.
- **États métier** : bandeau d'essai en `glow-warning` / `glow-danger`
  permanent, motif d'écart de caisse en `glow-danger` fixe.

### 13.5 Ce qui a été délibérément écarté

- **Animer les modales avec Framer Motion.** Base UI pilote déjà leur cycle de
  vie en CSS (`data-open` / `data-closed`). Y greffer `AnimatePresence`
  demandait de dupliquer cet état pour un résultat identique. Elles reçoivent
  l'élévation, pas une seconde mécanique d'animation.
- **La lueur qui respire sur le comptage de caisse.** La règle tient :
  pendant une saisie de montant, rien ne bouge sous les doigts. Le champ de
  motif d'écart apparaît en fondu simple et sa lueur est fixe.
- **L'inclinaison 3D sous 768 px** : pas de curseur à suivre, et un coût réel
  en images par seconde sur les téléphones visés.

### 13.6 Accessibilité

La garde `prefers-reduced-motion` couvre les nouveaux effets. Choix assumé :
**les élévations restent**, seuls le décollement, l'inclinaison et la
respiration sont supprimés. Une ombre n'est pas du mouvement — c'est un repère
de hiérarchie, et le supprimer appauvrirait la lecture sans rien apporter à
qui demande moins d'animation.

### 13.7 Coût

Aucune dépendance ajoutée : `framer-motion` était déjà installé (14.4.0) et
utilisé par 14 fichiers. Le bundle gagne quelques kilo-octets de CSS ; les
primitives remplacent plus de code ad hoc qu'elles n'en ajoutent.

---

## 14. Thème clair / sombre (20 octobre 2026)

Une bascule existait déjà dans l'en-tête de l'application. L'audit a montré
que c'était la façade d'un système incomplet : quatre défauts réels, dont
deux visibles par tous les utilisateurs.

### 14.1 Ce qui était cassé

| Défaut | Conséquence |
|---|---|
| La classe du thème était posée dans un `useEffect` | **Éclair blanc à chaque chargement** pour un utilisateur en thème sombre |
| La bascule était binaire | Une fois le premier clic donné, **« Système » devenait inatteignable** — l'application cessait définitivement de suivre le téléphone |
| Aucun abonnement à `prefers-color-scheme` | En mode système, un téléphone qui bascule en sombre au coucher du soleil laissait l'application en clair jusqu'au rechargement |
| `localStorage` lu sans garde, valeur non validée | Exception en navigation privée ; une valeur corrompue était appliquée telle quelle |

S'y ajoutaient l'absence de `<meta name="theme-color">` (barre du navigateur
restée blanche sur Android, alors que c'est la cible du projet), l'absence de
`color-scheme` (contrôles de formulaire natifs restés clairs en thème sombre)
et une révélation circulaire qui ignorait `prefers-reduced-motion`.

### 14.2 Ce qui a été fait

**`index.html`** — script inline exécuté **avant le premier rendu**, qui lit
la préférence et pose la classe, `color-scheme` et `theme-color`. Plus
d'éclair. Le code y est volontairement dupliqué depuis `src/lib/theme.ts` :
il doit s'exécuter avant tout module, donc il ne peut rien importer.

**`src/lib/theme.ts`** — référence côté React : type `Theme`, clé de
stockage, lecture protégée, résolution de « system », application au document
(classe + `color-scheme` + `theme-color`), libellés français.

**`src/components/theme-provider.tsx`** — réécrit : abonnement à
`prefers-color-scheme`, abonnement à `storage` (deux onglets restent
cohérents), `resolvedTheme` exposé, `localStorage` protégé. La prop
`storageKey` a été **supprimée** : la clé doit rester identique à celle du
script inline, qu'aucune prop ne peut atteindre — la rendre configurable
offrait un réglage sans effet.

**`src/components/theme-toggle.tsx`** — trois formes pour trois contextes :

| Composant | Où | Pourquoi |
|---|---|---|
| `ThemeToggle` | En-tête | Un clic, geste quotidien, avec la révélation circulaire |
| `ThemeMenu` | En-tête (≥ sm) | Rend « Système » atteignable, et affiche ce qu'il résout |
| `ThemeSegmentedControl` | Réglages → Mon compte | Choix explicite, `radiogroup` navigable au clavier |

**Couleur de barre du navigateur** — `oklch(0.145 0 0)` converti donne
**#0a0a0a**, et non le #242424 posé au départ. L'écart était visible : une
barre d'adresse plus claire que l'application juste en dessous.

### 14.3 La vitrine reste claire — et c'est voulu

La page vitrine et les écrans de connexion comptent **environ 325 couleurs
codées en dur et zéro variante `dark:`**. Ils n'utilisent aucun jeton de
thème : ce sont des surfaces de marque à identité fixe, bleu profond sur
blanc.

Les convertir est une refonte graphique, pas un correctif de thème — et ce
n'était pas la demande. En revanche, l'état intermédiaire était réellement
cassé : avec `<html class="dark">`, les variables d'élévation basculaient et
les contrôles natifs des formulaires de connexion passaient en sombre, sous
des cartes restées blanches.

D'où la classe **`.light-surface`**, appliquée à la racine de la vitrine et
des écrans d'authentification : elle réaffirme `color-scheme: light` et les
valeurs claires d'élévation. Une dizaine de lignes qui suppriment
l'incohérence sans engager de refonte. Elle disparaîtra le jour où la vitrine
gagnera une vraie version sombre.

L'application, elle, est **entièrement sur jetons** : zéro couleur claire
codée en dur dans les écrans et les composants partagés, vérifié. Le thème
sombre y fonctionne sur toute la surface.

### 14.4 Tests

`tests/theme.test.ts` — 10 cas. La duplication entre `index.html` et
`src/lib/theme.ts` est volontaire mais fragile : les tests vérifient que la
clé de stockage et les deux couleurs restent identiques des deux côtés, que
le script précède bien le bundle, et que la résolution se comporte
correctement sur six scénarios (choix explicite contre système, absence de
choix, « system » enregistré, valeur corrompue). Sans ce garde-fou, une
divergence se manifesterait par un éclair blanc en production, pas par une
erreur de compilation.

Suite complète : **123 tests**.
