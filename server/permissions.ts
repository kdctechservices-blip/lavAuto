// ---------------------------------------------------------------------------
// Référentiel de permissions (RBAC)
//
// Principe : refus par défaut. Une action n'est permise que si elle figure
// explicitement dans les permissions effectives de l'utilisateur.
//
// Les permissions effectives se calculent en trois temps :
//   1. les permissions du rôle (matrice ci-dessous) ;
//   2. moins les refus explicites posés par le propriétaire ;
//   3. plus les autorisations exceptionnelles accordées par le propriétaire,
//      à l'exclusion des permissions réservées au propriétaire.
//
// Ce fichier ne dépend ni d'Express ni de la base : il est testable seul, et
// c'est la même source de vérité pour le serveur et pour l'interface.
// ---------------------------------------------------------------------------

export const PERMISSIONS = [
  // Consultation générale
  "dashboard:read",
  // Lavages
  "wash:create",
  "wash:read",
  "wash:update",
  "wash:status",
  "wash:cancel",
  // Encaissements
  "payment:create",
  "payment:read",
  "payment:verify",
  "payment:cancel",
  // Caisse
  "cash_session:read",
  "cash_session:manage",
  // Catalogue (prestations, catégories, tarifs)
  "service:read",
  "service:manage",
  // Laveurs
  "worker:read",
  "worker:create",
  "worker:update",
  "worker:delete",
  // Dépenses
  "expense:read",
  "expense:create",
  "expense:manage",
  // Stock (produits, mouvements)
  "stock:read",
  "stock:manage",
  "stock:move",
  // Fournisseurs et achats
  "supplier:manage",
  "purchase:manage",
  // Présences et rendement des laveurs
  "attendance:read",
  "attendance:manage",
  "attendance:correct",
  // Rapports
  "report:operational",
  "report:financial",
  "report:export",
  // Traçabilité
  "audit:read",
  // Administration
  "user:manage",
  "settings:manage",
  "subscription:manage",
  "data:export",
] as const

export type Permission = (typeof PERMISSIONS)[number]

/**
 * Rôles applicatifs, alignés sur `organization_members.role`.
 *
 * `cashier` existe depuis l'origine du produit (c'est un métier réel en
 * station) : il est conservé plutôt que renommé, pour ne pas invalider les
 * comptes déjà créés. `washer` est le rôle d'accès individuel des laveurs.
 */
export const ROLES = ["owner", "manager", "cashier", "washer"] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Propriétaire",
  manager: "Gérant",
  cashier: "Caissier",
  washer: "Agent de lavage",
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Accès complet : paramètres, tarifs, finances, utilisateurs et abonnement.",
  manager:
    "Gestion opérationnelle : lavages, encaissements, caisse, laveurs, dépenses et marges. Ne modifie ni les tarifs, ni les dépenses enregistrées, ni les utilisateurs.",
  cashier: "Tenue de la caisse : lavages, encaissements et dépenses courantes.",
  washer: "Accès limité : consultation des lavages et des prestations.",
}

/** Matrice des permissions par rôle. Tout ce qui n'y figure pas est refusé. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Le propriétaire détient toutes les permissions, par définition.
  owner: PERMISSIONS,

  manager: [
    "dashboard:read",
    "wash:create",
    "wash:read",
    "wash:update",
    // Avancement operationnel : le lavage passe de « en attente » a « en
    // cours », puis a « termine ». C'est la personne qui tient le poste qui
    // fait avancer la voiture, pas le gerant qui repond des comptes.
    "wash:status",
    "payment:create",
    "payment:read",
    "payment:verify",
    "cash_session:read",
    "cash_session:manage",
    "service:read",
    "worker:read",
    "worker:create",
    "worker:update",
    "report:operational",
    "audit:read",
    // Dépenses : voir et enregistrer, jamais corriger.
    //
    // Une dépense en espèces insère un mouvement de sortie dans la session de
    // caisse ouverte. Comme le caissier ouvre et clôture lui-même cette
    // session, il était jusqu'ici seul à justifier un tiroir dans lequel il
    // puisait : la sortie se déduisait du montant attendu, l'écart à la
    // clôture restait nul, et aucun échelon intermédiaire ne la voyait.
    //
    // `expense:create` est accordé pour une raison moins évidente que
    // `expense:read` : sans elle, un gérant qui achète des consommables fait
    // enregistrer la dépense par son caissier, qui en devient l'auteur
    // apparent. Refuser la permission fabriquait un journal d'audit faux.
    //
    // `expense:manage` (modifier, supprimer) reste au propriétaire : on
    // délègue l'enregistrement, jamais la réécriture.
    "expense:read",
    "expense:create",
    // Stock : voir, gérer et mouvementer.
    //
    // Même raisonnement que pour les dépenses. En station, c'est le gérant qui
    // réceptionne les bidons et qui compte les étagères. Sans `stock:move` il
    // ferait saisir le mouvement par son caissier, qui en deviendrait l'auteur
    // apparent dans `audit_logs` : refuser la permission fabriquerait un
    // journal faux.
    //
    // La frontière « on délègue l'enregistrement, jamais la réécriture » n'est
    // pas portée ici par une permission mais par le modèle : un mouvement ne
    // se modifie ni ne se supprime, il se contrepasse.
    "stock:read",
    "stock:manage",
    "stock:move",
    // Fournisseurs et achats.
    //
    // C'est le gérant qui va au marché et qui revient avec les sachets. Lui
    // refuser l'achat obligerait le propriétaire à ressaisir après coup ce
    // qu'il n'a pas vu arriver, ou le gérant à emprunter le compte d'un
    // autre : les deux fabriquent un journal faux.
    "supplier:manage",
    "purchase:manage",
    // Présences.
    //
    // Le gérant pointe et déclare les absences : il est sur place, c'est lui
    // qui voit qui arrive. La **correction** d'un pointage déjà saisi reste
    // au propriétaire : réécrire une heure d'arrivée après coup touche à ce
    // qui servira peut-être à juger quelqu'un. Elle reste délégable au cas
    // par cas, comme l'annulation d'un lavage.
    "attendance:read",
    "attendance:manage",
    // Le détail des dépenses sans leur total rendrait l'écran de rapports
    // incohérent — retenir l'agrégat quand on donne la ligne ne protège rien.
    "report:financial",
  ],

  cashier: [
    "dashboard:read",
    "wash:create",
    "wash:read",
    // Le caissier enregistre le lavage et suit la voiture : c'est lui qui
    // fait passer l'operation de « en attente » a « en cours », puis a
    // « terminate ». Lui refuser ce geste obligerait le gerant a quitter le
    // comptoir pour une operation de terrain.
    "wash:status",
    "payment:create",
    "payment:read",
    "cash_session:read",
    "cash_session:manage",
    "service:read",
    "worker:read",
    "expense:read",
    "expense:create",
    "report:operational",
  ],

  washer: ["wash:read", "service:read"],
}

/**
 * Permissions que le propriétaire ne peut jamais déléguer.
 * Elles touchent la sécurité, la facturation ou la structure de la station :
 * les déléguer reviendrait à permettre de contourner le système lui-même.
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = [
  "user:manage",
  "settings:manage",
  "subscription:manage",
  "payment:cancel",
]

/** Permissions qu'un propriétaire peut accorder à titre exceptionnel. */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !OWNER_ONLY_PERMISSIONS.includes(permission),
)

