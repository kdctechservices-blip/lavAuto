import test from "node:test"
import assert from "node:assert/strict"
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  GRANTABLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  rolePermissions,
  isPermission,
  isRole,
  deniedMessage,
  type Permission,
  type Role,
} from "../server/permissions.ts"
import { requirePermission, assertPermission } from "../server/http.ts"
import { HttpError } from "../server/auth.ts"

// ---------------------------------------------------------------------------
// Matrice des rôles
// ---------------------------------------------------------------------------

test("le propriétaire détient toutes les permissions", () => {
  for (const permission of PERMISSIONS) {
    assert.equal(hasPermission("owner", permission), true, `owner devrait avoir ${permission}`)
  }
})

test("le gérant gère l'opérationnel et les dépenses, mais ne corrige ni les tarifs, ni les écritures, ni les utilisateurs", () => {
  // Autorisé
  for (const permission of [
    "wash:create",
    "wash:read",
    "wash:update",
    "payment:create",
    "payment:verify",
    "cash_session:manage",
    "service:read",
    "worker:create",
    "report:operational",
    // Supervision des sorties d'argent : le gérant voit et enregistre.
    "expense:read",
    "expense:create",
    "report:financial",
  ] as Permission[]) {
    assert.equal(hasPermission("manager", permission), true, `manager devrait avoir ${permission}`)
  }
  // Refusé
  for (const permission of [
    "service:manage",
    "wash:cancel",
    "payment:cancel",
    // La frontière qui compte : enregistrer une dépense se délègue,
    // la modifier ou la supprimer non.
    "expense:manage",
    "report:export",
    "worker:delete",
    "user:manage",
    "settings:manage",
    "subscription:manage",
    "data:export",
  ] as Permission[]) {
    assert.equal(hasPermission("manager", permission), false, `manager ne devrait pas avoir ${permission}`)
  }
})

test("l'agent de lavage ne voit ni les encaissements, ni les dépenses, ni les rapports", () => {
  assert.deepEqual([...rolePermissions("washer")], ["wash:read", "service:read"])
  for (const permission of [
    "payment:read",
    "expense:read",
    "report:operational",
    "report:financial",
    "cash_session:read",
    "dashboard:read",
  ] as Permission[]) {
    assert.equal(hasPermission("washer", permission), false, `washer ne devrait pas avoir ${permission}`)
  }
})

test("le caissier tient la caisse sans toucher au catalogue ni aux droits", () => {
  assert.equal(hasPermission("cashier", "cash_session:manage"), true)
  assert.equal(hasPermission("cashier", "payment:create"), true)
  assert.equal(hasPermission("cashier", "expense:create"), true)
  assert.equal(hasPermission("cashier", "service:manage"), false)
  assert.equal(hasPermission("cashier", "user:manage"), false)
  assert.equal(hasPermission("cashier", "report:financial"), false)
})

test("un rôle inconnu n'obtient rien : refus par défaut", () => {
  assert.deepEqual([...rolePermissions("admin")], [])
  assert.equal(hasPermission("", "wash:read"), false)
  assert.equal(hasPermission("OWNER", "wash:read"), false, "la casse ne doit pas être permissive")
})

test("seuls les quatre rôles prévus sont reconnus", () => {
  assert.deepEqual([...ROLES], ["owner", "manager", "cashier", "washer"])
  assert.equal(isRole("owner"), true)
  assert.equal(isRole("superadmin"), false)
  assert.equal(isPermission("wash:create"), true)
  assert.equal(isPermission("wash:destroy"), false)
})

// ---------------------------------------------------------------------------
// Exceptions accordées par le propriétaire
// ---------------------------------------------------------------------------

test("le propriétaire peut accorder une permission à titre exceptionnel", () => {
  // `report:export` et non `expense:create` : depuis que le gérant détient
  // les dépenses par son rôle, s'en servir ici ne prouverait plus rien —
  // le test passerait sans que le mécanisme d'exception soit sollicité.
  const permissions = effectivePermissions("manager", [{ permission: "report:export", granted: true }])
  assert.equal(permissions.has("report:export"), true)
  // L'exception ne déborde pas sur les autres droits du même domaine.
  assert.equal(permissions.has("data:export"), false)
})

test("le propriétaire peut retirer une permission venant du rôle", () => {
  const permissions = effectivePermissions("manager", [{ permission: "cash_session:manage", granted: false }])
  assert.equal(permissions.has("cash_session:manage"), false)
  assert.equal(permissions.has("wash:create"), true)
})

test("les permissions réservées au propriétaire ne sont jamais déléguées", () => {
  for (const permission of OWNER_ONLY_PERMISSIONS) {
    const permissions = effectivePermissions("manager", [{ permission, granted: true }])
    assert.equal(permissions.has(permission), false, `${permission} ne doit pas être délégable`)
  }
  assert.equal(GRANTABLE_PERMISSIONS.includes("user:manage"), false)
  assert.equal(GRANTABLE_PERMISSIONS.includes("expense:create"), true)
})

test("un propriétaire ne peut pas se faire retirer ses propres droits", () => {
  const permissions = effectivePermissions("owner", [
    { permission: "user:manage", granted: false },
    { permission: "settings:manage", granted: false },
  ])
  assert.equal(permissions.has("user:manage"), true)
  assert.equal(permissions.has("settings:manage"), true)
})

test("une exception portant sur une permission inconnue est ignorée", () => {
  const permissions = effectivePermissions("manager", [{ permission: "wash:destroy", granted: true }])
  assert.equal(permissions.size, ROLE_PERMISSIONS.manager.length)
})

// ---------------------------------------------------------------------------
// Middleware de contrôle d'accès
// ---------------------------------------------------------------------------

