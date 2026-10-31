/**
 * Les fournisseurs de droits ne se montent qu'à la racine.
 *
 * `SubscriptionProvider` et `PermissionProvider` vivent dans `src/App.tsx`,
 * au-dessus du routeur. Leur place est unique : si un écran ou un layout les
 * remonte, il crée un second contexte — vide au départ, requêtant l'API à
 * chaque navigation — et tout composant au-dessus de lui lit ce contexte-là
 * au lieu du bon. C'est exactement ainsi que le bouton « Nouveau lavage » a
 * fini par charger sans fin : les droits qu'il attendait n'arrivaient jamais.
 *
 * Ce test lit les sources, comme `navigation.test.ts` : aucun rendu n'est
 * nécessaire pour repérer une montée hors racine, et l'échec nomme le fichier
 * fautif.
 */
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const PROVIDERS = ["SubscriptionProvider", "PermissionProvider"] as const

/** Tous les fichiers .tsx/.ts de src, hors App.tsx qui est le lieu autorisé. */
function sourceFiles(dir: string, except: string[] = []): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full, except))
    else if (/\.(tsx|ts)$/.test(entry.name) && !except.includes(full)) {
      found.push(full)
    }
  }
  return found
}

test("les fournisseurs de droits ne sont montés que dans App.tsx", () => {
  const files = sourceFiles("src", ["src/App.tsx"]).filter(
    // Les fichiers qui *définissent* les providers sont légitimes.
    (f) => f !== "src/lib/subscription.tsx" && f !== "src/lib/permissions.tsx",
  )

  const offenders: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const provider of PROVIDERS) {
      // Monter le provider = l'utiliser en JSX : `<SubscriptionProvider`.
      // Un simple import du type ou du hook (`useSubscription`) est correct.
      if (source.includes(`<${provider}`)) {
        offenders.push(`${file} monte <${provider}>`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Les fournisseurs SubscriptionProvider et PermissionProvider se montent " +
      "une seule fois, dans src/App.tsx (au-dessus du routeur). Une seconde " +
      "montance crée un contexte vide qui masque le bon — voir le bouton " +
      "« Nouveau lavage » qui chargeait sans fin :\n  " +
      offenders.join("\n  "),
  )
})
