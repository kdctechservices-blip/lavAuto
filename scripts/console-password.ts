/**
 * Définit ou réinitialise le mot de passe d'un opérateur de la console.
 *
 * Pourquoi un script : `PLATFORM_ADMIN_PASSWORD` ne sert qu'à l'amorçage — il
 * ne réécrit jamais un mot de passe existant (c'est volontaire, sinon un
 * fichier d'environnement oublié pourrait rouvrir un compte fermé). Sans cet
 * outil, changer le mot de passe d'un opérateur, ou en donner un à un compte
 * repris de l'ancien drapeau `platform_admin` (créé sans mot de passe),
 * demanderait d'écrire du SQL à la main.
 *
 * Usage :
 *   npm run console:password -- aduerwins@gmail.com
 *   npm run console:password -- aduerwins@gmail.com "MonNouveauMotDePasse"
 *
 * Sans mot de passe, un secret aléatoire est tiré et affiché une seule fois.
 * Arrêter le serveur avant de lancer la commande quand la base est la base
 * embarquée (PGlite) : un seul processus peut l'ouvrir à la fois.
 */
import "dotenv/config"

import { randomBytes } from "node:crypto"

import { hashPassword } from "../server/auth.ts"
import { closeDatabase, getPool, initDatabaseSchema } from "../server/db.ts"

/**
 * Longueur minimale identique à celle acceptée pour les comptes de station.
 * Un mot de passe d'opérateur ouvre le parc entier : le plancher est le même,
 * mais un secret long reste fortement recommandé.
 */
const MIN_LENGTH = 8

async function main(): Promise<void> {
  const [emailArg, passwordArg] = process.argv.slice(2)
  if (!emailArg) {
    console.error(
      "Usage : npm run console:password -- <email> [mot-de-passe]\n" +
        "Sans mot de passe, un secret est généré et affiché.",
    )
    process.exitCode = 1
    return
  }

  const email = emailArg.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`Adresse invalide : ${emailArg}`)
    process.exitCode = 1
    return
  }

  if (passwordArg !== undefined && passwordArg.length < MIN_LENGTH) {
    console.error(`Le mot de passe doit contenir au moins ${MIN_LENGTH} caractères.`)
    process.exitCode = 1
    return
  }

  // `initDatabaseSchema` est idempotent : il applique le schéma et réaligne les
  // opérateurs sur `PLATFORM_ADMIN_EMAILS`, exactement comme au démarrage.
  await initDatabaseSchema()
  const pool = getPool()
  if (!pool) {
    console.error("Base de données indisponible : vérifiez DATABASE_URL ou PGLITE_DATA_DIR.")
    process.exitCode = 1
    return
  }

  const generated = passwordArg === undefined
  const password = passwordArg ?? randomBytes(9).toString("base64url")
  const passwordHash = await hashPassword(password)

  const existing = await pool.query(
    "SELECT id FROM platform_operators WHERE email = $1",
    [email],
  )

  if (existing.rowCount) {
    await pool.query(
      `UPDATE platform_operators
       SET password_hash = $2, status = 'active', updated_at = now()
       WHERE email = $1`,
      [email, passwordHash],
    )
    // Une session ouverte avec l'ancien secret survivrait au changement :
    // on la coupe, comme le fait la désactivation d'un compte.
    await pool.query(
      `DELETE FROM platform_operator_sessions
       WHERE operator_id = (SELECT id FROM platform_operators WHERE email = $1)`,
      [email],
    )
    console.info(`[console] Mot de passe réinitialisé pour ${email}.`)
  } else {
    await pool.query(
      `INSERT INTO platform_operators(email, password_hash, full_name, status)
       VALUES ($1, $2, $3, 'active')`,
      [email, passwordHash, email.split("@")[0]],
    )
    console.info(`[console] Opérateur créé : ${email}.`)
  }

  if (generated) {
    console.info(`[console] Mot de passe provisoire : ${password}`)
    console.info("[console] Notez-le maintenant, il ne sera plus affiché.")
  }
  console.info("[console] Connexion : /console")
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error("Échec :", message)
    if (/lock|EACCES|EPERM|already/i.test(message)) {
      console.error("La base est peut-être encore ouverte : arrêtez le serveur puis relancez.")
    }
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDatabase().catch(() => {})
  })