export const PERMISSION_LABELS: Record<Permission, string> = {
  "dashboard:read": "Consulter le tableau de bord",
  "wash:create": "Enregistrer un lavage",
  "wash:read": "Consulter les lavages",
  "wash:update": "Modifier un lavage",
  "wash:status": "Faire avancer l'avancement d'un lavage",
  "wash:cancel": "Annuler un lavage",
  "payment:create": "Enregistrer un encaissement",
  "payment:read": "Consulter les encaissements",
  "payment:verify": "Confirmer un encaissement mobile money",
  "payment:cancel": "Rembourser un encaissement",
  "cash_session:read": "Consulter la caisse",
  "cash_session:manage": "Ouvrir et clôturer la caisse",
  "service:read": "Consulter les prestations et les tarifs",
  "service:manage": "Modifier les prestations et les tarifs",
  "worker:read": "Consulter les laveurs",
  "worker:create": "Ajouter un laveur",
  "worker:update": "Modifier un laveur",
  "worker:delete": "Supprimer un laveur",
  "expense:read": "Consulter les dépenses",
  "expense:create": "Enregistrer une dépense",
  "expense:manage": "Modifier ou supprimer une dépense",
  "stock:read": "Consulter le stock et les mouvements",
  "stock:manage": "Créer et modifier les produits du stock",
  "stock:move": "Enregistrer un mouvement de stock",
  "supplier:manage": "Gérer les fournisseurs",
  "purchase:manage": "Enregistrer un achat",
  "attendance:read": "Consulter les présences et le rendement",
  "attendance:manage": "Pointer et déclarer une absence",
  "attendance:correct": "Corriger un pointage, valider une absence",
  "report:operational": "Consulter les rapports d’activité",
  "report:financial": "Consulter les rapports financiers (marges, dépenses)",
  "report:export": "Exporter les rapports",
  "audit:read": "Consulter l’historique des opérations",
  "user:manage": "Gérer les utilisateurs et leurs droits",
  "settings:manage": "Modifier les paramètres de la station",
  "subscription:manage": "Gérer l’abonnement",
  "data:export": "Exporter les données de la station",
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value)
}

/** Permissions d'un rôle, hors exceptions. */
export function rolePermissions(role: string): readonly Permission[] {
  return isRole(role) ? ROLE_PERMISSIONS[role] : []
}

/** Exception posée par le propriétaire sur un membre précis. */
export interface PermissionOverride {
  permission: string
  /** `true` = autorisation exceptionnelle, `false` = retrait explicite. */
  granted: boolean
}

/**
 * Permissions effectives d'un membre : rôle + exceptions.
 *
 * Deux garde-fous structurels :
 *   • les permissions réservées au propriétaire ne peuvent pas être accordées
 *     à un autre rôle, même par le propriétaire lui-même ;
 *   • le propriétaire ne peut pas se retirer ses propres permissions, ce qui
 *     rendrait la station ingérable.
 */
export function effectivePermissions(
  role: string,
  overrides: readonly PermissionOverride[] = [],
): Set<Permission> {
  const effective = new Set<Permission>(rolePermissions(role))
  if (role === "owner") return effective

  for (const override of overrides) {
    if (!isPermission(override.permission)) continue
    if (override.granted) {
      if (OWNER_ONLY_PERMISSIONS.includes(override.permission)) continue
      effective.add(override.permission)
    } else {
      effective.delete(override.permission)
    }
  }
  return effective
}

/** Le membre a-t-il le droit d'effectuer cette action ? */
export function hasPermission(
  role: string,
  permission: Permission,
  overrides: readonly PermissionOverride[] = [],
): boolean {
  return effectivePermissions(role, overrides).has(permission)
}

/** Message affiché à l'utilisateur lorsqu'une action lui est refusée. */
export function deniedMessage(permission: Permission): string {
  const label = PERMISSION_LABELS[permission] ?? permission
  return `Action non autorisée pour votre rôle : ${label.toLowerCase()}. Demandez l’accès au propriétaire de la station.`
}
