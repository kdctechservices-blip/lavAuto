import test, { after, before, describe } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import type { Pool } from "pg"
import {
  NeonAuthError,
  NeonAuthVerifier,
  decodeJwt,
  looksLikeJwt,
  readNeonAuthConfig,
  verifySignatureForJwk,
} from "../server/neon-auth.ts"

// ---------------------------------------------------------------------------
// Vérification des jetons Neon Auth
//
// Les clés sont générées à la volée et signent des jetons fabriqués ici : le
// test prouve la vérification, pas la disponibilité de Neon. Aucun appel
// réseau réel n'a lieu dans les tests unitaires (le `fetch` est injecté) ;
// seul le test de bout en bout passe par un vrai serveur HTTP local, pour
// couvrir le chemin complet JWKS → vérification → session.
// ---------------------------------------------------------------------------

const ISSUER = "https://ep-test.neonauth.example/neondb/auth"
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
const AUDIENCE = "washpilot"
const FIXED_NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

interface TestKey {
  kid: string
  alg: string
  privateKey: KeyObject
  publicJwk: Record<string, unknown>
}

function makeKey(kind: "rsa" | "ec" | "ed25519", kid: string): TestKey {
  if (kind === "rsa") {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
    return {
      kid,
      alg: "RS256",
      privateKey: pair.privateKey,
      publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
    }
  }
  if (kind === "ec") {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
    return {
      kid,
      alg: "ES256",
      privateKey: pair.privateKey,
      publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" },
    }
  }
  const pair = generateKeyPairSync("ed25519")
  return {
    kid,
    alg: "EdDSA",
    privateKey: pair.privateKey,
    publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" },
  }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function signToken(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const signingInput = `${base64url({ alg: key.alg, typ: "JWT", kid: key.kid, ...header })}.${base64url(claims)}`
  const data = Buffer.from(signingInput, "utf8")
  const signature =
    key.alg === "ES256"
      ? cryptoSign("sha256", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" })
      : key.alg === "EdDSA"
        ? cryptoSign(null, data, key.privateKey)
        : cryptoSign("sha256", data, key.privateKey)
  return `${signingInput}.${signature.toString("base64url")}`
}

function claimsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(FIXED_NOW / 1000)
  return {
    sub: "neon-user-1",
    email: "awa@example.ci",
    email_verified: true,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 900,
    ...overrides,
  }
}

function jsonFetch(keys: () => unknown[], status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ keys: keys() }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

function verifierWith(
  keys: TestKey[],
  options: { audience?: string | null; now?: () => number; fetchImpl?: typeof fetch } = {},
): NeonAuthVerifier {
  return new NeonAuthVerifier(
    { jwksUrl: JWKS_URL, issuer: ISSUER, audience: options.audience === undefined ? AUDIENCE : options.audience },
    {
      fetchImpl: options.fetchImpl ?? jsonFetch(() => keys.map((key) => key.publicJwk)),
      now: options.now ?? (() => FIXED_NOW),
    },
  )
}

async function expectRefusal(promise: Promise<unknown>, code: NeonAuthError["code"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof NeonAuthError, `erreur NeonAuthError attendue, reçu ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("la configuration est éteinte sans URL de JWKS", () => {
  assert.equal(readNeonAuthConfig({}), null)
  assert.equal(readNeonAuthConfig({ NEON_AUTH_JWKS_URL: "   " }), null)
})

test("l'émetteur est déduit du JWKS, sans slash final", () => {
  const config = readNeonAuthConfig({ NEON_AUTH_JWKS_URL: `${JWKS_URL}/` })
  assert.ok(config)
  assert.equal(config.issuer, ISSUER)
  assert.equal(config.jwksUrl, JWKS_URL)
  assert.equal(config.audience, null)
})

test("un émetteur déclaré explicitement n'est pas écrasé", () => {
  const config = readNeonAuthConfig({ NEON_AUTH_JWKS_URL: JWKS_URL, NEON_AUTH_ISSUER: "https://other.example/auth" })
  assert.equal(config?.issuer, "https://other.example/auth")
})

test("une URL de JWKS nue ne fabrique pas d'émetteur absurde", () => {
  const config = readNeonAuthConfig({ NEON_AUTH_JWKS_URL: "https://host/neondb/auth" })
  assert.equal(config?.issuer, "https://host/neondb/auth")
})

// ---------------------------------------------------------------------------
// Décodage
// ---------------------------------------------------------------------------

test("seul un jeton à trois segments est un JWT", () => {
  assert.equal(looksLikeJwt("a.b.c"), true)
  assert.equal(looksLikeJwt("session-opaque-sans-point"), false)
  assert.equal(looksLikeJwt("a.b"), false)
  assert.equal(looksLikeJwt("a.b.c.d"), false)
})

test("un jeton illisible est refusé proprement", async () => {
  await expectRefusal(Promise.resolve().then(() => decodeJwt("pas-un-jwt")), "token_malformed")
  await expectRefusal(
    Promise.resolve().then(() => decodeJwt(`${base64url({ alg: "RS256" })}.${base64url(claimsFor())}.`)),
    "token_malformed",
  )
})

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

test("un jeton RS256 valide est accepté et rend l'identité", async () => {
  const key = makeKey("rsa", "rsa-1")
  const identity = await verifierWith([key]).verify(signToken(key, claimsFor()))
  assert.equal(identity.subject, "neon-user-1")
  assert.equal(identity.email, "awa@example.ci")
  assert.equal(identity.emailVerified, true)
})

test("un jeton ES256 valide est accepté", async () => {
  const key = makeKey("ec", "ec-1")
  const identity = await verifierWith([key]).verify(signToken(key, claimsFor()))
  assert.equal(identity.subject, "neon-user-1")
})

test("un jeton EdDSA valide est accepté", async () => {
  const key = makeKey("ed25519", "ed-1")
  const identity = await verifierWith([key]).verify(signToken(key, claimsFor()))
  assert.equal(identity.subject, "neon-user-1")
})

test("une signature produite par une autre clé est rejetée", async () => {
  const published = makeKey("rsa", "rsa-1")
  const attacker = makeKey("rsa", "rsa-1")
  await expectRefusal(verifierWith([published]).verify(signToken(attacker, claimsFor())), "invalid_signature")
})

test("un algorithme « none » ou symétrique est refusé", async () => {
  const key = makeKey("rsa", "rsa-1")
  // Signature factice non vide : sinon le jeton est rejeté plus tôt, faute de
  // signature du tout (`token_malformed`), et l'algorithme n'est pas évalué.
  const unsigned = `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claimsFor())}.${Buffer.from("x").toString("base64url")}`
  await expectRefusal(verifierWith([key]).verify(unsigned), "unsupported_algorithm")

  const hmac = makeKey("rsa", "rsa-1")
  const hmacToken = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claimsFor())}.${Buffer.from("x").toString("base64url")}`
  await expectRefusal(verifierWith([hmac]).verify(hmacToken), "unsupported_algorithm")
})

