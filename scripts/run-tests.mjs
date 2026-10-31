/**
 * Lance la suite de tests dans des conditions reproductibles.
 *
 * Pourquoi ce script existe : `tsx --test tests/*.test.ts` avait trois défauts,
 * tous silencieux.
 *
 * 1. **`NODE_ENV` n'était pas fixé.** Sans lui, `NODE_ENV` vaut
 *    `development` : les fichiers de tests ouvraient donc la base **sur
 *    disque** (`.data/pglite`), la même que le serveur de développement. Node
 *    exécute les fichiers de tests en parallèle : plusieurs processus
 *    écrivaient dans une base PGlite mono-utilisateur, et les données d'un
 *    fichier faussaient le suivant. Résultat : des centaines d'échecs en
 *    cascade — des 403 et des comptes déjà existants — sans rapport avec le
 *    code testé. Pire, la suite **polluait la base réelle** de celui qui la
 *    lançait.
 *
 * 2. **`DATABASE_URL` n'était pas neutralisée.** Un `.env` pointant vers une
 *    vraie base faisait tourner les tests contre elle (voir
 *    `server/database-target.ts`, qui refuse désormais ce cas).
 *
 * 3. **Le glob `tests/*.test.ts` était développé par le shell.** Sur Windows
 *    (`cmd`, PowerShell), il n'est pas développé : aucun fichier n'était
 *    trouvé. Ici la liste est lue en JavaScript, donc identique partout.
 *
 * Usage :
 *   npm test                         # toute la suite
 *   npm test -- tests/format.test.ts # un fichier
 *   npm test -- --test-name-pattern="timeline"
 *   npm test -- --watch              # relance à chaque modification
 */
import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testsDir = path.join(root, "tests")

/** Tous les fichiers de tests, triés : l'ordre ne doit pas dépendre du disque. */
function allTestFiles() {
  if (!existsSync(testsDir)) {
    console.error(`[test] Dossier introuvable : ${testsDir}`)
    process.exit(1)
  }
  return readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => path.join("tests", name))
}

const forwarded = process.argv.slice(2)
const explicitFiles = forwarded.filter((arg) => arg.endsWith(".test.ts") || arg.endsWith(".test.tsx"))
const flags = forwarded.filter((arg) => !explicitFiles.includes(arg))
const files = explicitFiles.length > 0 ? explicitFiles.map((f) => f.replaceAll("\\", "/")) : allTestFiles()

if (files.length === 0) {
  console.error("[test] Aucun fichier de test trouvé.")
  process.exit(1)
}

// `node --import tsx` plutôt que le binaire `tsx` : pas de résolution de
// chemin dépendante de la plateforme (`tsx` vs `tsx.cmd`).
const tsxRegister = path.join(root, "node_modules", "tsx", "dist", "loader.mjs")
const args = ["--import", tsxRegister, "--test", ...flags, ...files]

/** Variables d'environnement d'une suite isolée. */
const env = {
  ...process.env,
  // Force la base embarquée en mémoire (voir server/pglite-location.ts).
  NODE_ENV: "test",
  // Ceinture et bretelles : même si la décision ci-dessus changeait, aucune
  // suite ne doit pouvoir viser une base externe.
  DATABASE_URL: "",
  PGLITE_DATA_DIR: ":memory:",
  // Sorties lisibles dans une CI, sans séquences d'échappement.
  NO_COLOR: "1",
  // Certains tests démarrent un serveur : un délai de garde évite qu'une
  // poignée de main oubliée ne fige la suite.
  API_TIMEOUT_MS: "20000",
}

console.log(`[test] ${files.length} fichier(s) — base en mémoire, NODE_ENV=test`)

const child = spawn(process.execPath, args, {
  cwd: root,
  env,
  stdio: "inherit",
})

child.on("error", (error) => {
  console.error("[test] Impossible de lancer la suite :", error.message)
  process.exit(1)
})

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[test] Suite interrompue (${signal}).`)
    process.exit(1)
  }
  // Le code du lanceur de tests est déjà 0/1 ; on le propage tel quel pour que
  // `npm test` reste utilisable dans une CI.
  process.exit(code ?? 1)
})
