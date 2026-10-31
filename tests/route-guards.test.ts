import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Garde-fou : aucune route sans contrôle d'autorisation
//
// `requirePermission` (ou `assertPermission` dans le corps) est le seul point
// qui dit « cette personne a le droit ». Un oubli sur une nouvelle route ne
// se voit pas dans la revue de code : la route répond simplement 200 à tout
// membre connecté de la station. Ce test rend l'oubli impossible à merger :
// chaque enregistrement de route doit porter un garde, ou figurer ci-dessous
// avec la raison pour laquelle il n'en a pas.
//
// La liste n'est pas une porte dérobée : elle est elle-même vérifiée (une
// entrée qui ne correspond plus à aucune route fait échouer le test), et
// chaque raison est une décision de produit documentée.
// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const serverDir = path.join(root, "server")

/**
 * Raisons acceptées pour une route sans garde d'autorisation.
 * Clé : `fichier|MÉTHODE /chemin`.
 */
const ALLOWED_UNGUARDED: Record<string, string> = {
  // --- Identité : avant toute session de station, il n'y a rien à autoriser.
  "auth-router.ts|POST /register": "création de compte, avant session",
  "auth-router.ts|POST /login": "connexion, avant session",
  "auth-router.ts|POST /logout": "déconnexion, jeton personnel",
  "auth-router.ts|GET /me": "profil du compte connecté, avant contexte de station",
  "auth-router.ts|PATCH /profile": "profil du compte connecté, avant contexte de station",
  "auth-router.ts|POST /password": "mot de passe du compte connecté, avant contexte de station",
  "auth-router.ts|POST /forgot-password": "demande publique de réinitialisation",
  "auth-router.ts|GET /reset-password": "vérification publique d'un jeton de réinitialisation",
  "auth-router.ts|POST /reset-password": "réinitialisation publique par jeton à usage unique",

  // --- Console éditeur : montée sous requireOperator (app.ts), son propre
  //     cookie, sa propre table de sessions. Ne traverse jamais une session
  //     de station.
  "console-auth.ts|POST /login": "console éditeur : identité de l'opérateur",
  "console-auth.ts|POST /logout": "console éditeur : déconnexion de l'opérateur",
  "console-auth.ts|GET /me": "console éditeur : profil de l'opérateur",
  "admin.ts|GET /metrics": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /organizations": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /organizations/:id": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /organizations/:id/members": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/members/:userId/reset-password": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/members/:userId/status": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/activate": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/suspend": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/extend-trial": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/schedule-deletion": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/cancel-deletion": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /organizations/:id/purge": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /upgrade-requests": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /upgrade-requests/:id/decline": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /payment-intents": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /payment-intents/:reference/confirm": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /audit": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /plans": "console éditeur : montée sous requireOperator",
  "admin.ts|PATCH /plans/:code": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /revenue": "console éditeur : montée sous requireOperator",
  "admin.ts|GET /revenue/export": "console éditeur : montée sous requireOperator",
  "admin.ts|POST /revenue/:id/reverse": "console éditeur : montée sous requireOperator",
  "console-accounts.ts|GET /accounts": "console éditeur : montée sous requireOperator",
  "console-accounts.ts|GET /accounts/:userId": "console éditeur : montée sous requireOperator",
  "console-accounts.ts|POST /accounts/:userId/status": "console éditeur : montée sous requireOperator",
  "console-accounts.ts|POST /accounts/:userId/revoke-sessions": "console éditeur : montée sous requireOperator",
  "console-accounts.ts|POST /organizations/:id/members/:userId/role": "console éditeur : montée sous requireOperator",
  "console-monitoring.ts|GET /monitoring": "console éditeur : montée sous requireOperator",
  "console-monitoring.ts|GET /monitoring/errors": "console éditeur : montée sous requireOperator",
  "console-monitoring.ts|GET /monitoring/errors/:id": "console éditeur : montée sous requireOperator",
  "console-monitoring.ts|GET /monitoring/alerts": "console éditeur : lecture sous requireOperator ; écritures avec requireConsoleAdmin",
  "console-operators.ts|GET /": "admin Console : routeur monté sous requireOperator et requireConsoleAdmin",
  "console-operators.ts|POST /": "admin Console : routeur monté sous requireOperator et requireConsoleAdmin",
  "console-operators.ts|PATCH /:id": "admin Console : routeur monté sous requireOperator et requireConsoleAdmin",
  "console-operators.ts|POST /:id/reset-password": "admin Console : routeur monté sous requireOperator et requireConsoleAdmin",
  "console-operators.ts|POST /:id/revoke-sessions": "admin Console : routeur monté sous requireOperator et requireConsoleAdmin",
  "console-reconciliation.ts|GET /reconciliation": "console éditeur : requireOperator, support en lecture seule",
  "console-reconciliation.ts|POST /reconciliation/batches": "console éditeur : requireOperator puis requireConsoleWrite",
  "console-reconciliation.ts|POST /reconciliation/run": "console éditeur : requireOperator puis requireConsoleWrite",
  "console-reconciliation.ts|GET /reconciliation/batches/:id": "console éditeur : requireOperator, support en lecture seule",
  "console-reconciliation.ts|POST /reconciliation/discrepancies/:id/resolve": "console éditeur : requireOperator puis requireConsoleWrite",
  "console-support.ts|GET /support": "console éditeur : montée sous requireOperator",
  "console-support.ts|GET /support/:id": "console éditeur : montée sous requireOperator",
  "console-support.ts|POST /support/:id/messages": "console éditeur : montée sous requireOperator",
  "console-support.ts|POST /support/:id/status": "console éditeur : montée sous requireOperator",
  "console-support.ts|GET /organizations/:id/members/:userId/diagnostic": "console éditeur : montée sous requireOperator",
  "closure.ts|GET /closure-requests": "variante console (registerClosureConsoleRoutes), montée sous requireOperator",
  "closure.ts|POST /closure-requests/:id/decline": "variante console (registerClosureConsoleRoutes), montée sous requireOperator",

  // --- Public : la grille tarifaire d'un visiteur sans compte.
  "public-pricing.ts|GET /pricing": "grille tarifaire publique, avant session",

  // --- Ouverts à tout membre de la station, cloisonnés par le contexte de
  //     locataire et par des vérifications dans le corps (404, jamais 403 :
  //     une demande d'une autre station est introuvable, pas interdite).
  "access.ts|GET /me/permissions": "droits du compte connecté : la source de vérité de l'interface pour afficher ou masquer les actions",
  "onboarding.ts|GET /onboarding/progress": "assistant d'installation : reprise de l'étape en cours de la station courante",
  "onboarding.ts|GET /plans": "assistant d'installation : lecture du catalogue de forfaits",
  "onboarding.ts|GET /service-catalog": "assistant d'installation : lecture du catalogue partagé",
  "onboarding.ts|GET /onboarding/status": "assistant d'installation : état de la station courante",
  "onboarding.ts|GET /onboarding/summary": "assistant d'installation : récapitulatif de la station courante",
  "subscription.ts|GET /subscription": "tout membre lit l'abonnement de sa station",
  "checkout.ts|GET /subscription/checkout": "tout membre lit l'état des demandes de paiement de sa station",
  "support.ts|GET /support/config": "assistance : canal ouvert à tout membre",
  "support.ts|POST /support/requests": "assistance : tout membre peut ouvrir une demande",
  "support.ts|GET /support/requests": "assistance : liste filtrée par rôle et par auteur dans la route",
  "support.ts|GET /support/requests/:id": "assistance : fil vérifié par station et par auteur dans la route",
  "support.ts|POST /support/requests/:id/messages": "assistance : message vérifié par station et par auteur dans la route",
}

