import test from "node:test"
import assert from "node:assert/strict"
import {
  actionGate,
  isWashButtonClickable,
  resolvePendingOpen,
  washButtonState,
  washPrerequisites,
  washSubmitBlockedReason,
  type ActionGateInput,
  type WashButtonInput,
  type WashSubmitInput,
} from "../src/lib/action-blocking.ts"

/**
 * Un bouton désactivé doit toujours pouvoir répondre à « pourquoi ? ».
 *
 * Ces tests tiennent surtout à une distinction : une attente n'est pas un
 * refus. Le défaut d'origine traitait les deux de la même façon, et un
 * chargement d'une seconde prenait l'apparence d'une interdiction définitive.
 */

function bouton(overrides: Partial<WashButtonInput> = {}): WashButtonInput {
  return {
    sitesLoading: false,
    accessLoading: false,
    activeSiteCount: 1,
    allowed: true,
    reason: null,
    ...overrides,
  }
}

function soumission(overrides: Partial<WashSubmitInput> = {}): WashSubmitInput {
  return {
    allowed: true,
    accessReason: null,
    siteId: "site-1",
    vehicleCategoryId: "cat-1",
    selectedServiceCount: 1,
    assignedWorkerCount: 1,
    amountIsValid: true,
    cashNeedsSession: false,
    cashSessionLoading: false,
    hasCashSession: false,
    ...overrides,
  }
}

test("bouton Nouveau lavage : actif quand rien ne s'y oppose", () => {
  const state = washButtonState(bouton())
  assert.equal(state.disabled, false)
  assert.equal(state.reason, null)
  assert.equal(state.denied, false)
  assert.equal(state.preparing, false)
})

test("bouton Nouveau lavage : un chargement n'est jamais présenté comme un refus", () => {
  for (const attente of [{ sitesLoading: true }, { accessLoading: true }]) {
    const state = washButtonState(bouton({ ...attente, allowed: false }))
    assert.equal(state.disabled, true, "on désactive pendant l'attente")
    assert.equal(state.preparing, true, "c'est une attente")
    assert.equal(
      state.denied,
      false,
      "aucun cadenas pendant le chargement : l'interdiction n'est pas vérifiée",
    )
  }
})

test("bouton Nouveau lavage : l'attente prime sur l'absence de station", () => {
  // Pendant le chargement, `activeSiteCount` vaut 0 simplement parce que la
  // liste n'est pas arrivée. Annoncer « aucune station » serait faux.
  const state = washButtonState(bouton({ sitesLoading: true, activeSiteCount: 0 }))
  assert.equal(state.preparing, true)
  assert.equal(state.reason, null, "on n'invente pas une cause pendant l'attente")
})

test("bouton Nouveau lavage : sans station, on dit laquelle créer", () => {
  const state = washButtonState(bouton({ activeSiteCount: 0 }))
  assert.equal(state.disabled, true)
  assert.equal(state.denied, false, "ce n'est pas un refus de droit")
  assert.match(state.reason ?? "", /station/i)
  assert.match(state.reason ?? "", /Configuration/i, "on indique où aller")
})

test("bouton Nouveau lavage : un refus de droit affiche son motif", () => {
  const motif = "Enregistrer un lavage : action réservée. Votre rôle (Agent de lavage) ne dispose pas de ce droit."
  const state = washButtonState(bouton({ allowed: false, reason: motif }))
  assert.equal(state.disabled, true)
  assert.equal(state.denied, true, "le cadenas est ici justifié")
  assert.equal(state.reason, motif)
})

test("bouton Nouveau lavage : un refus sans motif n'est jamais muet", () => {
  const state = washButtonState(bouton({ allowed: false, reason: null }))
  assert.equal(state.denied, true)
  assert.ok(state.reason && state.reason.length > 0, "une phrase de repli est garantie")
})

test("bouton Nouveau lavage : tout état désactivé hors attente porte un motif", () => {
  const cas: Partial<WashButtonInput>[] = [
    { activeSiteCount: 0 },
    { allowed: false },
    { allowed: false, reason: "motif" },
    { activeSiteCount: 0, allowed: false },
  ]
  for (const c of cas) {
    const state = washButtonState(bouton(c))
    assert.equal(state.disabled, true, JSON.stringify(c))
    assert.ok(state.reason, `cas muet : ${JSON.stringify(c)}`)
  }
})

