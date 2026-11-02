import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const css = readFileSync(new URL("../packages/shared-ui/src/theme.css", import.meta.url), "utf8")
const lightTheme = css.slice(css.indexOf(":root {"), css.indexOf("\n.dark {"))
const darkTheme = css.slice(css.indexOf("\n.dark {") + 1, css.indexOf("\n@layer base {"))

function color(block: string, token: string): string {
  const value = new RegExp(`--${token}:\\s*(#[0-9A-Fa-f]{6})\\s*;`).exec(block)?.[1]
  assert.ok(value, `token CSS --${token} introuvable`)
  return value
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

test("le thème clair respecte AA pour les actions et les textes sémantiques", () => {
  const white = "#FFFFFF"
  const page = color(lightTheme, "surface-page")
  const primary = color(lightTheme, "brand-500-current")
  const actionAccent = color(lightTheme, "action-accent")

  assert.ok(contrastRatio(primary, white) >= 4.5, "le bleu principal doit rester lisible sur blanc")
  assert.ok(contrastRatio(actionAccent, white) >= 4.5, "le CTA orange doit utiliser une teinte compatible avec du texte blanc")
  assert.ok(contrastRatio(color(lightTheme, "text-muted"), page) >= 4.5, "le texte secondaire doit rester AA sur la surface")
  assert.ok(contrastRatio(color(lightTheme, "text-subtle"), white) >= 4.5, "le texte subtil doit rester AA sur une carte blanche")
  assert.ok(contrastRatio(color(lightTheme, "input-color"), white) >= 3, "la bordure des contrôles doit rester identifiable")
  for (const token of ["success-color", "warning-color", "info-color", "danger-color"]) {
    assert.ok(contrastRatio(color(lightTheme, token), white) >= 4.5, `--${token} doit être lisible avec du texte blanc`)
  }

  // L'orange de marque 500 sert aux aplats décoratifs; le blanc dessus n'est pas AA.
  assert.ok(contrastRatio("#F97316", white) < 4.5)
})

test("le thème sombre utilise des avant-plans adaptés aux couleurs éclaircies", () => {
  const darkSurface = color(darkTheme, "surface-page")
  const darkForeground = color(darkTheme, "text-inverse")

  for (const token of ["brand-500-current", "action-accent", "success-color", "warning-color", "info-color", "danger-color"]) {
    const background = color(darkTheme, token)
    assert.ok(
      contrastRatio(background, darkForeground) >= 4.5,
      `le texte sombre doit contraster avec --${token}`,
    )
  }

  assert.ok(contrastRatio(color(darkTheme, "text-muted"), darkSurface) >= 4.5)
  assert.ok(contrastRatio(color(darkTheme, "input-color"), color(darkTheme, "surface-elevated")) >= 3)
})