test("une clé annoncée par le JWKS mais inexploitable est refusée", async () => {
  const key = makeKey("rsa", "rsa-1")
  const broken = new NeonAuthVerifier(
    { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE },
    { fetchImpl: jsonFetch(() => [{ kty: "RSA", kid: "rsa-1", alg: "RS256" }]), now: () => FIXED_NOW },
  )
  await assert.rejects(broken.verify(signToken(key, claimsFor())), (error: unknown) => {
    assert.ok(error instanceof NeonAuthError)
    assert.ok(["key_not_found", "invalid_signature"].includes(error.code))
    return true
  })
})

test("vérifier une signature hors algorithme connu lève une erreur explicite", () => {
  const key = makeKey("rsa", "rsa-1")
  assert.throws(
    () => verifySignatureForJwk(key.publicJwk, "HS256", "a.b", Buffer.from("sig")),
    (error: unknown) => error instanceof NeonAuthError && error.code === "unsupported_algorithm",
  )
})

// ---------------------------------------------------------------------------
// Revendications
// ---------------------------------------------------------------------------

test("un jeton expiré est refusé", async () => {
  const key = makeKey("rsa", "rsa-1")
  const now = Math.floor(FIXED_NOW / 1000)
  await expectRefusal(
    verifierWith([key]).verify(signToken(key, claimsFor({ exp: now - 120 }))),
    "token_expired",
  )
})