test("enregistrement : rien ne bloque un formulaire complet", () => {
  assert.equal(washSubmitBlockedReason(soumission()), null)
})

test("enregistrement : chaque champ manquant est nommé", () => {
  const attendus: [Partial<WashSubmitInput>, RegExp][] = [
    [{ siteId: "" }, /station/i],
    [{ vehicleCategoryId: "" }, /catégorie/i],
    [{ selectedServiceCount: 0 }, /prestation/i],
    [{ assignedWorkerCount: 0 }, /lave ce véhicule/i],
    [{ amountIsValid: false }, /montant/i],
  ]
  for (const [patch, motif] of attendus) {
    const reason = washSubmitBlockedReason(soumission(patch))
    assert.ok(reason, `cas muet : ${JSON.stringify(patch)}`)
    assert.match(reason, motif)
  }
})

test("enregistrement : le droit prime sur les champs manquants", () => {
  // Inutile de réclamer une catégorie de véhicule à quelqu'un qui n'a de
  // toute façon pas le droit d'enregistrer.
  // Le formulaire est vide ET le droit manque : c'est le droit qu'on annonce.
  const reason = washSubmitBlockedReason(
    soumission({
      allowed: false,
      accessReason: "Action réservée.",
      siteId: "",
      vehicleCategoryId: "",
      selectedServiceCount: 0,
      amountIsValid: false,
    }),
  )
  assert.equal(reason, "Action réservée.")
})

test("enregistrement : la session de caisse n'est exigée que pour les espèces", () => {
  const sansEspeces = washSubmitBlockedReason(
    soumission({ cashNeedsSession: false, hasCashSession: false }),
  )
  assert.equal(sansEspeces, null)

  const enEspeces = washSubmitBlockedReason(
    soumission({ cashNeedsSession: true, hasCashSession: false }),
  )
  assert.match(enEspeces ?? "", /session de caisse/i)
})

test("enregistrement : la vérification de la caisse est annoncée comme une attente", () => {
  const reason = washSubmitBlockedReason(
    soumission({ cashNeedsSession: true, cashSessionLoading: true, hasCashSession: false }),
  )
  assert.match(reason ?? "", /en cours/i, "on n'annonce pas une caisse fermée avant de savoir")
})

test("enregistrement : une session de caisse ouverte lève le blocage", () => {
  const reason = washSubmitBlockedReason(
    soumission({ cashNeedsSession: true, hasCashSession: true }),
  )
  assert.equal(reason, null)
})

/**
 * Politique retenue : pendant l'attente, le bouton reste cliquable.
 *
 * Griser par précaution punit tout le monde pour une incertitude d'une
 * seconde. Le clic reçu trop tôt n'est pas perdu : il est honoré dès que les
 * droits arrivent, ou abandonné si le refus se confirme.
 */

test("bouton cliquable : pendant l'attente, on ne grise pas", () => {
  for (const attente of [{ sitesLoading: true }, { accessLoading: true }]) {
    const state = washButtonState(bouton({ ...attente, allowed: false, activeSiteCount: 0 }))
    assert.equal(isWashButtonClickable(state), true, "l'incertitude ne justifie pas de griser")
  }
})

test("bouton cliquable : un refus avéré grise franchement", () => {
  assert.equal(isWashButtonClickable(washButtonState(bouton({ allowed: false }))), false)
  assert.equal(isWashButtonClickable(washButtonState(bouton({ activeSiteCount: 0 }))), false)
})

test("bouton cliquable : rien ne s'y oppose", () => {
  assert.equal(isWashButtonClickable(washButtonState(bouton())), true)
})

test("clic anticipé : tant que les droits manquent, on attend", () => {
  assert.equal(resolvePendingOpen(washButtonState(bouton({ accessLoading: true }))), "attendre")
  assert.equal(resolvePendingOpen(washButtonState(bouton({ sitesLoading: true }))), "attendre")
})

test("clic anticipé : honoré dès que les droits le permettent", () => {
  assert.equal(resolvePendingOpen(washButtonState(bouton())), "ouvrir")
})

