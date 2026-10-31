# Supabase — base de production et base locale

WashPilot CI utilise **Supabase PostgreSQL** comme base distante de production. Le schéma est versionné dans `supabase/migrations/` et s’applique avec les migrations Supabase ; le serveur ne doit pas créer ou modifier silencieusement le schéma au démarrage.

## Production

1. Utiliser le projet Supabase **Lavauto** dédié à cette application.
2. Configurer `DATABASE_URL` avec la connexion directe PostgreSQL, ou le pooler Supavisor en **mode session**. Le port 6543 (mode transaction) ne conserve pas le contexte de session requis par l’isolation RLS et ne doit pas être utilisé.
3. Conserver la vérification TLS active. Si l’environnement requiert un certificat Supabase spécifique, fournir `DATABASE_SSL_CA` au format PEM ou comme chemin de certificat.
4. Appliquer les migrations avant le déploiement de l’API. L’application vérifie les tables essentielles au démarrage et échoue si le schéma initial n’a pas été appliqué.
5. Définir les variables d’exploitation (`APP_URL`, e-mail, secrets de console/cron, `SEED_DEMO_DATA=false`) dans l’environnement d’hébergement, jamais dans Git.

Le backend utilise le client PostgreSQL `pg` et l’authentification applicative existante (comptes et sessions stockés dans le schéma de l’application). La clé `service_role` et les clés Supabase ne sont pas nécessaires dans le navigateur ni dans l’API pour les accès SQL directs. Ne jamais exposer une clé secrète dans `VITE_*`.

## Développement et tests

- `npm run dev` sans `DATABASE_URL` utilise le PGlite local du serveur.
- `npm test` force une base PGlite isolée par fichier et ignore toute URL externe.
- L’application web conserve un PGlite dans IndexedDB pour la file locale d’opérations hors connexion ; les mutations en attente sont envoyées à l’API authentifiée au retour du réseau. Supabase reste la source de vérité distante.
- Il n’y a pas de réplication bidirectionnelle automatique du catalogue et de toutes les tables : la synchronisation actuelle est une file d’écritures hors ligne, ordonnée et idempotente. Les conflits définitifs sont conservés dans la file pour résolution opérateur.

## Migrations

Les migrations sont la source de vérité du schéma Supabase. Pour appliquer une migration avec la CLI :

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Créer ensuite une nouvelle migration versionnée pour toute évolution du schéma. Ne pas modifier une migration déjà appliquée à un environnement partagé.
