/**
 * Choix de la base de données.
 *
 * Le cas qui compte est celui du mode test : une suite qui écrirait dans la
 * base de production ne casserait rien visiblement — elle réussirait même. Ce
 * sont donc les règles d'isolation qui sont testées ici, pas la connexion.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSslConfig,
  chooseDatabaseTarget,
  describeConnection,
} from "../server/database-target.ts"

test("en développement, DATABASE_URL renseignée ouvre la base externe", () => {
  const decision = chooseDatabaseTarget({
    nodeEnv: "development",
    databaseUrl: "postgres://user:pass@db.example.com:5432/washpilot",
  })
  assert.equal(decision.target, "external")
  assert.equal(decision.ignoredDatabaseUrl, false)
})

test("sans DATABASE_URL, la base embarquée prend le relais", () => {
  assert.equal(chooseDatabaseTarget({ nodeEnv: "development" }).target, "embedded")
  assert.equal(chooseDatabaseTarget({ nodeEnv: "development", databaseUrl: "   " }).target, "embedded")
})

test("en production, DATABASE_URL reste la cible", () => {
  const decision = chooseDatabaseTarget({
    nodeEnv: "production",
    databaseUrl: "postgres://prod.example.com/washpilot",
  })
  assert.equal(decision.target, "external")
})

test("en test, DATABASE_URL est ignorée même si elle est renseignée", () => {
  const decision = chooseDatabaseTarget({
    nodeEnv: "test",
    databaseUrl: "postgres://prod.example.com/washpilot",
  })
  // Le point de non-retour : la suite ne doit jamais pouvoir viser une base
  // réelle, même avec un `.env` complet.
  assert.equal(decision.target, "embedded")
  assert.equal(decision.ignoredDatabaseUrl, true)
})

test("en test sans DATABASE_URL, aucune alerte n'est levée", () => {
  const decision = chooseDatabaseTarget({ nodeEnv: "test", databaseUrl: "" })
  assert.equal(decision.target, "embedded")
  assert.equal(decision.ignoredDatabaseUrl, false)
})

test("une valeur entourée d'espaces compte comme renseignée en développement", () => {
  const decision = chooseDatabaseTarget({
    nodeEnv: "development",
    databaseUrl: "  postgres://localhost/washpilot  ",
  })
  assert.equal(decision.target, "external")
})

// ---------------------------------------------------------------------------
// Profil de connexion : pooler ou direct ?
//
// Le mode transaction casse la garde multi-station (SET ROLE au niveau
// session). Ces tests figent la détection : elle doit crier avant la première
// requête, pas après une fuite entre deux stations.
// ---------------------------------------------------------------------------

test("une base locale n'a ni TLS ni perte d'état de session", () => {
  for (const url of ["postgres://u:p@localhost:5432/db", "postgres://u:p@127.0.0.1/db"]) {
    const profile = describeConnection(url)
    assert.equal(profile.mode, "local")
    assert.equal(profile.sessionStateSurvives, true)
    assert.equal(profile.warning, null)
    assert.equal(buildSslConfig(url), false)
  }
})

test("une connexion directe conserve l'état de session", () => {
  const profile = describeConnection("postgresql://u:p@db.exemple.com:5432/washpilot")
  assert.equal(profile.mode, "direct")
  assert.equal(profile.sessionStateSurvives, true)
  assert.equal(profile.warning, null)
})

test("le pooler Supabase en mode session est accepté", () => {
  const profile = describeConnection(
    "postgresql://postgres.abcdef:pw@aws-0-eu-west-3.pooler.supabase.com:5432/postgres",
  )
  assert.equal(profile.mode, "session-pooler")
  assert.equal(profile.sessionStateSurvives, true)
  assert.equal(profile.warning, null)
})

test("le pooler Supabase en mode transaction avertit sans bloquer", () => {
  const profile = describeConnection(
    "postgresql://postgres.abcdef:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres",
  )
  assert.equal(profile.mode, "transaction-pooler")
  assert.equal(profile.sessionStateSurvives, false)
  assert.match(profile.warning ?? "", /6543/)
  assert.match(profile.warning ?? "", /SET ROLE/)
})

test("un port 6543 inconnu est traité comme un pooler transaction", () => {
  assert.equal(describeConnection("postgres://u:p@pg.exemple.com:6543/db").mode, "transaction-pooler")
})

test("une URL illisible ne fait pas tomber le démarrage", () => {
  const profile = describeConnection("ceci-n-est-pas-une-url")
  assert.equal(profile.mode, "local")
  assert.equal(profile.warning, null)
})

test("TLS : vérification stricte par défaut, sans autorité fournie", () => {
  assert.deepEqual(buildSslConfig("postgresql://u:p@db.exemple.com/washpilot"), {
    rejectUnauthorized: true,
  })
})

test("TLS : l'autorité fournie est transmise telle quelle", () => {
  const ca = "-----BEGIN CERTIFICATE-----\nAC\n-----END CERTIFICATE-----"
  assert.deepEqual(buildSslConfig("postgresql://u:p@db.exemple.com/w", ca), {
    rejectUnauthorized: true,
    ca,
  })
  // Une autorité vide ou blanche ne doit pas produire `ca: ""`.
  assert.deepEqual(buildSslConfig("postgresql://u:p@db.exemple.com/w", "   "), {
    rejectUnauthorized: true,
  })
})