test("un jeton sans expiration est refusé", async () => {
  const key = makeKey("rsa", "rsa-1")
  const claims = claimsFor()
  delete claims.exp
  await expectRefusal(verifierWith([key]).verify(signToken(key, claims)), "token_expired")
})

test("un jeton pas encore valide est refusé", async () => {
  const key = makeKey("rsa", "rsa-1")
  const now = Math.floor(FIXED_NOW / 1000)
  await expectRefusal(
    verifierWith([key]).verify(signToken(key, claimsFor({ nbf: now + 600 }))),
    "token_not_yet_valid",
  )
})

test("un autre émetteur est refusé", async () => {
  const key = makeKey("rsa", "rsa-1")
  await expectRefusal(
    verifierWith([key]).verify(signToken(key, claimsFor({ iss: "https://evil.example/auth" }))),
    "invalid_issuer",
  )
})

test("une autre audience est refusée, et l'absence d'audience exigée aussi", async () => {
  const key = makeKey("rsa", "rsa-1")
  const verifier = verifierWith([key])
  await expectRefusal(verifier.verify(signToken(key, claimsFor({ aud: "autre-app" }))), "invalid_audience")
  const claims = claimsFor()
  delete claims.aud
  await expectRefusal(verifier.verify(signToken(key, claims)), "invalid_audience")
})

test("une audience multiple est acceptée si elle contient la nôtre", async () => {
  const key = makeKey("rsa", "rsa-1")
  const identity = await verifierWith([key]).verify(signToken(key, claimsFor({ aud: ["autre", AUDIENCE] })))
  assert.equal(identity.subject, "neon-user-1")
})

test("sans audience configurée, le champ n'est pas contrôlé", async () => {
  const key = makeKey("rsa", "rsa-1")
  const identity = await verifierWith([key], { audience: null }).verify(
    signToken(key, claimsFor({ aud: "n-importe-quoi" })),
  )
  assert.equal(identity.subject, "neon-user-1")
})

test("un jeton sans sujet est refusé", async () => {
  const key = makeKey("rsa", "rsa-1")
  await expectRefusal(verifierWith([key]).verify(signToken(key, claimsFor({ sub: "  " }))), "missing_subject")
})

test("une adresse non vérifiée est signalée comme telle", async () => {
  const key = makeKey("rsa", "rsa-1")
  const identity = await verifierWith([key]).verify(signToken(key, claimsFor({ email_verified: false })))
  assert.equal(identity.emailVerified, false)
})

// ---------------------------------------------------------------------------
// Cache de clés
// ---------------------------------------------------------------------------

