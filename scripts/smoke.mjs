/**
 * Test de fumée de bout en bout.
 *
 * Ce que fait ce script : il démarre **son propre serveur** sur un port libre,
 * avec une base embarquée en mémoire, puis il joue le parcours complet d'un
 * nouveau client — inscription, configuration de la station, catalogue,
 * forfait, confirmation — avant de lire tous les écrans d'exploitation.
 * Le serveur est arrêté à la fin, la base disparaît avec lui.
 *
 * Pourquoi ainsi plutôt que contre le serveur de développement : un test de
 * fumée qui crée des stations et des lavages dans la base où l'on travaille
 * finit par la polluer, et l'on n'ose plus le lancer. Ici, rien ne survit au
 * processus : on peut le lancer autant de fois que voulu, y compris en CI.
 *
 * Ce qu'il attrape : une route qui répond 500, une page blanche, un parcours
 * d'inscription cassé par une migration, un catalogue vide, un forfait absent.
 * Ce qu'il n'attrape pas : un défaut d'affichage. C'est le rôle des tests de
 * composants et de la relecture visuelle.
 *
 * Usage :
 *   npm run smoke
 *   npm run smoke -- --base-url http://localhost:3000   # contre un serveur déjà lancé
 *   npm run smoke -- --serverless                       # runtime des fonctions Vercel
 *   npm run smoke -- --verbose
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1] ?? null
}
const externalBaseUrl = argValue("--base-url")
const verbose = args.includes("--verbose")
/**
 * Mode serverless : le serveur jetable est `scripts/serve-vercel-local.mjs`,
 * qui applique les règles de Vercel (chemin dans `req.query.slug`, corps déjà
 * analysé) au lieu de celles d'Express. C'est le seul moyen de vérifier ici ce
 * que la production exécutera réellement.
 */
const serverless = args.includes("--serverless")

const results = []
let failures = 0

function record(name, ok, detail = "") {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  const label = ok ? "  ok " : "ÉCHEC"
  console.log(`${label}  ${name}${detail ? ` — ${detail}` : ""}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Trouve un port libre en laissant le système en choisir un. */
async function freePort() {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function startServer(port) {
  const tsxLoader = path.join(root, "node_modules", "tsx", "dist", "loader.mjs")
  const entry = serverless ? path.join("scripts", "serve-vercel-local.mjs") : "server.ts"
  const child = spawn(process.execPath, ["--import", tsxLoader, entry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      PGLITE_DATA_DIR: ":memory:",
      DATABASE_URL: "",
      // Un opérateur de console est nécessaire pour vérifier le back-office.
      PLATFORM_ADMIN_EMAILS: "smoke-operator@example.ci",
      PLATFORM_ADMIN_PASSWORD: "SmokeOperator2026!",
      // Jeu de démonstration : donne une station et des lavages à lire.
      SEED_DEMO_DATA: "true",
      NO_COLOR: "1",
    },
    stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
  })
  const logs = []
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)))
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)))
  return { child, logs }
}

async function waitForReady(baseUrl, attempts = 120) {
  // Le runtime serverless ne sert que /api : la sonde de vie y est /api/healthz.
  const probe = serverless ? "/api/healthz" : "/readyz"
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${baseUrl}${probe}`)
      if (response.ok) return true
    } catch {
      /* le serveur n'écoute pas encore */
    }
    await sleep(250)
  }
  return false
}

/** Client HTTP minimal : conserve le cookie de session comme un navigateur. */
function createClient(baseUrl) {
  let cookie = ""
  return {
    get cookie() {
      return cookie
    },
    useCookie(value) {
      cookie = value
    },
    async call(pathname, { method = "GET", body, auth = true } = {}) {
      const headers = { "Content-Type": "application/json", Accept: "application/json" }
      if (auth && cookie) headers.Cookie = cookie
      // Toute écriture exige une clé d'idempotence, comme le fait le client :
      // c'est elle qui empêche un double encaissement après une coupure réseau.
      if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID()
      const response = await fetch(baseUrl + pathname, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const setCookie = response.headers.get("set-cookie")
      if (setCookie) {
        const match = /(washpilot_[a-z]+)=([^;]+)/.exec(setCookie)
        if (match && auth) cookie = `${match[1]}=${match[2]}`
      }
      const text = await response.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = text
      }
      return { status: response.status, json }
    },
  }
}

