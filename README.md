# Log — logs Kafka, agents et mémoire des résolutions

Site statique déployé par Vercel + fonctions `api/` + PostgreSQL Aiven.

## Architecture (une seule source de vérité par étage)

1. **Logs** : le topic Kafka Aiven `otel.logs` est la source. Chaque message est
   ingéré dans la table PostgreSQL `logs` par `scripts/consumer.cjs`.
   L'identifiant est `topic:partition:offset` : le site affiche exactement ce qui
   est arrivé sur Aiven, sans doublon et dans le même ordre.
2. **Runs d'agents** : table `agent_runs` (`cold` / `warm` / `warm_degraded`).
3. **Méthodes de résolution** : table `error_resolutions`, une ligne par
   `fingerprint`. C'est la seule source : aucun fichier `.md`.

Le front lit `GET /api/logs` (polling) et publie un log via `POST /api/logs`,
qui écrit dans Kafka. Il ne génère aucun log local.

## Démarrage

```bash
npm install
cp .env.example .env.aiven.local   # renseigner les identifiants Aiven
npm run db:schema                  # crée logs, agent_runs, error_resolutions
npm run consumer                   # Kafka otel.logs -> PostgreSQL (à laisser tourner)
npx serve .                        # site local : http://localhost:3000
```

Sur Vercel, définir les mêmes variables que `.env.example` dans les
Environment Variables du projet. Ne jamais committer `.env.aiven.local`.

## Les cinq erreurs suivies

| Code | Type |
|---|---|
| `ERR_DB_POOL_EXHAUSTED` | Database connection pool exhausted |
| `ERR_PG_TIMEOUT_5432` | Connection timeout on port 5432 |
| `ERR_KAFKA_UNREACHABLE` | Kafka Broker Unreachable |
| `ERR_OOM_HEAP` | OutOfMemoryError (OOM) / Java heap space saturated |
| `ERR_DISK_FULL` | Disk Full / No space left on device |

## Mémoire des résolutions (agent opencode)

```bash
npm run memory -- lookup --code ERR_KAFKA_UNREACHABLE
npm run memory -- record --code ERR_KAFKA_UNREACHABLE --fix "..." --verification "..."
npm run memory -- list
npm run memory -- runs
```

`lookup` cherche un fingerprint exact, puis un problème similaire (`pg_trgm`,
puis la table historique de Baptiste). La méthode est lue dans PostgreSQL.
`record` enregistre la méthode et le run.

## Rapports des agents réels (`otel-reports`)

Le watcher de Baptiste publie chaque rapport d'agent sur `otel-reports`.
`npm run consumer:reports` les ingère dans `agent_reports` et, quand le statut
est `resolved`, met à jour automatiquement la mémoire (`error_resolutions` +
`agent_runs`) — aucun `record` manuel n'est alors nécessaire.

```bash
npm run consumer:reports      # Kafka otel-reports -> PostgreSQL (à laisser tourner)
```

Le log d'origine est retrouvé par `TraceId` : c'est lui qui fixe le
`fingerprint`, donc la même clé que celle utilisée par `npm run memory`.
Les rapports sont exposés par `GET /api/reports?trace_id=…&code=…`.

## Autres commandes

```bash
npm run logs -- --count 5     # génère les cinq logs d'erreur
npm test                      # tests du catalogue d'erreurs
node scripts/test-api.cjs     # test des fonctions api/ en local
```
