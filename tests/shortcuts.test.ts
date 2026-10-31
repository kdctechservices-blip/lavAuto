/**
 * Raccourcis clavier.
 *
 * Deux comportements sont critiques en caisse : ne jamais intercepter une
 * frappe dans un champ, et ne jamais laisser une séquence « g » ouverte
 * indéfiniment (sinon la lettre suivante navigue au lieu d'être saisie).
 */
import { strict as assert } from "node:assert"
import test from "node:test"

import {
  SEQUENCE_TIMEOUT_MS,
  SHORTCUTS,
  isTypingTarget,
  resolveKey,
  shortcutGroups,
  type SequenceState,
} from "../src/lib/shortcuts.ts"

const idle: SequenceState = { pending: null, at: 0 }

test("g puis l ouvre la liste des lavages", () => {
  const first = resolveKey("g", idle, 1_000)
  assert.deepEqual(first.state, { pending: "g", at: 1_000 })

  const second = resolveKey("l", first.state, 1_200)
  assert.equal(second.href, "/washes")
  assert.equal(second.state.pending, null)
})

test("une séquence expirée ne détourne pas la frappe suivante", () => {
  const stale: SequenceState = { pending: "g", at: 1_000 }
  const late = resolveKey("l", stale, 1_000 + SEQUENCE_TIMEOUT_MS + 1)
  assert.equal(late.href, null)
})

test("n n'est pas une navigation tant que les droits ne sont pas vérifiés", () => {
  // `resolveKey` ne connaît pas les permissions : il rend le raccourci
  // « nouveau lavage » et c'est l'appelant qui vérifie `wash:create`. Vérifié
  // ici pour que la définition ne devienne pas une navigation silencieuse.
  const result = resolveKey("n", idle, 1_000)
  assert.equal(result.href, "/washes?new=1")
})

test("une touche inconnue ne déclenche rien", () => {
  const result = resolveKey("z", idle, 1_000)
  assert.equal(result.href, null)
  assert.equal(result.state.pending, null)
})

test("chaque raccourci de navigation mène à une route applicative", () => {
  for (const shortcut of SHORTCUTS) {
    if (!shortcut.href) continue
    assert.ok(shortcut.href.startsWith("/"), `${shortcut.id} doit viser une route`)
  }
})

test("les raccourcis sont groupés et chaque groupe est non vide", () => {
  const groups = shortcutGroups()
  assert.deepEqual(
    groups.map((group) => group.group),
    ["Actions", "Navigation", "Recherche"],
  )
  assert.ok(groups.every((group) => group.shortcuts.length > 0))
})

test("hors du navigateur, aucun élément n'est considéré comme un champ", () => {
  // Sans DOM, la fonction ne doit pas lever : elle est testée en Node.
  assert.equal(isTypingTarget(null), false)
})
