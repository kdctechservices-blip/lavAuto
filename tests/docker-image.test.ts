/**
 * L'image de production contient-elle tout ce que le serveur importe ?
 *
 * Le défaut que ce fichier empêche a déjà eu lieu. Le `Dockerfile` ne copie
 * que ce qui sert à servir — `server.ts`, `server/`, `dist/` — et le serveur
 * s'est mis à importer des modules de `src/` (le référentiel des véhicules, les
 * catégories de prestations, le calcul du prix unitaire), partagés avec
 * l'interface pour qu'ils ne puissent pas diverger.
 *
 * Rien ne casse à la construction : l'image se construit très bien. C'est au
 * démarrage du conteneur que tout s'arrête sur un `ERR_MODULE_NOT_FOUND`, et
 * la vérification de déploiement signale alors « le conteneur a échoué, mais
 * pas pour la bonne raison » — un message qui envoie chercher la panne du
 * côté de la base de données alors qu'il manque un fichier.
 *
 * Le contrôle est volontairement statique : il lit le `Dockerfile` et les
 * imports, sans Docker. Il tourne donc partout, y compris là où le démon
 * Docker n'existe pas.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Chemins copiés dans l'image, tels que déclarés par les `COPY` du Dockerfile.
 *
 * La destination est le dernier mot de l'instruction : `COPY src/config
 * ./src/config` installe `src/config` à la racine de l'image. Les `COPY
 * --from=builder /app/dist ./dist` suivent la même règle.
 */
function installedPaths(): string[] {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
  // Seule la **dernière** étape compte : celle de construction a le droit de
  // copier tout le dépôt (`COPY . .`), c'est même son travail. Confondre les
  // deux ferait passer ce contrôle en ne vérifiant rien.
  const stages = dockerfile.split(/^FROM\s/mi)
  const runtimeStage = stages.at(-1) ?? ""

  const installed: string[] = []
  for (const rawLine of runtimeStage.split("\n")) {
    const line = rawLine.trim()
    if (!line.toUpperCase().startsWith("COPY ")) continue
    const tokens = line.split(/\s+/).filter((token) => !token.startsWith("--"))
    // tokens[0] = COPY, le dernier = destination, le reste = sources.
    const sources = tokens.slice(1, -1)
    const destination = (tokens.at(-1) ?? "").replace(/^\.\//, "").replace(/\/$/, "")
    if (destination === "" || destination === ".") {
      // Copie à la racine de l'image (`COPY package.json … ./`) : seuls les
      // fichiers nommés arrivent, et sous leur propre nom. Sans ce cas, une
      // destination « . » laisserait croire que tout le dépôt est dans
      // l'image — c'est exactement ce qui rendait le contrôle aveugle.
      for (const source of sources) {
        const base = source.split("/").filter(Boolean).at(-1)
        if (base) installed.push(base)
      }
      continue
    }
    installed.push(destination)
  }
  return installed
}

/** Le fichier est-il présent dans l'image, directement ou via un dossier copié ? */
function coveredInImage(file: string, copies: string[]): boolean {
  return copies.some((copy) => {
    if (copy === "" || copy === ".") return true
    return file === copy || file.startsWith(`${copy}/`)
  })
}

/** Imports relatifs d'un fichier TypeScript, résolus en chemins du dépôt. */
function relativeImports(file: string): string[] {
  const source = readFileSync(path.join(root, file), "utf8")
  const found: string[] = []
  for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const specifier = match[1]
    const resolved = path
      .normalize(path.join(path.dirname(file), specifier))
      .replaceAll(path.sep, "/")
    found.push(resolved)
  }
  // Un `import "./x.ts"` sans `from` (effet de bord) compte aussi.
  for (const match of source.matchAll(/import\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    found.push(
      path.normalize(path.join(path.dirname(file), match[1])).replaceAll(path.sep, "/"),
    )
  }
  return found
}

/** Tous les fichiers TypeScript du serveur, chemins relatifs au dépôt. */
function serverFiles(): string[] {
  return readdirSync(path.join(root, "server"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `server/${name}`)
}

test("tout module du dépôt importé par le serveur est copié dans l'image", () => {
  const copies = installedPaths()
  // Le contrôle n'a de sens que si le Dockerfile a bien été lu : une liste
  // vide ferait passer le test en ne vérifiant rien.
  assert.ok(copies.length >= 4, `aucun COPY lu dans le Dockerfile : ${copies.join(", ")}`)
  assert.ok(copies.includes("server"), "le dossier server n'est pas copié")

  const manquants = new Set<string>()
  const visited = new Set<string>()

  const walk = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    // Seuls les fichiers du dépôt sont concernés : les paquets installés par
    // npm sont dans l'image par `npm ci`.
    if (!existsSync(path.join(root, file)) || !statSync(path.join(root, file)).isFile()) return
    if (!coveredInImage(file, copies)) manquants.add(file)
    for (const imported of relativeImports(file)) walk(imported)
  }

  walk("server.ts")
  for (const file of serverFiles()) walk(file)

  assert.deepEqual(
    [...manquants],
    [],
    `fichiers importés par le serveur mais absents de l'image : ${[...manquants].join(", ")} — ` +
      "ajouter un COPY dans le Dockerfile, sinon le conteneur meurt au démarrage sur ERR_MODULE_NOT_FOUND",
  )
})

test("les modules partagés entre l'API et l'interface sont bien dans l'image", () => {
  // Ces trois fichiers sont la raison d'être du contrôle : ils étaient dans
  // `src/`, donc invisibles au `Dockerfile` qui ne copiait que `server/`.
  const copies = installedPaths()
  for (const shared of [
    "src/config/vehicle-taxonomy.ts",
    "src/config/service-categories.ts",
    "src/lib/service-pricing.ts",
  ]) {
    assert.ok(existsSync(path.join(root, shared)), `${shared} n'existe plus`)
    assert.ok(coveredInImage(shared, copies), `${shared} n'est pas copié dans l'image`)
  }
})

test("l'image ne copie pas l'interface source, seulement son build", () => {
  const copies = installedPaths()
  // Copier `src/` en entier embarquerait les pages React dans une image qui
  // ne sert que du HTML déjà compilé. Ce n'est pas faux, c'est du poids et de
  // la surface inutiles — et cela masquerait le prochain oubli de COPY.
  assert.equal(copies.includes("src"), false, "tout src/ est copié dans l'image")
  assert.equal(copies.includes("."), false, "tout le dépôt est copié dans l'image")
  assert.ok(copies.includes("dist"), "l'interface construite n'est pas copiée")
})