test("clic anticipé : abandonné si le refus se confirme", () => {
  // Le clic avait été accepté par optimisme ; les droits arrivent et
  // tranchent. On n'ouvre pas, et le motif est déjà affiché sous le bouton.
  assert.equal(resolvePendingOpen(washButtonState(bouton({ allowed: false }))), "abandonner")
  assert.equal(resolvePendingOpen(washButtonState(bouton({ activeSiteCount: 0 }))), "abandonner")
})

test("clic anticipé : jamais d'ouverture sans motif connu", () => {
  // Garde-fou : ouvrir ne doit arriver que sur un état réellement praticable.
  const cas: Partial<WashButtonInput>[] = [
    { allowed: false },
    { activeSiteCount: 0 },
    { accessLoading: true },
    { sitesLoading: true },
    { allowed: false, accessLoading: true },
  ]
  for (const c of cas) {
    const state = washButtonState(bouton(c))
    assert.notEqual(resolvePendingOpen(state), "ouvrir", JSON.stringify(c))
  }
})

/* ---------------------------------------------------------------- *
 * Porte générique appliquée aux autres écrans
 * ---------------------------------------------------------------- */

function porte(overrides: Partial<ActionGateInput> = {}): ActionGateInput {
  return { loading: false, allowed: true, reason: null, ...overrides }
}

test("porte : rien ne bloque une action permise", () => {
  const g = actionGate(porte())
  assert.equal(g.disabled, false)
  assert.equal(g.reason, null)
  assert.equal(g.denied, false)
})

test("porte : ouvrir un formulaire reste cliquable pendant le chargement", () => {
  const g = actionGate(porte({ loading: true, allowed: false }))
  assert.equal(g.disabled, false, "rien n'est écrit en ouvrant un formulaire")
  assert.equal(g.busy, true)
  assert.equal(g.denied, false, "aucun cadenas tant que le droit est inconnu")
  assert.equal(g.reason, null, "on n'invente pas de motif")
})

test("porte : une écriture immédiate attend de connaître les droits", () => {
  const g = actionGate(porte({ loading: true, allowed: false, writesImmediately: true }))
  assert.equal(g.disabled, true, "une requête vouée au 403 ne part pas")
  assert.equal(g.busy, true, "mais c'est une attente, pas un refus")
  assert.equal(g.denied, false)
})

test("porte : un refus avéré porte toujours un motif", () => {
  const g = actionGate(porte({ allowed: false, reason: "Essai terminé." }))
  assert.equal(g.disabled, true)
  assert.equal(g.denied, true)
  assert.equal(g.reason, "Essai terminé.")

  const sansMotif = actionGate(porte({ allowed: false, reason: null }))
  assert.ok(sansMotif.reason, "une phrase de repli est garantie")
})

test("porte : un obstacle propre à l'écran s'annonce sans cadenas", () => {
  // Quota de laveurs atteint : le droit est là, c'est la limite qui bloque.
  const g = actionGate(porte({ blockedBy: "Limite de 3 laveurs atteinte." }))
  assert.equal(g.disabled, true)
  assert.equal(g.denied, false, "ce n'est pas un refus de droit")
  assert.equal(g.reason, "Limite de 3 laveurs atteinte.")
})

test("porte : le refus de droit prime sur l'obstacle d'écran", () => {
  const g = actionGate(porte({ allowed: false, reason: "Réservé.", blockedBy: "Quota atteint." }))
  assert.equal(g.reason, "Réservé.")
  assert.equal(g.denied, true)
})

test("porte : l'attente ne laisse jamais filtrer un motif inventé", () => {
  const g = actionGate(porte({ loading: true, allowed: false, reason: "Réservé.", blockedBy: "Quota." }))
  assert.equal(g.reason, null)
  assert.equal(g.busy, true)
})

test("porte : tout état désactivé hors attente porte un motif", () => {
  const cas: Partial<ActionGateInput>[] = [
    { allowed: false },
    { allowed: false, reason: "x" },
    { blockedBy: "y" },
    { allowed: false, blockedBy: "y" },
  ]
  for (const c of cas) {
    const g = actionGate(porte(c))
    assert.equal(g.disabled, true, JSON.stringify(c))
    assert.ok(g.reason, `cas muet : ${JSON.stringify(c)}`)
  }
})

