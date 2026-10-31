import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

/**
 * Le thème est appliqué à deux endroits : un script inline dans `index.html`
 * (avant le premier rendu, pour éviter l'éclair blanc) et `src/lib/theme.ts`
 * (côté React). Le script ne peut rien importer — il doit s'exécuter avant
 * tout module — donc la clé de stockage et les couleurs y sont **dupliquées**.
 *
 * Ces tests sont le garde-fou de cette duplication : si quelqu'un change la
 * clé ou une couleur d'un seul côté, la suite échoue au lieu de laisser un
 * éclair blanc ou une barre de navigateur mal teintée passer en production.
 */

const root = join(import.meta.dirname, "..")
const indexHtml = readFileSync(join(root, "index.html"), "utf8")
const themeLib = readFileSync(join(root, "src/lib/theme.ts"), "utf8")
const appCss = readFileSync(join(root, "src/index.css"), "utf8")

describe("thème — cohérence entre le script inline et le module React", () => {
  it("utilise la même clé de stockage des deux côtés", () => {
    const fromLib = /THEME_STORAGE_KEY = "([^"]+)"/.exec(themeLib)?.[1]
    assert.ok(fromLib, "clé introuvable dans src/lib/theme.ts")
    assert.match(
      indexHtml,
      new RegExp(`getItem\\("${fromLib}"\\)`),
      `le script inline de index.html doit lire la clé « ${fromLib} »`
    )
  })

  it("annonce la même couleur de barre de navigateur des deux côtés", () => {
    const light = /light: "(#[0-9a-f]{6})"/.exec(themeLib)?.[1]
    const dark = /dark: "(#[0-9a-f]{6})"/.exec(themeLib)?.[1]
    assert.ok(light && dark, "couleurs introuvables dans src/lib/theme.ts")
    assert.ok(
      indexHtml.includes(light!),
      `index.html doit contenir la couleur claire ${light}`
    )
    assert.ok(
      indexHtml.includes(dark!),
      `index.html doit contenir la couleur sombre ${dark}`
    )
  })

  it("pose le thème avant de charger l'application", () => {
    const script = indexHtml.indexOf("vite-ui-theme")
    const bundle = indexHtml.indexOf("/src/main.tsx")
    assert.ok(script > -1, "script de thème absent de index.html")
    assert.ok(bundle > -1, "point d'entrée absent de index.html")
    assert.ok(
      script < bundle,
      "le script de thème doit précéder le bundle, sinon l'éclair blanc revient"
    )
  })

  it("déclare une balise theme-color que le script puisse mettre à jour", () => {
    assert.match(indexHtml, /<meta name="theme-color"/)
  })
})

describe("thème — résolution de la préférence", () => {
  /** Reproduit la logique du script inline, qui ne peut pas être importée. */
  function resolve(stored: string | null, osPrefersDark: boolean): string {
    const theme = stored === "light" || stored === "dark" ? stored : null
    return theme ?? (osPrefersDark ? "dark" : "light")
  }

  it("respecte un choix explicite, même contre le système", () => {
    assert.equal(resolve("dark", false), "dark")
    assert.equal(resolve("light", true), "light")
  })

  it("suit le système quand aucun choix n'est enregistré", () => {
    assert.equal(resolve(null, true), "dark")
    assert.equal(resolve(null, false), "light")
  })

  it("traite « system » comme un suivi du système, pas comme un thème", () => {
    assert.equal(resolve("system", true), "dark")
    assert.equal(resolve("system", false), "light")
  })

  it("ignore une valeur corrompue au lieu de l'appliquer", () => {
    assert.equal(resolve("bleu", false), "light")
    assert.equal(resolve("", true), "dark")
  })
})

describe("thème — feuille de style", () => {
  it("définit les variables de surface pour les deux thèmes", () => {
    assert.match(appCss, /:root\s*\{[\s\S]*?--background:/)
    assert.match(appCss, /\.dark\s*\{[\s\S]*?--background:/)
  })

  it("verrouille la vitrine en clair, y compris color-scheme", () => {
    const block = /\.light-surface\s*\{([\s\S]*?)\}/.exec(appCss)?.[1]
    assert.ok(block, "classe .light-surface absente de src/index.css")
    assert.match(
      block!,
      /color-scheme:\s*light/,
      "sans color-scheme, les contrôles natifs restent sombres dans un formulaire blanc"
    )
    assert.match(block!, /--elev-1:/)
    assert.match(block!, /--edge-light:/)
  })
})
