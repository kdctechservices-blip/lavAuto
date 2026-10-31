# Neon Auth — jetons JWT

WashPilot CI possède sa propre authentification : e-mail + mot de passe
(scrypt), sessions opaques httpOnly dont seul le SHA-256 est stocké en base.
Ce document décrit la **seconde porte d'entrée**, ajoutée pour les
déploiements qui confient l'identité à [Neon Auth](https://neon.tech/docs/guides/neon-auth).

Elle est **facultative et éteinte par défaut** : sans configuration, rien ne
change.

## Ce que ça fait

Un client qui présente

```
Authorization: Bearer <jeton JWT signé par Neon Auth>
```

est authentifié si, et seulement si :

1. la signature est valide face au JWKS publié par Neon ;
2. le jeton est destiné à cette application (`exp`, `nbf`, `iss`, `aud`) ;
3. le sujet (`sub`) — ou, au premier passage, l'adresse e-mail vérifiée —
   correspond à un **compte existant** de la station ;
4. ce compte est actif.

Aucun compte n'est créé, aucun rôle n'est attribué : le rôle et
l'organisation vivent chez nous, pas dans le jeton.

## Configuration

```bash
NEON_AUTH_JWKS_URL=https://<endpoint>.neonauth.<region>.aws.neon.tech/neondb/auth/.well-known/jwks.json
# NEON_AUTH_ISSUER=      # déduit de l'URL ci-dessus, à déclarer seulement pour forcer
# NEON_AUTH_AUDIENCE=    # vide : `aud` non contrôlé
```

L'émetteur attendu (`iss`) est le dossier qui contient
`/.well-known/jwks.json`, soit `https://<endpoint>/neondb/auth`. Le déduire de
l'URL du JWKS évite la panne la plus fréquente : deux variables recopiées à la
main qui ne concordent plus, et des 401 inexplicables.

> Les URL `...neonauth.../auth` et `...apirest.../rest/v1` fournies par le
> tableau de bord Neon **ne servent pas de chaîne de connexion**. Le serveur
> parle à PostgreSQL en TCP via `DATABASE_URL` ; il ne consomme ni la Data API
> REST, ni l'API d'administration de Neon Auth.

## Ce qui se passe à la première connexion

| Situation | Résultat |
|---|---|
| `sub` déjà rattaché à un compte | session ouverte |
| `sub` inconnu, e-mail **vérifié** correspondant à un compte sans rattachement | session ouverte, `users.neon_auth_sub` renseigné |
| `sub` inconnu, e-mail correspondant mais **non vérifié** | refusé (401) |
| e-mail déjà rattaché à un **autre** `sub` | refusé (401) |
| aucune correspondance | refusé (401), aucun compte créé |
| compte `inactive` | refusé (401) |

Le rattachement automatique exige `email_verified` : sans cette condition,
s'inscrire chez le fournisseur avec l'adresse d'un gérant suffirait à
reprendre son compte.

## Sécurité

- **Algorithmes acceptés** : `RS256/384/512`, `PS256/384/512`, `ES256/384/512`,
  `EdDSA`. `none` et les algorithmes symétriques (`HS*`) sont refusés : un
  secret partagé n'apporte rien ici, et `none` est la faille classique.
- **Pas de dépendance JWT ajoutée** : tout passe par `node:crypto`
  (`createPublicKey({ format: "jwk" })` + `verify`), soit une surface d'à peu
  près 150 lignes relisibles dans `server/neon-auth.ts`.
- **Cache du JWKS** : 10 minutes. Un `kid` inconnu déclenche une relecture,
  mais au plus une fois toutes les 30 s — sinon un jeton forgé transformerait
  chaque requête en appel sortant vers Neon. Si Neon tombe, les clés déjà
  connues continuent de servir ; une clé inconnue, elle, n'a pas de secours.
- **Aucune révocation côté application** : un JWT vaut session (pas de ligne
  `auth_sessions`). Sa durée de vie est celle décidée chez Neon ; c'est le prix
  de la délégation. La session est identifiée par `neon-auth:<sub>`.
- **Journalisation** : un refus est tracé côté serveur, jamais renvoyé au
  client — distinguer « jeton volé » de « jeton périmé » aiderait un attaquant.

## Limite actuelle : le navigateur

La vérification est **côté serveur**. L'interface React continue de se
connecter par e-mail + mot de passe : elle n'obtient pas de jeton Neon Auth
d'elle-même. Pour l'utiliser depuis le navigateur, il faut ajouter le client
Neon Auth (`@neondatabase/auth`) à la SPA, puis transmettre son jeton dans
`Authorization: Bearer` — `src/lib/api.ts` le fait déjà dès qu'un jeton est
présent dans le stockage local.

Sans ce client, la fonctionnalité sert les cas où un jeton est obtenu
autrement : script d'import, application mobile, passerelle interne.

## Vérification manuelle

```bash
# 1. Le JWKS est-il joignable depuis la machine qui héberge l'application ?
curl -sS "$NEON_AUTH_JWKS_URL" | head -c 200

# 2. Le serveur a-t-il activé la porte d'entrée ?
#    Le journal de démarrage doit afficher, à la première requête authentifiée :
#    [auth] Jetons Neon Auth acceptés (émetteur https://…/neondb/auth)

# 3. Un jeton valide ouvre-t-il /auth/me ?
curl -sS -H "Authorization: Bearer $TOKEN" https://<app>/api/v1/auth/me
```

Un refus est toujours un `401` avec le code `authentication_required`, comme
un mot de passe erroné : l'API ne dit pas *pourquoi* le jeton a été rejeté.

## Diagnostic

| Symptôme | Cause probable |
|---|---|
| `401` systématique, journal muet | `NEON_AUTH_JWKS_URL` absente : la porte est éteinte |
| `Jeton Neon Auth refusé : Émetteur inattendu` | `NEON_AUTH_ISSUER` ne correspond pas au JWKS |
| `... : JWKS injoignable` | egress réseau bloqué vers `*.neonauth.*` |
| `... : La signature du jeton est invalide` | jeton d'un autre projet Neon, ou clé tournée sans redéploiement |
| connexion acceptée mais écran vide | le compte est authentifié mais n'appartient à aucune organisation |

## Tests

`tests/neon-auth.test.ts` couvre les deux niveaux :

- **unitaire** — clés RSA, EC et Ed25519 générées à la volée, JWKS servi par
  un `fetch` injecté : signature, expiration, émetteur, audience, algorithmes
  refusés, rotation de clés, panne du JWKS ;
- **bout en bout** — un vrai serveur JWKS HTTP local, une vraie requête sur
  `/api/v1/auth/me`, et les règles de rattachement (adresse non vérifiée,
  `sub` déjà pris, compte inconnu).

```bash
npm test -- tests/neon-auth.test.ts
```