/** Marqueurs d'un contrôle d'autorisation dans le corps de la route. */
const GUARD_MARKERS = /\b(requirePermission|assertPermission|requireCapability|requireOperator)\s*\(|\brequireConsoleAdmin\b/

interface RouteRegistration {
  file: string
  method: string
  routePath: string
  block: string
  line: number
}

/**
 * Extrait les blocs `r.<verbe>("chemin", …)` d'un fichier, avec l'expression
 * complète jusqu'à la parenthèse fermante. Une machine à cadres distingue le
 * code des chaînes, commentaires et gabarits interpolés : une parenthèse dans
 * une requête SQL ou dans `${…}` ne referme jamais l'appel à la route.
 */
function extractRoutes(file: string, source: string): RouteRegistration[] {
  const routes: RouteRegistration[] = []
  const startPattern = /\b(?:r|router)\.(get|post|patch|put|delete)\s*\(\s*"([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = startPattern.exec(source)) !== null) {
    const openParen = source.indexOf("(", match.index)
    type Frame =
      | { type: "code"; curly: number }
      | { type: "text"; terminator: "'" | '"' | "`" }
    const frames: Frame[] = [{ type: "code", curly: 0 }]
    let depth = 1
    let end = openParen
    let i = openParen + 1
    for (; i < source.length; i += 1) {
      const char = source[i]
      const next = source[i + 1]
      const frame = frames[frames.length - 1]
      if (frame.type === "text") {
        if (char === "\\") i += 1
        else if (char === frame.terminator) frames.pop()
        else if (frame.terminator === "`" && char === "$" && next === "{") {
          frames.push({ type: "code", curly: 0 })
          i += 1
        }
        continue
      }
      // frame.type === "code"
      if (char === "'" || char === '"' || char === "`") {
        frames.push({ type: "text", terminator: char })
      } else if (char === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1
      } else if (char === "/" && next === "*") {
        i += 2
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1
        i += 1
      } else if (char === "(") {
        depth += 1
      } else if (char === ")") {
        depth -= 1
        if (depth === 0 && frames.length === 1) {
          end = i
          break
        }
      } else if (char === "{") {
        frame.curly += 1
      } else if (char === "}") {
        if (frame.curly > 0) frame.curly -= 1
        else if (frames.length > 1) frames.pop() // fin de `${…}`
      }
    }
    routes.push({
      file,
      method: match[1].toUpperCase(),
      routePath: match[2],
      block: source.slice(match.index, end + 1),
      line: source.slice(0, match.index).split("\n").length,
    })
  }
  return routes
}

function scanAllRoutes(): RouteRegistration[] {
  const routes: RouteRegistration[] = []
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".ts")) continue
    routes.push(...extractRoutes(name, readFileSync(path.join(serverDir, name), "utf8")))
  }
  return routes
}