test("un kid inconnu déclenche une relecture du JWKS (rotation de clés)", async () => {
  const oldKey = makeKey("rsa", "rsa-old")
  const newKey = makeKey("rsa", "rsa-new")
  let served: TestKey[] = [oldKey]
  let fetches = 0
  let clock = FIXED_NOW
  const verifier = new NeonAuthVerifier(
    { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE },
    {
      now: () => clock,
      fetchImpl: (async () => {
        fetches += 1
        return new Response(JSON.stringify({ keys: served.map((key) => key.publicJwk) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch,
    },
  )

  await verifier.verify(signToken(oldKey, claimsFor()))
  assert.equal(fetches, 1)

  served = [oldKey, newKey]
  // La fenêtre anti-rafale empêche une relecture immédiate : on avance
  // l'horloge comme le ferait le temps réel.
  clock += 60_000
  const identity = await verifier.verify(signToken(newKey, claimsFor({ sub: "neon-user-2" })))
  assert.equal(identity.subject, "neon-user-2")
  assert.equal(fetches, 2)

  // Clé déjà connue : plus aucune requête sortante.
  clock += 60_000
  await verifier.verify(signToken(oldKey, claimsFor()))
  assert.equal(fetches, 2)
})

test("un kid inconnu ne provoque pas une requête par jeton", async () => {
  const key = makeKey("rsa", "rsa-1")
  const stranger = makeKey("rsa", "rsa-inexistante")
  let fetches = 0
  const verifier = new NeonAuthVerifier(
    { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE },
    {
      now: () => FIXED_NOW,
      fetchImpl: (async () => {
        fetches += 1
        return new Response(JSON.stringify({ keys: [key.publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch,
    },
  )
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectRefusal(verifier.verify(signToken(stranger, claimsFor())), "key_not_found")
  }
  assert.equal(fetches, 1)
})

test("un JWKS en panne n'ouvre aucune porte", async () => {
  const key = makeKey("rsa", "rsa-1")
  const verifier = new NeonAuthVerifier(
    { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE },
    { fetchImpl: jsonFetch(() => [], 503), now: () => FIXED_NOW },
  )
  await expectRefusal(verifier.verify(signToken(key, claimsFor())), "jwks_unavailable")
})

// ---------------------------------------------------------------------------
// Bout en bout : vraie requête HTTP, vrai serveur JWKS, vraie session
// ---------------------------------------------------------------------------

const e2eKey = makeKey("rsa", "e2e-rsa")

describe("bout en bout : JWKS HTTP réel et session applicative", () => {
  let jwksServer: Server
  let appServer: Server
  let baseUrl = ""
  let jwksUrl = ""
  /** Émetteur déduit par l'application à partir de l'URL du JWKS local. */
  let e2eIssuer = ""
  let pool: Pool
  let closeDatabase: () => Promise<void>

  let neonUser: { id: string; email: string }
  let plainUser: { id: string; email: string }

  before(async () => {
    // Le serveur JWKS tourne avant l'import du serveur applicatif : `env` est lu
    // à l'import, il doit donc déjà connaître l'URL.
    jwksServer = http.createServer((req, res) => {
      if (req.url?.endsWith("/.well-known/jwks.json")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ keys: [e2eKey.publicJwk] }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve))
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/neondb/auth/.well-known/jwks.json`
    // L'application déduit l'émetteur de l'URL JWKS : c'est lui qu'il faut
    // annoncer dans les jetons, pas la constante d'exemple des tests unitaires.
    e2eIssuer = jwksUrl.slice(0, -"/.well-known/jwks.json".length)

    process.env.NEON_AUTH_JWKS_URL = jwksUrl
    process.env.NEON_AUTH_AUDIENCE = AUDIENCE

    const db = await import("../server/db.ts")
    const { createApiApp } = await import("../server/app.ts")
    closeDatabase = db.closeDatabase

    assert.ok(await db.initDatabaseSchema(), "base de test initialisée")
    pool = db.getPool() as Pool

    const org = await pool.query(
      "INSERT INTO organizations(name, slug, onboarding_completed) VALUES('Station Neon Auth','station-neon-auth',true) RETURNING id",
    )
    const organizationId = org.rows[0].id as string

    const neon = await pool.query(
      "INSERT INTO users(email, first_name, last_name, status, organization_id) VALUES('neon.owner@example.ci','Nora','Zadi','active',$1) RETURNING id",
      [organizationId],
    )
    neonUser = { id: neon.rows[0].id as string, email: "neon.owner@example.ci" }
    await pool.query("INSERT INTO organization_members(organization_id, user_id, role) VALUES($1,$2,'owner')", [
      organizationId,
      neonUser.id,
    ])

    const plain = await pool.query(
      "INSERT INTO users(email, first_name, last_name, status, organization_id) VALUES('mot.de.passe@example.ci','Paul','Koffi','active',$1) RETURNING id",
      [organizationId],
    )
    plainUser = { id: plain.rows[0].id as string, email: "mot.de.passe@example.ci" }
    await pool.query("INSERT INTO organization_members(organization_id, user_id, role) VALUES($1,$2,'cashier')", [
      organizationId,
      plainUser.id,
    ])

    appServer = http.createServer(createApiApp())
    await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve))
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
  })

  after(async () => {
    // Les connexions keep-alive de `fetch` maintiendraient `close()` en
    // attente indéfiniment : on les coupe avant de fermer. Et si le `before`
    // a échoué, les serveurs n'existent pas : une promesse qui attend un
    // `close()` jamais appelé bloquerait tout le fichier de tests.
    const closeServer = async (server?: Server) => {
      if (!server?.listening) return
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await closeServer(appServer)
    await closeServer(jwksServer)
    await closeDatabase?.()
  })

  /**
   * Jeton de bout en bout daté sur l'horloge réelle : le vérificateur de
   * l'application n'utilise pas l'horloge figée des tests unitaires, et un
   * jeton daté de 2026-01-01 serait, à juste titre, expiré.
   */
  function tokenFor(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000)
    return signToken(e2eKey, claimsFor({ iss: e2eIssuer, aud: AUDIENCE, iat: now, exp: now + 900, ...claims }))
  }

  async function me(token: string): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
  }

  test("un jeton Neon Auth ouvre une session sur un compte existant", async () => {
    const response = await me(tokenFor({ sub: "neon-sub-owner", email: neonUser.email }))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { user: { id: string; email: string } }
    assert.equal(body.user.id, neonUser.id)
    assert.equal(body.user.email, neonUser.email)

    const linked = await pool.query("SELECT neon_auth_sub FROM users WHERE id = $1", [neonUser.id])
    assert.equal(linked.rows[0].neon_auth_sub, "neon-sub-owner")
  })

  test("le jeton de session maison reste valable pour un compte sans Neon Auth", async () => {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "demo@washpilot.ci", password: "WashPilot2026!" }),
    })
    assert.equal(response.status, 200)
    const { session_token: token } = (await response.json()) as { session_token: string }
    assert.equal(looksLikeJwt(token), false, "un jeton de session maison n'est pas un JWT")

    const meResponse = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: `washpilot_session=${token}` } })
    assert.equal(meResponse.status, 200)
  })

  test("une adresse inconnue est refusée : aucun compte n'est créé", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM users")
    const response = await me(tokenFor({ sub: "inconnu", email: "inconnu@example.ci" }))
    assert.equal(response.status, 401)
    const after = await pool.query("SELECT count(*)::int AS n FROM users")
    assert.equal(after.rows[0].n, before.rows[0].n)
  })

  test("un compte non rattaché à Neon ne prend pas la main sur une adresse non vérifiée", async () => {
    const response = await me(
      tokenFor({ sub: "sub-pretendant", email: plainUser.email, email_verified: false }),
    )
    assert.equal(response.status, 401)
  })

  test("une adresse déjà rattachée à un autre sujet est refusée", async () => {
    const response = await me(tokenFor({ sub: "sub-usurpateur", email: neonUser.email }))
    assert.equal(response.status, 401)
  })

  test("un jeton à la signature invalide est refusé par l'API", async () => {
    const forged = makeKey("rsa", "e2e-rsa")
    const response = await me(signToken(forged, claimsFor({ iss: ISSUER, aud: AUDIENCE, email: neonUser.email })))
    assert.equal(response.status, 401)
  })

  test("un JWT présenté quand Neon Auth est éteint n'ouvre rien", async () => {
    // Le vérificateur global est configuré pour ce fichier ; on prouve ici le
    // comportement de repli d'un déploiement sans Neon Auth.
    const { readNeonAuthConfig } = await import("../server/neon-auth.ts")
    assert.equal(readNeonAuthConfig({ NEON_AUTH_JWKS_URL: "" }), null)
  })
})
