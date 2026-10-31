/**
 * Vérification des jetons JWT émis par Neon Auth.
 *
 * Le produit a sa propre authentification (e-mail + mot de passe, sessions
 * opaques en base — voir `server/auth.ts`). Ce module ajoute une **seconde
 * porte d'entrée**, sans la remplacer : un client qui présente un jeton signé
 * par Neon Auth (`Authorization: Bearer <jwt>`) est accepté, à condition que
 * son adresse corresponde à un compte existant.
 *
 * Trois choix méritent d'être explicites, parce qu'ils engagent la sécurité :
 *
 * 1. **Aucune dépendance.** `jose` ferait le travail, mais le projet n'a ni
 *    bibliothèque JWT ni envie d'en ajouter une pour lire trois champs. Tout
 *    se fait avec `node:crypto` : `createPublicKey({ format: "jwk" })` puis
 *    `verify`. La surface est petite, donc relisible.
 *
 * 2. **Pas de création de compte implicite.** Un jeton valide dont l'adresse
 *    ne correspond à aucun compte existant est refusé. Provisionner à la
 *    volée reviendrait à laisser le fournisseur d'identité créer des stations
 *    et des rôles — or le rôle et l'organisation ne sont pas dans le jeton.
 *
 * 3. **Rattachement conditionné à une adresse vérifiée.** Le premier jeton
 *    d'un utilisateur existant inscrit son `neon_auth_sub` sur son compte,
 *    mais seulement si Neon affirme `email_verified`. Sans cette condition,
 *    quiconque pourrait s'inscrire chez Neon avec l'adresse d'un gérant et
 *    reprendre son compte.
 *
 * Ce que le module ne fait pas : rafraîchir les jetons, gérer l'inscription,
 * ni contacter l'API Neon. Il ne lit que le JWKS public.
 */
import {
  createPublicKey,
  verify as verifySignature,
  constants,
  type JsonWebKeyInput,
  type KeyObject,
} from "node:crypto"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Variables lues pour activer la porte d'entrée. Vide = fonctionnalité éteinte. */
export interface NeonAuthEnvInput {
  NEON_AUTH_JWKS_URL?: string
  NEON_AUTH_ISSUER?: string
  NEON_AUTH_AUDIENCE?: string
}

export interface NeonAuthConfig {
  /** URL du JWKS public, telle que fournie par Neon. */
  jwksUrl: string
  /** Émetteur attendu (`iss`), déduit du JWKS quand il n'est pas fourni. */
  issuer: string
  /** Audience attendue (`aud`), ou `null` pour ne pas la contrôler. */
  audience: string | null
}

const JWKS_PATH = "/.well-known/jwks.json"

/**
 * Construit la configuration à partir de l'environnement, ou `null` si la
 * fonctionnalité est éteinte.
 *
 * L'émetteur Neon Auth est le dossier qui contient `.well-known/jwks.json` :
 * `https://<endpoint>/neondb/auth`. On le déduit de l'URL JWKS pour qu'une
 * seule variable suffise — une URL d'émetteur mal recopiée provoquerait des
 * 401 inexplicables, alors qu'ici les deux valeurs ne peuvent pas diverger.
 */
