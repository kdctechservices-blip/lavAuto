import test from "node:test"
import assert from "node:assert/strict"
import {
  countdownProgress,
  countdownState,
  estimatedSeconds,
  formatDuration,
  remainingSeconds,
} from "../src/lib/wash-countdown.ts"

// ---------------------------------------------------------------------------
// Le decompte du temps de lavage
//
// La barre qui avance est la seule chose que le laveur regarde pendant un
// lavage. Elle doit dire vrai : ni plus, ni moins, jamais au-dela de 100 %,
// jamais en arriere.
// ---------------------------------------------------------------------------

test("une duree estimee en minutes devient une duree en secondes", () => {
  assert.equal(estimatedSeconds(45), 2700)
  assert.equal(estimatedSeconds(0.5), 30)
})

test("une duree inconnue ne vaut pas zero fois infinie", () => {
  assert.equal(estimatedSeconds(null), 0)
  assert.equal(estimatedSeconds(undefined), 0)
  assert.equal(estimatedSeconds(0), 0)
  assert.equal(estimatedSeconds(-10), 0)
  assert.equal(estimatedSeconds(Number.NaN), 0)
})

test("l'avancement suit le temps ecoule", () => {
  assert.equal(countdownProgress(0, 2700), 0)
  assert.equal(countdownProgress(1350, 2700), 50)
  assert.equal(countdownProgress(2699, 2700), 99)
})

test("l'avancement ne depasse jamais cent pour cent", () => {
  assert.equal(countdownProgress(2700, 2700), 100)
  assert.equal(countdownProgress(5400, 2700), 100)
  assert.equal(countdownProgress(99999, 2700), 100)
})

test("sans duree estimee, l'avancement reste a zero", () => {
  // Une division par zero donnerait Infinity, et une barre infinie est une
  // barre cassee.
  assert.equal(countdownProgress(100, 0), 0)
  assert.equal(countdownProgress(100, Number.NaN), 0)
  assert.equal(countdownProgress(-5, 2700), 0)
})

test("le temps restant diminue et ne devient jamais negatif", () => {
  assert.equal(remainingSeconds(0, 2700), 2700)
  assert.equal(remainingSeconds(600, 2700), 2100)
  assert.equal(remainingSeconds(2700, 2700), 0)
  assert.equal(remainingSeconds(5400, 2700), 0)
})

test("une duree se lit en clair", () => {
  assert.equal(formatDuration(2700), "45 min")
  assert.equal(formatDuration(3600), "1 h")
  assert.equal(formatDuration(4500), "1 h 15")
  assert.equal(formatDuration(7200), "2 h")
  assert.equal(formatDuration(0), "0 min")
  assert.equal(formatDuration(-10), "0 min")
})

test("sous la minute, on compte les secondes", () => {
  // « 0 min » pendant la derniere minute d'un lavage serait une
  // information fausse : la barre n'est pas encore finie.
  assert.equal(formatDuration(42), "42 s")
  assert.equal(formatDuration(59), "59 s")
})

test("une tache qui n'a pas commence n'a pas de temps ecoule", () => {
  assert.equal(countdownState(null, 0, 2700), "not_started")
  assert.equal(countdownState("2026-10-21T10:00:00.000Z", 60, 2700), "running")
  assert.equal(countdownState("2026-10-21T10:00:00.000Z", 2700, 2700), "finished")
})

test("une tache sans duree estimee ne se termine jamais d'elle-meme", () => {
  // Sans horizon, la tache attend que quelqu'un la termine a la main.
  assert.equal(countdownState("2026-10-21T10:00:00.000Z", 99999, 0), "running")
})
