import test from "node:test"
import assert from "node:assert/strict"
import { MAX_VISIBLE_TASKS, selectVisibleTasks, type WashTaskSummary } from "../src/lib/wash-tasks.ts"

// ---------------------------------------------------------------------------
// Les taches que l'ecran de la station affiche
//
// L'ecran montre cinq cartes, pas plus : au-dela, on ne les lit plus. La
// question n'est donc pas « comment tout montrer » mais « quoi montrer en
// premier, et comment dire ce qu'on cache ».
// ---------------------------------------------------------------------------

function tache(
  id: string,
  overrides: Partial<WashTaskSummary> = {},
): WashTaskSummary {
  return {
    id,
    operation_started_at: null,
    operation_status: "pending",
    created_at: "2026-10-21T10:00:00.000Z",
    ...overrides,
  }
}

test("l'ecran montre cinq taches, et pas plus", () => {
  const taches = Array.from({ length: 8 }, (_, index) => tache(`t${index}`))
  const { visibles, masquees } = selectVisibleTasks(taches)
  assert.equal(visibles.length, MAX_VISIBLE_TASKS)
  assert.equal(masquees, 3)
})

test("une station calme n'affiche rien de trop", () => {
  const { visibles, masquees } = selectVisibleTasks([tache("a"), tache("b")])
  assert.equal(visibles.length, 2)
  assert.equal(masquees, 0)
})

test("les taches qui courent passent devant celles qui attendent", () => {
  const { visibles } = selectVisibleTasks([
    tache("attente-1", { created_at: "2026-10-21T09:00:00.000Z" }),
    tache("cours-1", {
      operation_status: "in_progress",
      operation_started_at: "2026-10-21T10:30:00.000Z",
    }),
  ])
  assert.equal(visibles[0].id, "cours-1")
})

test("parmi les taches qui courent, la plus ancienne passe devant", () => {
  // C'est elle qui est la plus pres de finir, et la plus probablement en
  // retard.
  const { visibles } = selectVisibleTasks([
    tache("recent", {
      operation_status: "in_progress",
      operation_started_at: "2026-10-21T11:00:00.000Z",
    }),
    tache("ancien", {
      operation_status: "in_progress",
      operation_started_at: "2026-10-21T09:00:00.000Z",
    }),
  ])
  assert.equal(visibles[0].id, "ancien")
})

test("a rang egal, l'ordre de creation tranche", () => {
  const { visibles } = selectVisibleTasks([
    tache("second", { created_at: "2026-10-21T10:05:00.000Z" }),
    tache("premier", { created_at: "2026-10-21T10:00:00.000Z" }),
  ])
  assert.equal(visibles[0].id, "premier")
})

test("l'ordre de la liste d'origine n'est pas modifie", () => {
  // La fonction trie une copie : l'etat de la page ne doit pas bouger sous
  // les pieds du composant qui l'appelle.
  const taches = [tache("b"), tache("a")]
  selectVisibleTasks(taches)
  assert.equal(taches[0].id, "b")
})