test("chaque route porte un contrôle d'autorisation ou une raison documentée", () => {
  const routes = scanAllRoutes()
  assert.ok(routes.length > 50, `seulement ${routes.length} routes trouvées : le scanner s'est cassé`)

  const unexplained: string[] = []
  const usedAllowlistKeys = new Set<string>()
  for (const route of routes) {
    const key = `${route.file}|${route.method} ${route.routePath}`
    if (GUARD_MARKERS.test(route.block)) {
      usedAllowlistKeys.add(key)
      continue
    }
    if (key in ALLOWED_UNGUARDED) {
      usedAllowlistKeys.add(key)
      continue
    }
    unexplained.push(`${route.file}:${route.line} ${route.method} ${route.routePath}`)
  }

  assert.deepEqual(
    unexplained,
    [],
    "routes sans contrôle d'autorisation (ajoutez requirePermission, ou une entrée justifiée dans ALLOWED_UNGUARDED)",
  )

  // La liste des dérogations doit rester vivante : une route supprimée ou
  // sécurisée entre-temps emporte son entrée.
  const stale = Object.keys(ALLOWED_UNGUARDED).filter((key) => !usedAllowlistKeys.has(key))
  assert.deepEqual(stale, [], "entrées de ALLOWED_UNGUARDED qui ne correspondent plus à aucune route")
})
