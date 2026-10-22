# Log — erreurs, agents et mémoire des résolutions

Site statique (Vercel) + scripts Node pour la mémoire PostgreSQL des résolutions.

**Le site n'est pas hébergé sur un ordinateur local : sa source de vérité est ce dépôt
GitHub (`GaiaSG94/Log`), déployé automatiquement par Vercel sur
<https://log-errors.vercel.app/>.** Toute modification passe par le dépôt (cloner /
`git pull`, modifier, pousser) ; Vercel redéploie ensuite `main`. Le dossier local
`C:\Users\gaiam\Downloads\Log` n'est qu'une copie de travail.

## Les cinq erreurs suivies

| Code | Type |
|---|---|
| `ERR_DB_POOL_EXHAUSTED` | Database connection pool exhausted |
| `ERR_PG_TIMEOUT_5432` | Connection timeout on port 5432 |
| `ERR_KAFKA_UNREACHABLE` | Kafka Broker Unreachable |
| `ERR_OOM_HEAP` | OutOfMemoryError (OOM) / Java heap space saturated |
| `ERR_DISK_FULL` | Disk Full / No space left on device |

## Démarrage

```bash
npm install
cp .env.example .env.aiven.local   # puis renseigner les identifiants Aiven
npm run db:schema                 # crée error_resolutions + agent_runs et les droits
npm run logs -- --count 5         # génère les cinq logs d'erreur
npm run memory -- lookup --code ERR_DB_POOL_EXHAUSTED
npm test
```

`npm run db:schema` utilise `PGADMIN_USER` / `PGADMIN_PASSWORD` (rôle `avnadmin`) ;
le site et les agents utilisent `PGUSER` (`logsite`).

## Observabilité (temps et tokens)

Section `#observabilite` du site, alimentée par `metrics.js` (mesure, fingerprint,
persistance) et `observability.js` (rendu). Elle compare, par log d'erreur :

- **avant / cold** : première résolution, aucun mémo ;
- **après / warm** : récurrence avec la méthode de résolution lue en base ;
- **warm dégradé** : récurrence sans mémo exploitable (exclu des moyennes warm).

Métriques : temps médian avant/après et gain, tokens médians avant/après et gain, tokens
totaux consommés, taux de mémoïsation, résolutions (`cold` / `warm` / échecs), détail des
étapes par run (`receive → fingerprint → memo_lookup → diagnose → patch → verify → write_memo`).
Exports JSON/CSV et réinitialisation depuis la section.

Ouvrir le site :

```bash
# en ligne (déployé depuis ce dépôt)
start https://log-errors.vercel.app/?demo=warm

# en local, sans build
npx serve .        # puis http://localhost:3000/?demo=warm
```

Paramètres de démonstration : `?demo=warm` (1 cold + 2 warm préchargés),
`?scenario=ERR_KAFKA_UNREACHABLE` (répéter un même scénario), `?fail=1` (run échoué,
exclu des médianes mais compté dans les échecs).

Persistance : `localStorage` (`log.observability.v1`, 500 runs max) par défaut. Pour brancher
la base, définir `window.LOG_METRICS_API = "/api"` dans `index.html` : le front lit
`GET /api/metrics` et écrit `POST /api/runs` / `POST /api/memos` (fonctions de `api/`),
avec retour silencieux au local si l'API est indisponible.

## Base

- `error_resolutions` : une ligne par `fingerprint` (code + message normalisé + première frame) avec `cause`, `fix`, `files`, `verification`, `runs`.
- `agent_runs` : historique des runs (`cold` / `warm` / `warm_degraded`, statut, durée, tokens).
- `historique` : mémoire historique de Baptiste, lue en secours via `historique_trouver()`.

## Workflow de l'agent opencode

1. Une erreur apparaît (site ou `npm run logs`).
2. `npm run memory -- lookup --code ERR_...` : cherche un fingerprint exact, puis un problème similaire (`pg_trgm`, puis `historique_trouver`).
3. En cas de hit, la méthode est affichée et exportée dans `docs/error-memos/<fingerprint>.md`.
4. Après résolution : `npm run memory -- record --code ERR_... --fix "..."` enregistre la méthode et le run.

La base est la source de vérité ; les `.md` sont un export lisible généré à la demande.
