/**
 * Base PostgreSQL locale de développement (binaires embarqués via npm).
 * Usage : node scripts/local-db.mjs
 * Expose postgres://postgres:postgres@127.0.0.1:5433/washpilot
 *
 * Les données vivent dans ~/.cache/washpilot-pg (hors du dépôt Git).
 */
import EmbeddedPostgres from "embedded-postgres"
import { existsSync } from "node:fs"
import { join } from "node:path"
import os from "node:os"

const databaseDir = join(os.homedir(), ".cache", "washpilot-pg")
const alreadyInitialised = existsSync(join(databaseDir, "PG_VERSION"))

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: "postgres",
  port: 5433,
  persistent: true,
})

if (!alreadyInitialised) {
  console.log("[local-db] Initialisation du cluster PostgreSQL…")
  await pg.initialise()
}

await pg.start()

try {
  await pg.createDatabase("washpilot")
  console.log("[local-db] Base 'washpilot' créée.")
} catch {
  console.log("[local-db] Base 'washpilot' déjà présente.")
}

console.log("[local-db] PostgreSQL prêt sur postgres://postgres:postgres@127.0.0.1:5433/washpilot")

const shutdown = async (signal) => {
  console.log(`[local-db] ${signal} reçu, arrêt de PostgreSQL…`)
  try {
    await pg.stop()
  } finally {
    process.exit(0)
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

// Keep the supervisor process alive while postgres runs.
await new Promise(() => {})