export function readNeonAuthConfig(input: NeonAuthEnvInput): NeonAuthConfig | null {
  const jwksUrl = (input.NEON_AUTH_JWKS_URL ?? "").trim().replace(/\/+$/, "")
  if (!jwksUrl) return null
  const declaredIssuer = (input.NEON_AUTH_ISSUER ?? "").trim().replace(/\/+$/, "")
  const issuer = declaredIssuer || (jwksUrl.endsWith(JWKS_PATH) ? jwksUrl.slice(0, -JWKS_PATH.length) : jwksUrl)
  const audience = (input.NEON_AUTH_AUDIENCE ?? "").trim() || null
  return { jwksUrl, issuer, audience }
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

export type NeonAuthErrorCode =
  | "token_malformed"
  | "unsupported_algorithm"
  | "key_not_found"
  | "invalid_signature"
  | "token_expired"
  | "token_not_yet_valid"
  | "invalid_issuer"
  | "invalid_audience"
  | "missing_subject"
  | "jwks_unavailable"

export class NeonAuthError extends Error {
  code: NeonAuthErrorCode
  constructor(code: NeonAuthErrorCode, message: string) {
    super(message)
    this.name = "NeonAuthError"
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Décodage
// ---------------------------------------------------------------------------

export interface DecodedJwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  /** Les deux premiers segments, tels quels : c'est ce qui est signé. */
  signingInput: string
  signature: Buffer
}

function parseJsonObject(segment: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
  } catch {
    throw new NeonAuthError("token_malformed", `Le jeton est illisible (${label}).`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NeonAuthError("token_malformed", `Le jeton est illisible (${label}).`)
  }
  return parsed as Record<string, unknown>
}

/** Un jeton JWT a exactement trois segments ; une session maison n'en a aucun. */
export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new NeonAuthError("token_malformed", "Le jeton n'a pas la forme d'un JWT.")
  }
  return {
    header: parseJsonObject(parts[0], "en-tête"),
    payload: parseJsonObject(parts[1], "charge utile"),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url"),
  }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

type SignatureKind = "rsa" | "rsa-pss" | "ec" | "eddsa"

interface AlgorithmSpec {
  kind: SignatureKind
  hash?: string
}

/**
 * Algorithmes acceptés. Volontairement **sans** `none` ni HMAC : un jeton
 * signé avec un secret partagé n'apporte rien ici, et `none` est la faille
 * classique des vérificateurs écrits à la main.
 */
const ALGORITHMS: Record<string, AlgorithmSpec> = {
  RS256: { kind: "rsa", hash: "sha256" },
  RS384: { kind: "rsa", hash: "sha384" },
  RS512: { kind: "rsa", hash: "sha512" },
  PS256: { kind: "rsa-pss", hash: "sha256" },
  PS384: { kind: "rsa-pss", hash: "sha384" },
  PS512: { kind: "rsa-pss", hash: "sha512" },
  ES256: { kind: "ec", hash: "sha256" },
  ES384: { kind: "ec", hash: "sha384" },
  ES512: { kind: "ec", hash: "sha512" },
  EdDSA: { kind: "eddsa" },
}

export type JwkKey = Record<string, unknown> & { kty?: string; kid?: string; alg?: string; use?: string }

function isJwkKey(value: unknown): value is JwkKey {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Vérifie la signature avec la clé publique du JWKS.
 *
 * `dsaEncoding: "ieee-p1363"` est indispensable pour ECDSA : JOSE concatène
 * `r` et `s` sur une longueur fixe, là où Node attend par défaut un encodage
 * DER. Sans cette option, tout jeton ES256 valide serait rejeté.
 */
export function verifySignatureForJwk(
  jwk: JwkKey,
  alg: string,
  signingInput: string,
  signature: Buffer,
): boolean {
  const spec = ALGORITHMS[alg]
  if (!spec) throw new NeonAuthError("unsupported_algorithm", `Algorithme « ${alg} » non pris en charge.`)

  let key: KeyObject
  try {
    key = createPublicKey({ key: jwk as unknown as JsonWebKeyInput["key"], format: "jwk" })
  } catch {
    throw new NeonAuthError("key_not_found", "La clé publique du JWKS est inexploitable.")
  }

  const data = Buffer.from(signingInput, "utf8")
  try {
    switch (spec.kind) {
      case "rsa":
        return verifySignature(spec.hash as string, data, key, signature)
      case "rsa-pss":
        return verifySignature(
          spec.hash as string,
          data,
          { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
          signature,
        )
      case "ec":
        return verifySignature(spec.hash as string, data, { key, dsaEncoding: "ieee-p1363" }, signature)
      case "eddsa":
        return verifySignature(null, data, key, signature)
    }
  } catch {
    // Une signature de mauvaise longueur fait lever `verify` : c'est un refus.
    return false
  }
  return false
}

function pickKey(keys: JwkKey[], kid: string, alg: string): JwkKey | null {
  const usable = keys.filter((key) => {
    const keyAlg = typeof key.alg === "string" ? key.alg : ""
    if (keyAlg && keyAlg !== alg) return false
    const use = typeof key.use === "string" ? key.use : ""
    return !use || use === "sig"
  })
  if (kid) return usable.find((key) => key.kid === kid) ?? null
  // Sans `kid`, accepter revient à deviner : on ne le fait que s'il n'y a
  // qu'une seule clé de signature, cas d'un JWKS mono-clé.
  return usable.length === 1 ? usable[0] : null
}

// ---------------------------------------------------------------------------
// Vérificateur
// ---------------------------------------------------------------------------

export interface VerifiedNeonIdentity {
  /** Identifiant stable chez Neon (`sub`). */
  subject: string
  email: string | null
  emailVerified: boolean
  claims: Record<string, unknown>
}

export interface NeonAuthVerifierOptions {
  /** Injectable pour les tests : aucun appel réseau réel. */
  fetchImpl?: typeof fetch
  /** Injectable pour les tests : horloge fixe. */
  now?: () => number
  cacheTtlMs?: number
  clockToleranceSeconds?: number
  timeoutMs?: number
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60
const FETCH_TIMEOUT_MS = 5_000
/** Fenêtre pendant laquelle un `kid` inconnu ne redéclenche pas de requête. */
const REFRESH_COOLDOWN_MS = 30_000

export class NeonAuthVerifier {
  private config: NeonAuthConfig
  private options: NeonAuthVerifierOptions
  private cachedKeys: JwkKey[] = []
  private cachedAt = 0
  private pending: Promise<JwkKey[]> | null = null

  constructor(config: NeonAuthConfig, options: NeonAuthVerifierOptions = {}) {
    this.config = config
    this.options = options
  }

  /** Vérifie la signature et les revendications ; lève `NeonAuthError` sinon. */
  async verify(token: string): Promise<VerifiedNeonIdentity> {
    const decoded = decodeJwt(token)
    const alg = typeof decoded.header.alg === "string" ? decoded.header.alg : ""
    if (!ALGORITHMS[alg]) {
      throw new NeonAuthError("unsupported_algorithm", `Algorithme « ${alg || "absent"} » refusé.`)
    }
    const kid = typeof decoded.header.kid === "string" ? decoded.header.kid : ""

    let key = pickKey(await this.loadKeys(), kid, alg)
    if (!key) {
      // Rotation de clés : le JWKS a pu changer depuis le dernier cache.
      key = pickKey(await this.loadKeys(true), kid, alg)
    }
    if (!key) {
      throw new NeonAuthError("key_not_found", "Aucune clé du JWKS ne correspond à ce jeton.")
    }
    if (!verifySignatureForJwk(key, alg, decoded.signingInput, decoded.signature)) {
      throw new NeonAuthError("invalid_signature", "La signature du jeton est invalide.")
    }
    return this.validateClaims(decoded.payload)
  }

  private validateClaims(payload: Record<string, unknown>): VerifiedNeonIdentity {
    const nowSeconds = Math.floor((this.options.now?.() ?? Date.now()) / 1000)
    const tolerance = this.options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS

    if (typeof payload.exp !== "number") {
      throw new NeonAuthError("token_expired", "Le jeton ne porte pas de date d'expiration.")
    }
    if (nowSeconds > payload.exp + tolerance) {
      throw new NeonAuthError("token_expired", "Le jeton a expiré.")
    }
    if (typeof payload.nbf === "number" && nowSeconds + tolerance < payload.nbf) {
      throw new NeonAuthError("token_not_yet_valid", "Le jeton n'est pas encore valide.")
    }

    const issuer = typeof payload.iss === "string" ? payload.iss : ""
    if (this.config.issuer && issuer !== this.config.issuer) {
      throw new NeonAuthError("invalid_issuer", `Émetteur inattendu : ${issuer || "(absent)"}.`)
    }

    if (this.config.audience) {
      const audiences = Array.isArray(payload.aud)
        ? payload.aud.filter((value): value is string => typeof value === "string")
        : typeof payload.aud === "string"
          ? [payload.aud]
          : []
      if (!audiences.includes(this.config.audience)) {
        throw new NeonAuthError("invalid_audience", "Ce jeton n'est pas destiné à cette application.")
      }
    }

    const subject = typeof payload.sub === "string" ? payload.sub.trim() : ""
    if (!subject) throw new NeonAuthError("missing_subject", "Le jeton ne porte pas de sujet.")

    const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null
    const emailVerified = payload.email_verified === true || payload.email_verified === "true"

    return { subject, email, emailVerified, claims: payload }
  }

  private async loadKeys(force = false): Promise<JwkKey[]> {
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    const fresh = this.cachedKeys.length > 0 && now - this.cachedAt < ttl

    if (fresh && !force) return this.cachedKeys
    // Un `kid` inconnu ne doit pas pouvoir transformer chaque requête en
    // requête sortante vers Neon : on réutilise le cache pendant la fenêtre.
    if (this.cachedKeys.length > 0 && now - this.cachedAt < REFRESH_COOLDOWN_MS) return this.cachedKeys
    if (this.pending) return this.pending

    this.pending = this.fetchKeys(now).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async fetchKeys(now: number): Promise<JwkKey[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS
    try {
      const response = await fetchImpl(this.config.jwksUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        throw new NeonAuthError("jwks_unavailable", `JWKS inaccessible (HTTP ${response.status}).`)
      }
      const body = (await response.json()) as { keys?: unknown }
      const keys = Array.isArray(body.keys) ? body.keys.filter(isJwkKey) : []
      if (keys.length === 0) {
        throw new NeonAuthError("jwks_unavailable", "Le JWKS ne contient aucune clé exploitable.")
      }
      this.cachedKeys = keys
      this.cachedAt = now
      return keys
    } catch (error) {
      // Panne passagère de Neon : mieux vaut vérifier avec des clés déjà
      // connues que fermer la porte à tout le monde. Une clé inconnue, elle,
      // n'a pas de secours — elle sera refusée plus haut.
      if (this.cachedKeys.length > 0) return this.cachedKeys
      if (error instanceof NeonAuthError) throw error
      throw new NeonAuthError("jwks_unavailable", "JWKS injoignable.")
    }
  }
}
