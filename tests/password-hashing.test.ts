import { scryptSync } from "node:crypto"
import test from "node:test"
import assert from "node:assert/strict"
import { Algorithm, Version, hash as argon2Hash } from "@node-rs/argon2"
import { hashPassword, needsPasswordRehash, verifyPassword } from "../server/auth.ts"

const LEGACY_PASSWORD = "AncienSecret-2024"
const LEGACY_SALT = Buffer.from("00112233445566778899aabbccddeeff", "hex")
const LEGACY_SCRYPT_HASH = `scrypt:${LEGACY_SALT.toString("hex")}:${scryptSync(LEGACY_PASSWORD, LEGACY_SALT, 64).toString("hex")}`

test("les nouveaux mots de passe sont stockés en Argon2id avec la politique courante", async () => {
  const stored = await hashPassword("UnSecretFort-2026")

  assert.match(stored, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  assert.equal(await verifyPassword("UnSecretFort-2026", stored), true)
  assert.equal(await verifyPassword("mauvais mot de passe", stored), false)
  assert.equal(needsPasswordRehash(stored), false)
})

test("les empreintes scrypt historiques restent vérifiables et sont marquées pour migration", async () => {
  assert.equal(await verifyPassword(LEGACY_PASSWORD, LEGACY_SCRYPT_HASH), true)
  assert.equal(await verifyPassword("mauvais mot de passe", LEGACY_SCRYPT_HASH), false)
  assert.equal(needsPasswordRehash(LEGACY_SCRYPT_HASH), true)
})

test("une empreinte Argon2id faible est acceptée puis marquée pour rehash", async () => {
  const weakHash = await argon2Hash("MotDePasseHistorique", {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: 8_192,
    timeCost: 1,
    parallelism: 1,
    outputLen: 32,
  })

  assert.equal(await verifyPassword("MotDePasseHistorique", weakHash), true)
  assert.equal(needsPasswordRehash(weakHash), true)
})

test("les formats inconnus ou malformés échouent sans lever d'erreur", async () => {
  assert.equal(await verifyPassword("secret", null), false)
  assert.equal(await verifyPassword("secret", "bcrypt:not-a-real-hash"), false)
  assert.equal(await verifyPassword("secret", "$argon2id$not-a-valid-phc"), false)
})