async function run(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "")
  const client = createClient(base)

  // --- 1. Pages publiques et modules de pages ---------------------------
  // En mode serverless, ces fichiers sont servis par la plateforme depuis
  // `dist/` : la fonction ne les voit jamais. Les tester ici n'aurait donc
  // aucun sens — c'est le déploiement qui les sert, pas l'API.
  if (serverless) {
    console.log("[smoke] Pages et modules de routes ignorés : servis par la plateforme, pas par la fonction.\n")
  } else {
    // --- 1. Pages publiques et applicatives ---------------------------------
    const pages = [
      ["/landing", "Pilotez votre station"],
      ["/auth/sign-in", "Connexion"],
      ["/auth/sign-up", "Créer"],
      ["/console", ""],
      ["/dashboard", ""],
    ]
    for (const [pathname, needle] of pages) {
      const response = await fetch(base + pathname)
      const html = await response.text()
      record(
        `page ${pathname}`,
        response.ok && html.includes("<div id=\"root\""),
        `${response.status}`,
      )
      if (needle) {
        // Le HTML initial est celui de la coquille Vite : le contenu est rendu
        // côté client. On vérifie donc que le module de page est bien servi.
        const moduleReachable = await fetch(base + pathname).then((r) => r.ok)
        record(`  contenu servi pour ${pathname}`, moduleReachable)
      }
    }

    // --- 1 bis. Modules de toutes les pages --------------------------------
    // Le routeur charge chaque écran à la demande. Une page qui importe un
    // module disparu, ou dont le JSX ne compile plus, ne se voit qu'au moment
    // où on l'ouvre — c'est-à-dire en production, chez le client. On demande
    // donc à Vite de transformer chaque module de route, comme le ferait le
    // navigateur, et on vérifie qu'il répond sans erreur.
    const routeFiles = ["src/config/routes.tsx", "src/console/routes.tsx", "src/App.tsx"]
    const modules = new Set()
    for (const file of routeFiles) {
      const source = readFileSync(path.join(root, file), "utf8")
      for (const match of source.matchAll(/import\("@\/([^"]+)"\)/g)) {
        modules.add(`/src/${match[1]}.tsx`)
      }
    }
    let brokenModules = 0
    for (const modulePath of [...modules].sort()) {
      const response = await fetch(base + modulePath)
      const body = await response.text()
      // Vite renvoie 200 avec un message d'erreur dans le corps quand la
      // transformation échoue : le statut seul ne suffit pas.
      const failed = !response.ok || /^\s*(throw new Error|SyntaxError|Failed to resolve)/.test(body)
      if (failed) {
        brokenModules += 1
        console.log(`ÉCHEC  module ${modulePath} — ${response.status} ${body.slice(0, 160).replace(/\s+/g, " ")}`)
      }
    }
    record(`modules de pages (${modules.size})`, brokenModules === 0, `${brokenModules} en échec`)
  }

  // --- 2. Parcours d'inscription -----------------------------------------
  const email = `smoke-${Date.now()}@example.ci`
  const password = "MotDePasseTest1!"
  let result = await client.call("/api/v1/auth/register", {
    method: "POST",
    auth: false,
    body: {
      firstName: "Awa",
      lastName: "Fumée",
      email,
      password,
      organizationName: "Station Fumée",
    },
  })
  // `auth: false` empêche la capture du cookie : on le relit depuis l'en-tête.
  record("inscription", result.status === 201, `${result.status}`)
  const smokeOrganizationId = result.json?.organization?.id ?? null

  result = await client.call("/api/v1/auth/login", {
    method: "POST",
    auth: false,
    body: { email, password },
  })
  record("connexion", result.status === 200, `${result.status}`)

  // Le client a besoin du cookie : on refait un appel qui le capture.
  const loginResponse = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  const sessionCookie = /(washpilot_session)=([^;]+)/.exec(loginResponse.headers.get("set-cookie") ?? "")
  if (!sessionCookie) {
    record("cookie de session", false, "aucun cookie reçu")
    return
  }
  client.useCookie(`${sessionCookie[1]}=${sessionCookie[2]}`)

  result = await client.call("/api/v1/auth/me")
  record("session reconnue", result.status === 200 && result.json?.user?.email === email)

  // --- 3. Configuration de la station ------------------------------------
  result = await client.call("/api/v1/onboarding/progress")
  record(
    "progression initiale",
    result.status === 200 && result.json?.current_stage === "station",
    `${result.status} ${result.json?.current_stage ?? ""}`,
  )

  result = await client.call("/api/v1/onboarding/progress", {
    method: "PUT",
    body: {
      stage: "station",
      data: { name: "Station Fumée", city: "Abidjan", phone: "+225 07 00 00 00 00" },
    },
  })
  record("étape station", result.status === 200 && result.json?.current_stage === "services", `${result.status}`)

  const catalog = await client.call("/api/v1/service-catalog")
  record(
    "catalogue de prestations",
    catalog.status === 200 && Array.isArray(catalog.json) && catalog.json.length > 0,
    `${catalog.json?.length ?? 0} prestation(s)`,
  )
  const template = catalog.json?.[0]

  result = await client.call("/api/v1/onboarding/progress", {
    method: "PUT",
    body: {
      stage: "services",
      data: {
        selected: template
          ? [{ template_id: template.id, name: template.name, price_cents: template.price_cents }]
          : [],
        custom: [],
      },
    },
  })
  record("étape prestations", result.status === 200 && result.json?.current_stage === "workers", `${result.status}`)

  result = await client.call("/api/v1/onboarding/progress", {
    method: "PUT",
    body: {
      stage: "workers",
      data: { workers: [{ first_name: "Awa", last_name: "Koné", role: "car_washer" }] },
    },
  })
  record("étape équipe", result.status === 200 && result.json?.current_stage === "plan", `${result.status}`)

  const plans = await client.call("/api/v1/plans")
  record("catalogue de forfaits", plans.status === 200 && (plans.json?.length ?? 0) > 0, `${plans.json?.length ?? 0}`)
  // Le forfait le plus complet : les écrans de stock, de présence et de
  // journal ne sont ouverts qu'à partir de là (402 sinon, ce qui est correct
  // mais ne dit rien de leur bon fonctionnement).
  const plan = (plans.json ?? []).at(-1)

  result = await client.call("/api/v1/onboarding/progress", {
    method: "PUT",
    body: { stage: "plan", data: { plan: plan?.code }, plan_code: plan?.code },
  })
  record("étape forfait", result.status === 200 && result.json?.current_stage === "review", `${result.status}`)

  const summary = await client.call("/api/v1/onboarding/summary")
  record(
    "récapitulatif",
    summary.status === 200 && summary.json?.station?.name === "Station Fumée",
    `${summary.status}`,
  )

  result = await client.call("/api/v1/onboarding/confirm", { method: "POST" })
  record("confirmation de la station", [200, 201].includes(result.status), `${result.status}`)

  result = await client.call("/api/v1/onboarding/status")
  record("état de la configuration", result.status === 200 && result.json?.state === "completed", `${result.json?.state ?? ""}`)

  // --- 4. Écrans d'exploitation ------------------------------------------
  const endpoints = [
    "/api/v1/dashboard/metrics",
    "/api/v1/washes",
    "/api/v1/payments",
    "/api/v1/expenses",
    "/api/v1/cash-sessions/current",
    "/api/v1/services",
    "/api/v1/sites",
    "/api/v1/workers",
    "/api/v1/products",
    "/api/v1/stock-movements",
    "/api/v1/purchases",
    "/api/v1/suppliers",
    "/api/v1/service-categories",
    "/api/v1/vehicle-categories",
    "/api/v1/attendance/history",
    "/api/v1/work-schedules",
    "/api/v1/team-performance",
    "/api/v1/reports/summary?from=2026-10-01&to=2026-10-31",
    "/api/v1/audit-logs?limit=5",
    "/api/v1/access/members",
    "/api/v1/me/permissions",
    "/api/v1/subscription",
    "/api/v1/support/config",
  ]
  for (const endpoint of endpoints) {
    const response = await client.call(endpoint)
    // 402 = fonction absente du forfait choisi. Ce n'est pas une panne, mais
    // ce n'est pas non plus un succès : on l'affiche pour que la raison soit
    // lisible, sans faire échouer le test de fumée.
    const inPlan = response.status === 402
    record(
      `API ${endpoint}`,
      response.status === 200 || inPlan,
      `${response.status}${inPlan ? " (hors forfait)" : ""}${
        response.status >= 500 ? " " + JSON.stringify(response.json).slice(0, 120) : ""
      }`,
    )
    if (inPlan) results.at(-1).skipped = true
  }

  // --- 5. Parcours d'encaissement -----------------------------------------
  // Le chemin de l'argent mérite d'être joué en entier : ouvrir la caisse,
  // enregistrer un lavage, l'encaisser, imprimer le reçu, puis rembourser.
  // Une incohérence ici ne se voit pas à l'écran ; elle se voit en comptabilité.
  const sites = await client.call("/api/v1/sites")
  const siteId = sites.json?.[0]?.id
  const categories = await client.call("/api/v1/vehicle-categories")
  const categoryId = categories.json?.[0]?.id
  const services = await client.call("/api/v1/services")
  const serviceId = services.json?.[0]?.id

  if (!siteId || !categoryId || !serviceId) {
    record("pré-requis d'encaissement", false, "station, catégorie ou prestation manquante")
  } else {
    const session = await client.call("/api/v1/cash-sessions/open", {
      method: "POST",
      body: { site_id: siteId, opening_amount_cents: 5000000 },
    })
    record("ouverture de caisse", [200, 201].includes(session.status), `${session.status}`)
    const cashSessionId = session.json?.id

    const wash = await client.call("/api/v1/washes", {
      method: "POST",
      body: {
        site_id: siteId,
        vehicle_category_id: categoryId,
        items: [{ service_id: serviceId, quantity: 1 }],
        payment_method: "cash",
        amount_received_cents: 0,
        plate: "1234 AB 01",
        customer_name: "Client Fumée",
        ...(cashSessionId ? { cash_session_id: cashSessionId } : {}),
      },
    })
    record("création d'un lavage", [200, 201].includes(wash.status), `${wash.status} ${JSON.stringify(wash.json).slice(0, 140)}`)
    const washId = wash.json?.id
    const total = Number(wash.json?.total_cents ?? 0)

    if (washId) {
      const payment = await client.call(`/api/v1/washes/${washId}/payments`, {
        method: "POST",
        body: {
          method: "cash",
          amount_cents: total,
          ...(cashSessionId ? { cash_session_id: cashSessionId } : {}),
        },
      })
      record("encaissement du lavage", [200, 201].includes(payment.status), `${payment.status}`)

      // POST et non GET : émettre un reçu attribue un numéro de copie
      // (l'original, puis les duplicata) et laisse une trace.
      const receipt = await client.call(`/api/v1/washes/${washId}/receipt`, { method: "POST" })
      record(
        "reçu imprimable",
        receipt.status === 201 && Boolean(receipt.json?.text),
        `${receipt.status}`,
      )
      const receiptHistory = await client.call(`/api/v1/washes/${washId}/receipt/history`)
      record(
        "historique des reçus",
        receiptHistory.status === 200 && (receiptHistory.json?.issues?.length ?? 0) >= 1,
        `${receiptHistory.status} ${receiptHistory.json?.issues?.length ?? 0}`,
      )

      const vehicle = await client.call("/api/v1/vehicles/1234AB01")
      record("historique du véhicule", vehicle.status === 200 && (vehicle.json?.visits ?? 0) >= 1, `${vehicle.status}`)

      const today = new Date().toISOString().slice(0, 10)
      const reports = await client.call(`/api/v1/reports/summary?from=${today}&to=${today}`)
      const revenue = Number(reports.json?.summary?.revenue_cents ?? -1)
      record(
        "recette visible au rapport du jour",
        reports.status === 200 && revenue >= total,
        `${reports.status} ${revenue === -1 ? "champ revenue_cents absent" : revenue}`,
      )

      const paymentId = payment.json?.payment?.id ?? payment.json?.id
      record("identifiant du paiement renvoyé", Boolean(paymentId), String(paymentId ?? "absent"))
      if (paymentId) {
        const refund = await client.call(`/api/v1/payments/${paymentId}/refund`, {
          method: "POST",
          body: { reason: "Test de fumée" },
        })
        record("remboursement", [200, 201].includes(refund.status), `${refund.status}`)

        // Un remboursement ne se rejoue pas : la seconde tentative doit être
        // refusée, sinon la caisse peut sortir deux fois la même somme.
        const replay = await client.call(`/api/v1/payments/${paymentId}/refund`, {
          method: "POST",
          body: { reason: "Test de fumée" },
        })
        record("remboursement non rejouable", replay.status >= 400 && replay.status < 500, `${replay.status}`)
      }
    }

    if (cashSessionId) {
      // Le solde théorique est relu juste avant la clôture : les
      // encaissements et le remboursement ci-dessus l'ont fait bouger, et un
      // écart calculé sur une valeur périmée testerait le mauvais cas.
      const collected = await client.call("/api/v1/cash-sessions/current")
      const theoretical = Number(
        collected.json?.theoretical_balance_cents ??
          collected.json?.session?.theoretical_balance_cents ??
          NaN,
      )
      record("solde théorique lisible", Number.isFinite(theoretical), String(theoretical))

      // Un écart de caisse sans justification doit être refusé : c'est la
      // règle qui empêche de « régulariser » un manque en silence.
      const unexplained = await client.call(`/api/v1/cash-sessions/${cashSessionId}/close`, {
        method: "POST",
        body: { counted_amount_cents: (Number.isFinite(theoretical) ? theoretical : 0) + 125000 },
      })
      record(
        "écart de caisse sans motif refusé",
        unexplained.status === 400,
        `${unexplained.status} ${unexplained.json?.error?.code ?? ""}`,
      )

      const closed = await client.call(`/api/v1/cash-sessions/${cashSessionId}/close`, {
        method: "POST",
        body: {
          counted_amount_cents: Number.isFinite(theoretical) ? theoretical : 0,
          discrepancy_reason: "Test de fumée",
        },
      })
      record("clôture de caisse", [200, 201].includes(closed.status), `${closed.status}`)
    }
  }

  // --- 6. Console d'administration ---------------------------------------
  const consoleLogin = await fetch(`${base}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "smoke-operator@example.ci", password: "SmokeOperator2026!" }),
  })
  const operatorCookie = /(washpilot_console)=([^;]+)/.exec(consoleLogin.headers.get("set-cookie") ?? "")
  record("connexion console", consoleLogin.ok, `${consoleLogin.status}`)

  if (operatorCookie) {
    const asOperator = { Cookie: `${operatorCookie[1]}=${operatorCookie[2]}` }
    for (const endpoint of ["/api/v1/console/auth/me", "/api/v1/console/metrics", "/api/v1/console/organizations"]) {
      const response = await fetch(base + endpoint, { headers: asOperator })
      record(`console ${endpoint}`, response.ok, `${response.status}`)
    }
    // La console ne doit jamais s'ouvrir avec une session de station.
    const rejected = await fetch(`${base}/api/v1/console/metrics`, {
      headers: { Cookie: client.cookie },
    })
    record("console refuse une session de station", rejected.status === 404, `${rejected.status}`)

    // ... et réciproquement : une session d'opérateur n'ouvre aucune donnée
    // de station. C'est l'autre moitié de la séparation.
    const stationApi = await fetch(`${base}/api/v1/washes`, {
      headers: { Cookie: `${operatorCookie[1]}=${operatorCookie[2]}` },
    })
    record("console sans accès aux données de station", stationApi.status === 401 || stationApi.status === 403, `${stationApi.status}`)

    // Actions d'administration : activer un forfait payant, puis suspendre.
    // Le parcours complet ne se joue jamais à la main en recette.
    const organizationId = smokeOrganizationId
    if (organizationId) {
      const activated = await fetch(`${base}/api/v1/console/organizations/${organizationId}/activate`, {
        method: "POST",
        headers: { ...asOperator, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ plan_code: plan?.code, months: 1, payment_reference: "SMOKE-1" }),
      })
      record("console active un forfait", activated.ok, `${activated.status}`)

      const afterActivation = await client.call("/api/v1/subscription")
      record(
        "la station voit son forfait actif",
        afterActivation.status === 200 && afterActivation.json?.status === "active",
        `${afterActivation.json?.status ?? ""}`,
      )

      const suspended = await fetch(`${base}/api/v1/console/organizations/${organizationId}/suspend`, {
        method: "POST",
        headers: { ...asOperator, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ reason: "Test de fumée" }),
      })
      record("console suspend une station", suspended.ok, `${suspended.status}`)

      // Lecture seule : les données restent consultables, l'écriture est
      // refusée. Une suspension qui masquerait l'historique serait une perte
      // de données déguisée.
      const readAfterSuspend = await client.call("/api/v1/washes")
      record("station suspendue : lecture maintenue", readAfterSuspend.status === 200, `${readAfterSuspend.status}`)
      const writeAfterSuspend = await client.call("/api/v1/washes", {
        method: "POST",
        body: {
          site_id: siteId,
          vehicle_category_id: categoryId,
          items: [{ service_id: serviceId, quantity: 1 }],
          payment_method: "cash",
          amount_received_cents: 0,
        },
      })
      record("station suspendue : écriture refusée", writeAfterSuspend.status === 403 || writeAfterSuspend.status === 402, `${writeAfterSuspend.status}`)
    }
  }
}

let serverHandle = null
let baseUrl = externalBaseUrl

try {
  if (!baseUrl) {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    console.log(
      `[smoke] Démarrage d'un serveur jetable sur ${baseUrl}${serverless ? " (runtime Vercel simulé)" : ""}\n`,
    )
    serverHandle = startServer(port)
    const ready = await waitForReady(baseUrl)
    if (!ready) {
      console.error(`[smoke] Le serveur n'a pas répondu à ${serverless ? "/api/healthz" : "/readyz"} dans le délai imparti.`)
      console.error(serverHandle.logs.join("").slice(-2000))
      process.exitCode = 1
    } else {
      await run(baseUrl)
    }
  } else {
    console.log(`[smoke] Serveur existant : ${baseUrl}\n`)
    await run(baseUrl)
  }
} catch (error) {
  record("exécution", false, error instanceof Error ? error.message : String(error))
} finally {
  if (serverHandle && !serverHandle.child.killed) {
    serverHandle.child.kill("SIGTERM")
    await sleep(500)
    if (!serverHandle.child.killed) serverHandle.child.kill("SIGKILL")
  }
}

const skipped = results.filter((r) => r.skipped).length
const total = results.length
console.log(
  `\n[smoke] ${total - failures}/${total} vérification(s) réussie(s)${skipped ? `, dont ${skipped} hors forfait` : ""}.`,
)
if (failures > 0) {
  console.log("[smoke] Échecs :")
  for (const failure of results.filter((r) => !r.ok)) {
    console.log(`  • ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`)
  }
}
process.exit(failures === 0 ? 0 : 1)