test("enregistrement : personne d'affecté, on ne valide pas", () => {
  // La part de chacun se calcule sur cette affectation. Enregistrer sans
  // laveur, c'est fabriquer une ligne que le rendement ne saura pas répartir.
  const reason = washSubmitBlockedReason(soumission({ assignedWorkerCount: 0 }))
  assert.equal(reason, "Indiquez qui lave ce véhicule.")
})

test("enregistrement : plusieurs laveurs passent aussi bien qu'un seul", () => {
  // Deux personnes sur un 4x4, c'est courant : la part se partagera.
  assert.equal(washSubmitBlockedReason(soumission({ assignedWorkerCount: 3 })), null)
})

test("enregistrement : la prestation manquante se signale avant le laveur", () => {
  // On remonte le formulaire dans l'ordre où il se remplit, sinon le caissier
  // corrige le bas pendant que le haut est encore vide.
  const reason = washSubmitBlockedReason(
    soumission({ selectedServiceCount: 0, assignedWorkerCount: 0 }),
  )
  assert.match(reason ?? "", /prestation/i)
})

test("enregistrement : le laveur manquant se signale avant la caisse", () => {
  // Les deux manquent : on réclame d'abord ce qui se règle au comptoir.
  const reason = washSubmitBlockedReason(
    soumission({ assignedWorkerCount: 0, cashNeedsSession: true, hasCashSession: false }),
  )
  assert.match(reason ?? "", /lave ce véhicule/i)
})

/* ------------------------------------------------------------------ *
 * Mise en route d'une station neuve
 * ------------------------------------------------------------------ */

test("mise en route : une station neuve dit les trois manques, dans l'ordre", () => {
  // Le parcours réel d'une inscription : ni station, ni prestation, ni
  // employé. Le bouton est grisé à juste titre, mais il faut dire quoi faire.
  const manques = washPrerequisites({
    activeSiteCount: 0,
    activeServiceCount: 0,
    activeWorkerCount: 0,
  })
  assert.equal(manques.length, 3)
  assert.deepEqual(
    manques.map((m) => m.to),
    ["/sites", "/services", "/team"],
    "l'ordre doit suivre celui dans lequel on règle les choses",
  )
})

test("mise en route : une station équipée n'affiche aucun rappel", () => {
  const manques = washPrerequisites({
    activeSiteCount: 1,
    activeServiceCount: 5,
    activeWorkerCount: 3,
  })
  assert.deepEqual(manques, [])
})

test("mise en route : seul ce qui manque est listé", () => {
  // Station et prestations en place, mais personne pour laver.
  const manques = washPrerequisites({
    activeSiteCount: 1,
    activeServiceCount: 4,
    activeWorkerCount: 0,
  })
  assert.equal(manques.length, 1)
  assert.equal(manques[0].to, "/team")
  assert.match(manques[0].label, /employé/i)
})

test("mise en route : chaque manque porte une destination réelle", () => {
  // Un lien mort est pire qu'un bouton gris : l'utilisateur croit avancer.
  // Ces trois chemins existent dans src/config/routes.tsx.
  const routesConnues = ["/sites", "/services", "/team"]
  const manques = washPrerequisites({
    activeSiteCount: 0,
    activeServiceCount: 0,
    activeWorkerCount: 0,
  })
  for (const manque of manques) {
    assert.ok(routesConnues.includes(manque.to), `chemin inconnu : ${manque.to}`)
    assert.ok(manque.action.length > 0, "le lien doit porter un libellé")
    assert.ok(manque.why.length > 0, "on explique pourquoi c'est nécessaire")
  }
})

test("mise en route : le motif du bouton nomme le menu tel qu'il s'appelle", () => {
  // « Réglages › Stations » n'existe pas dans la barre latérale : le groupe
  // s'appelle « Configuration ». Envoyer quelqu'un à un endroit introuvable
  // transforme un bouton gris en impasse.
  const state = washButtonState(bouton({ activeSiteCount: 0 }))
  assert.match(state.reason ?? "", /Configuration › Stations/)
})