/** Fabrique une requête Express minimale pour tester le middleware. */
function fakeRequest(role: string | null) {
  if (!role) return {} as never
  const permissions = effectivePermissions(role)
  return {
    tenant: {
      organizationId: "org-1",
      userId: "user-1",
      role,
      permissions,
      can: (permission: Permission) => permissions.has(permission),
    },
  } as never
}

function runMiddleware(role: string | null, permission: Permission) {
  let captured: unknown = "non-appelé"
  const middleware = requirePermission(permission)
  middleware(fakeRequest(role), {} as never, ((error?: unknown) => {
    captured = error ?? null
  }) as never)
  return captured
}

test("une requête non authentifiée reçoit 401", () => {
  const error = runMiddleware(null, "wash:read")
  assert.ok(error instanceof HttpError)
  assert.equal(error.status, 401)
  assert.equal(error.code, "authentication_required")
})

test("une requête autorisée passe au gestionnaire suivant", () => {
  assert.equal(runMiddleware("owner", "service:manage"), null)
  assert.equal(runMiddleware("manager", "wash:create"), null)
})

test("une requête interdite reçoit 403, même venant d'un appel direct à l'API", () => {
  const error = runMiddleware("manager", "service:manage")
  assert.ok(error instanceof HttpError)
  assert.equal(error.status, 403)
  assert.equal(error.code, "forbidden")
  assert.match(error.message, /non autorisée/i)
})

test("le middleware exige toutes les permissions demandées", () => {
  let captured: unknown = "non-appelé"
  // Le gérant détient `wash:read` mais pas `expense:manage` : la paire reste
  // dissymétrique, ce qui est tout l'objet du test. (`report:financial` ne
  // convient plus, le gérant l'a obtenu avec la supervision des dépenses.)
  requirePermission("wash:read", "expense:manage")(fakeRequest("manager"), {} as never, ((e?: unknown) => {
    captured = e ?? null
  }) as never)
  assert.ok(captured instanceof HttpError)
  assert.equal((captured as HttpError).status, 403)
})

test("assertPermission lève la même erreur depuis un gestionnaire", () => {
  assert.doesNotThrow(() => assertPermission(fakeRequest("owner"), "payment:cancel"))
  assert.throws(
    () => assertPermission(fakeRequest("cashier"), "payment:cancel"),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  )
})

test("le message de refus nomme l'action refusée", () => {
  assert.match(deniedMessage("service:manage"), /prestations/i)
  assert.match(deniedMessage("report:financial"), /financiers/i)
})

// ---------------------------------------------------------------------------
// Matrice figée
// ---------------------------------------------------------------------------

/**
 * Empreinte exacte de chaque rôle.
 *
 * Les tests ci-dessus vérifient des permissions choisies une à une : ils
 * disent ce qui doit être vrai, pas ce qui ne doit pas apparaître. Une
 * permission ajoutée par mégarde à un rôle passerait donc inaperçue.
 *
 * Ce test ferme cette porte. Le faire échouer n'est pas un incident : c'est
 * le signal qu'un droit change de main, ce qui se décide et se consigne dans
 * RBAC-PERMISSIONS.md avant de modifier cette liste.
 */
const EXPECTED_MATRIX: Record<Exclude<Role, "owner">, readonly Permission[]> = {
  manager: [
    "audit:read",
    "cash_session:manage",
    "cash_session:read",
    "dashboard:read",
    "expense:create",
    "expense:read",
    "payment:create",
    "payment:read",
    "payment:verify",
    "report:financial",
    "report:operational",
    "service:read",
    "stock:manage",
    "stock:move",
    "supplier:manage",
    "purchase:manage",
    "attendance:read",
    "attendance:manage",
    "stock:read",
    "wash:create",
    "wash:read",
    "wash:status",
    "wash:update",
    "worker:create",
    "worker:read",
    "worker:update",
  ],
  cashier: [
    "cash_session:manage",
    "cash_session:read",
    "dashboard:read",
    "expense:create",
    "expense:read",
    "payment:create",
    "payment:read",
    "report:operational",
    "service:read",
    "wash:create",
    "wash:read",
    "wash:status",
    "worker:read",
  ],
  washer: ["service:read", "wash:read"],
}

test("la matrice des rôles est exactement celle qui a été décidée", () => {
  for (const [role, expected] of Object.entries(EXPECTED_MATRIX)) {
    assert.deepEqual(
      [...rolePermissions(role)].sort(),
      [...expected].sort(),
      `la matrice du rôle « ${role} » a changé — consigner la décision dans RBAC-PERMISSIONS.md avant de modifier ce test`,
    )
  }
  // Le propriétaire détient tout, par définition : le vérifier évite qu'une
  // nouvelle permission soit introduite sans que personne ne puisse l'exercer.
  assert.deepEqual([...rolePermissions("owner")].sort(), [...PERMISSIONS].sort())
})

test("aucun rôle subordonné ne voit plus de dépenses que son supérieur", () => {
  // L'anomalie qui a motivé la migration : le caissier enregistrait des
  // sorties d'argent que son responsable direct ne pouvait pas consulter.
  for (const permission of ["expense:read", "expense:create"] as Permission[]) {
    assert.equal(
      hasPermission("manager", permission) || !hasPermission("cashier", permission),
      true,
      `le caissier détient ${permission} sans que le gérant l'ait : la hiérarchie de supervision est inversée`,
    )
  }
  // Et la réécriture reste hors de portée des deux.
  for (const role of ["manager", "cashier"] as Role[]) {
    assert.equal(hasPermission(role, "expense:manage"), false)
  }
})
