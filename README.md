# Log — journaux et flotte d'agents du poste

Ce dépôt a **trois rôles** :

1. **Sauvegarde** des journaux produits par les agents qui tournent sur le poste
   (source : `~/logs/`, copie en lecture seule ici).
2. **Documentation** de la flotte d'agents : qui tourne, pourquoi, déclenché par
   quoi, et ce que chaque journal contient.
3. **Traçabilité** de la chaîne d'incidents Kafka, de la panne simulée jusqu'au
   rapport d'agent.

Rien ici n'est exécutable : ce dépôt est un miroir. Les scripts vivent dans
`~/bin/` et `~/aiven-kafka-demo/`.

---

## 1. Vue d'ensemble — une seule chaîne

```
  PRODUCTEURS                    BUS                    DÉCISION              AGENTS
┌──────────────────┐      ┌──────────────┐      ┌─────────────────┐    ┌──────────────────┐
│ ./seed           │      │ otel.traces  │      │ kafka-incident- │    │ opencode run     │
│ emit_sql_error   │─────▶│ otel.logs    │─────▶│ watch           │───▶│ --agent <nom>    │
│ db_fault_probe   │      │ events       │      │                 │    │                  │
│ (vraie base PG)  │      └──────────────┘      │ lit routes.yaml │    │ 1 des 6          │
└──────────────────┘                            └─────────────────┘    │ spécialistes     │
                                                         │            └────────┬─────────┘
                                                         │                     │
                                                         ▼                     ▼
                                                ┌─────────────────┐   ┌──────────────────┐
                                                │ otel-reports    │   │ ~/logs/incidents │
                                                └────────┬────────┘   └────────┬─────────┘
                                                         │                     │
                                                         ▼                     ▼
                                                ┌─────────────────┐   ┌──────────────────┐
                                                │ console web     │   │ sync-logs.sh     │
                                                │ (Vercel)        │   │ → ce dépôt       │
                                                └─────────────────┘   └──────────────────┘
```

**En une phrase** : une panne (réelle ou simulée) est publiée sur Kafka, un
watcher lit le message, choisit un agent dans une table de routage YAML, lance
cet agent avec la preuve à examiner, et le rapport atterrit à la fois sur le
bus (`otel-reports`, pour la console web) et dans `~/logs/incidents/`
(pour ce dépôt).

---

## 2. Les quatre runtimes d'agents

Quatre moteurs d'agent coexistent sur le poste. Ils **ne partagent aucune
configuration** : ce sont quatre installations indépendantes.

| Runtime | Binaire | Rôle | État |
|---|---|---|---|
| **OpenCode** | `~/.opencode/bin/opencode` v2.1.1 | Runtime principal : la flotte d'incidents Kafka, les sous-agents de dev | **actif** — serveur `opencode serve --service` |
| **[CC]** | `~/.local/bin/claude` 2.1.308 | Assistant interactif de développement (TUI) | **actif** — 3 sessions TUI |
| **ZeroClaw** | `zerocode` + daemon local | Passerelle d'agents distante (WSS/mTLS) | **arrêté** — daemon non lancé |
| **Aiden** | `aiden-runtime` 4.21.3 (Node) | Agent autonome local-first, daemon `127.0.0.1:4200` | **actif** — `aiden.service` |

### 2.1 OpenCode — le runtime qui compte

C'est lui qui porte toute la mécanique d'incidents. Deux composants :

- **le serveur** : `opencode serve --service`, écoute en **loopback** (port
  éphémère, découvert via `~/.config/opencode/service.json`). C'est lui qui
  exécute les sessions — un agent lancé en détaché survit à la fermeture du
  terminal, parce qu'il vit dans le serveur.
- **la CLI** : `opencode run` (un tour, avant-plan) et `opencode api` (appels
  HTTP directs au serveur).

Configuration : `~/.config/opencode/opencode.json` (modèle par défaut,
épinglage des modèles par agent, définition du provider) et
`~/.config/opencode/AGENTS.md` (instructions globales : délégation,
parallélisation, conduite).

#### Le provider

Le modèle par défaut est **`inferhub/combo/cheap`**, servi par un endpoint
compatible OpenAI (`https://api.inferhub.dev/v1`), clé lue depuis la variable
d'environnement `INFERHUB_API_KEY`. Trois agents sont épinglés sur des modèles
gratuits plus rapides :

| Agent | Modèle épinglé | Raison |
|---|---|---|
| `explore` | `opencode/deepseek-v4.1-flash-free` | exploration de code, volume élevé |
| `researcher` | `opencode/deepseek-v4.1-flash-free` | recherche web + dépôt |
| `test-runner` | `opencode/deepseek-v4.1-flash-free` | exécution de suites, sortie verbeuse |
| `code-reviewer` | `opencode/glm-5.3-flash-free` | relecture de diff |

Les six agents d'incident et `kafka-watch` **n'ont pas de champ `model:`** :
ils héritent du défaut `inferhub/combo/cheap`.

### 2.2 [CC] — l'assistant interactif

Installation native (`installMethod: native`), mises à jour automatiques
désactivées. Réglages dans `~/.claude/settings.json` :

| Réglage | Valeur | Effet |
|---|---|---|
| `defaultMode` | `bypassPermissions` | aucune demande de confirmation |
| `effortLevel` / `maxEffortLevel` | `xhigh` / `max` | budget de raisonnement maximal |
| `enabledPlugins` | `vercel@claude-plugins-official` | plugin Vercel |

**Un seul serveur MCP** est branché : `vercel` (type `http`,
`https://mcp.vercel.com`, authentification OAuth). Il n'y a **aucun**
`mcpServers` utilisateur et aucun `.mcp.json` de projet.

Les sessions sont enregistrées dans `~/.claude/projects/-home-baptistefaisy/`
(transcriptions `.jsonl`) avec une mémoire longue dans `memory/MEMORY.md`.
Chaque session vivante a son socket dans `/run/user/1000/cc-socks/<pid>.sock`
et son descripteur dans `~/.claude/sessions/<pid>.json`.

> **Pas de pont entre [CC] et OpenCode.** Aucun script de `~/bin/` n'invoque
> `claude` ; les deux ne partagent ni modèle, ni serveur, ni configuration. Le
> seul lien est documentaire : une note de mémoire [CC] explique comment lire
> la base SQLite d'OpenCode (`~/.local/share/opencode/opencode.db`, en lecture
> seule).

### 2.3 ZeroClaw — la passerelle distante

Chaîne séparée, **actuellement à l'arrêt** (le daemon n'écoute pas, son état
pointe un PID mort).

- `~/.zeroclaw/` — le **daemon local** : deux alias d'agents (`a` sur
  OpenRouter, `b` sur InferHub), un profil de risque `yolo`, un webhook sur
  `127.0.0.1:42617`, un plan de contrôle SQLite (`data/`), du TLS.
- `~/.zeroclaw-remote/` — le **client** vers un daemon distant : mTLS
  (`ca.crt`, `client.crt/key`), jeton WSS.
- `~/bin/zc-run` — one-shot : POST sur le webhook local avec l'alias d'agent.
- `~/bin/zc-ms` — TUI `zerocode` branchée sur le daemon distant.

### 2.4 Aiden — l'agent autonome

`aiden.service` (systemd utilisateur) fait tourner `aiden-runtime` en mode
daemon sur `127.0.0.1:4200`, avec `Restart=always` et un backoff progressif.
Branché sur le **même endpoint InferHub** qu'OpenCode, mais **sans aucun lien**
avec Kafka ni avec la flotte d'incidents. Détails d'installation :
`~/AIDEN-SETUP.md`.

> ⚠️ Le paquet npm `aiden` n'est **pas** Aiden (c'est un autre projet, binaire
> `ai`). Le bon paquet est `aiden-runtime`.

---

## 3. La flotte OpenCode — 10 agents utiles

### 3.1 Les agents du projet d'incidents

Source de vérité : `~/aiven-kafka-demo/agents/*.md`. Ces fichiers sont
**liés symboliquement** dans `~/.config/opencode/agents/` — une seule copie,
deux points d'entrée.

| Agent | Rôle | Format de réponse imposé |
|---|---|---|
| `incident-watch` | **Orchestrateur** : lit `routes.yaml`, délègue au spécialiste, consolide | `PANNIE` / `CAUSE` / `PREUVES` / `ACTION` + ligne `DELEGATION :` |
| `kafka-diagnose` | Panne du **broker** : injoignable, ISR, partitions offline, ACL | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |
| `db-diagnose` | Panne **base de données** : pool saturé, timeout, credentials, SQLSTATE | 4 blocs + tableau SQLSTATE + « ce qu'on ne peut PAS conclure » |
| `runtime-diagnose` | Panne **machine/JVM** : OOM, heap, disque plein | 4 blocs |
| `cache-diagnose` | **Cache** : tempêtes de miss, invalidation | 4 blocs |
| `policy-review` | Bug de **politique de l'agent** : promesse non tenue, boucle de retry, donnée périmée | 4 blocs |

### 3.2 Les agents de développement

Fichiers réels (non liés) dans `~/.config/opencode/agents/` :

| Agent | Rôle | Format |
|---|---|---|
| `kafka-watch` | État du cluster à la demande ; lit le log du broker, peut le **relancer** | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |
| `code-reviewer` | Relit un diff, classe par gravité, lecture seule | liste par sévérité, ou « Aucun problème trouvé. » |
| `researcher` | Recherche code + web, synthèse sourcée, lecture seule | `REPONSE` / `PREUVES` / `INCERTITUDES` |
| `test-runner` | Lance build + tests, tranche régression vs. test préexistant | `COMMANDE` / `RESULTAT` / `ECHECS` / `REGRESSION` |

Plus les agents **intégrés** d'OpenCode, disponibles partout : `build` (défaut,
toutes permissions), `plan` (analyse seule), `explore` (recherche rapide dans
un dépôt), `general` (multi-étapes, ne peut pas déléguer), et les agents
internes `compaction`, `title`, `summary`.

### 3.3 `kafka-watch` ≠ `kafka-diagnose`

La confusion est fréquente, la frontière est nette :

| | `kafka-watch` | `kafka-diagnose` |
|---|---|---|
| Déclencheur | **vous**, à la main | le **watcher**, sur incident |
| Portée | état **général** du cluster | **une** trace précise |
| Outil principal | `kafka-health --deep --json` | `trace-dump <traceId> --detectors` |
| Peut agir ? | **oui**, peut relancer le broker | **non**, diagnostic seulement |
| Budget | 10 étapes | 16 étapes |

### 3.4 Commandes globales

Dans `~/.config/opencode/commands/` :

| Commande | Effet |
|---|---|
| `/fanout <sujet>` | découpe le sujet et lance 2 à 5 sous-agents **en parallèle** |
| `/research <question>` | 2-3 chercheurs en parallèle, puis synthèse sourcée |
| `/review` | passe le diff courant au sous-agent `code-reviewer` |

### 3.5 `oc` — piloter un agent depuis le terminal

`~/bin/oc` parle directement à l'API v2 du serveur OpenCode. La session vit
dans le serveur : aucun processus à maintenir en vie.

```bash
oc "explique ce repo"                       # avant-plan, sortie en direct
oc start -d ~/projet -t "audit" "relis…"    # détaché, affiche l'id de session
oc status            # ce qui tourne (--mine : seulement via oc)
oc wait ses_xxx 600  # attend la fin (timeout 10 min)
oc result ses_xxx    # réponse finale
oc log ses_xxx       # transcription lisible
oc stop ses_xxx      # interrompt
```

`oc start` pose par défaut des permissions **allow-all** (équivalent
`opencode run --auto`) : sans client pour répondre aux demandes de permission,
une session détachée resterait bloquée. `--no-auto` pour ne pas y toucher.

Endpoints utilisés : `POST /api/session`, `POST /api/session/{id}/prompt`,
`GET /api/session/active`, `GET /api/session/{id}`, `POST /api/session/{id}/interrupt`.

### 3.6 Anomalie connue — 9 agents fantômes

Le dossier `~/.config/opencode/agents/.bak-20261022/` (sauvegarde du 22/10
09:15, avant le passage aux liens symboliques) est **chargé comme un dossier
d'agents**. OpenCode expose donc 26 agents au lieu de 17, dont 9 doublons
préfixés `.bak-20261022/` (`code-reviewer`, `db-diagnose`, `incident-watch`,
`kafka-diagnose`, `kafka-watch`, `policy-review`, `researcher`,
`runtime-diagnose`, `test-runner`).

Sans effet sur le routage — `routes.yaml` désigne les noms **sans** préfixe —
mais ils apparaissent dans la liste des agents et peuvent être invoqués par
erreur. Correctif : déplacer la sauvegarde hors de `agents/`
(ex. `~/.config/opencode/backups/`).

---

## 4. La chaîne d'incidents Kafka

### 4.1 Les producteurs

Tous dans `~/aiven-kafka-demo/`. Ils publient des messages au format OTLP sur
le bus local.

| Outil | Ce qu'il produit |
|---|---|
| `./seed --emit <id>` | rejoue un **scénario** du catalogue (5 pannes + run nominal) |
| `tools/emit_sql_error.py` | publie une **vraie** erreur PostgreSQL (SQLSTATE capturé par le serveur) |
| `tools/emit_db_errors.py` | vide la base d'erreurs `pg-erreurs` vers Kafka (motif *transactional outbox*) |
| `tools/db_fault_probe.py` | **provoque** réellement 13 pannes en base et remonte le résultat |
| `tools/emit_incident.py` | publie un incident ad hoc |

Les 6 scénarios du catalogue (`scenarios/catalog.json`) :
`platform_db_pool_exhausted`, `platform_db_connection_timeout`,
`platform_kafka_broker_unreachable`, `platform_oom`, `platform_disk_full`,
`healthy`.

### 4.2 Les topics

| Topic | Contenu |
|---|---|
| `otel.traces` | spans au format OTLP — c'est là que vivent les `TraceId` |
| `otel.logs` | logs applicatifs, avec `SeverityText` et attributs |
| `events` | événements applicatifs |
| `otel-reports` | **sortie** : les rapports d'agents republiés pour la console |

Le préfixe `otel` est configurable (`KAFKA_TOPIC_PREFIX`), ce qui permet de
faire coexister plusieurs jeux de topics.

### 4.3 Le watcher — `tools/kafka-incident-watch`

C'est le **déclencheur**. Service `kafka-incident-watch.service`, lancé avec
`--from earliest` et `Restart=always`.

**Ce qui déclenche un incident :**
- un log `SeverityText` = `ERROR`, `FATAL` **ou `WARN`** portant un
  `error.type` non vide dans ses attributs, **ou**
- un span avec `StatusCode = "Error"` et un `error.type`.

**Ce qu'il fait ensuite :**

1. Résout l'agent : `routes[error.type]`, à défaut `default_agent`. **Aucun
   `if error.type == …` en dur dans le code** — c'est le principe « zéro code ».
2. Lance : `opencode run --agent <agent> --auto --format json
   --title "[<error.type>] <traceId[:8]>" "<prompt>"`, répertoire de travail
   `~/aiven-kafka-demo`.
3. Écrit la sortie dans `~/logs/incidents/<UTC>-<trace8>-<agent>.log` (JSONL
   d'OpenCode ; le rapport final est la dernière partie `type=text`).
4. Republie le rapport sur `otel-reports`.

**Garde-fous** (variables d'environnement) :

| Variable | Défaut | Rôle |
|---|---|---|
| `WATCHER_MAX_CONCURRENT` | 2 | agents simultanés |
| `WATCHER_MAX_PER_HOUR` | 6 | plafond horaire |
| `WATCHER_COOLDOWN_TRACE_S` | 300 | pas de re-traitement de la même trace |
| `WATCHER_COOLDOWN_ERROR_S` | 1800 | même `error.type` |
| `WATCHER_AGENT_TIMEOUT_S` | 900 | au-delà, l'agent est coupé |

Un `flock` garantit une instance unique ; l'état (offsets, cooldowns) est
persisté dans `~/.local/state/kafka-incident-watch/<hash>.json`.

### 4.4 `routes.yaml` — la table de routage

Le fichier `~/aiven-kafka-demo/routes.yaml` (lié dans
`~/.config/opencode/`) contient **30 routes** + un `default_agent`.

```yaml
default_agent: incident-watch

routes:
  kafka_broker_unreachable: kafka-diagnose
  db_pool_exhausted:        db-diagnose
  oom:                      runtime-diagnose
  disk_full:                runtime-diagnose
  rate_limit:               policy-review
  cache_miss_storm:         cache-diagnose
  db_undefined_table:       db-diagnose     # SQLSTATE réels
  …
```

**Ajouter un agent = ajouter un `.md` dans `agents/` + une ligne ici.** Aucune
ligne du watcher n'est touchée. Les 30 routes couvrent : les 5 pannes de
plateforme, les variantes de nommage (`broker_unreachable`, `timeout`…), les
pannes de politique de l'agent (`rate_limit`, `silent_failure`,
`stale_source`), les erreurs SQL réelles (`db_*`, 10 SQLSTATE) et
`cache_miss_storm`.

### 4.5 Les preuves — `trace-dump`

`~/bin/trace-dump <TRACE_ID>` est **obligatoire** avant toute conclusion
d'agent : il lit `otel.traces` / `otel.logs` et applique trois détecteurs.

| Détecteur | Ce qu'il cherche |
|---|---|
| `retry_spiral` | même appel réessayé en boucle |
| `silent_failure` | l'agent répond « succès » sans avoir rien confirmé |
| `stale_source` | la donnée servie est plus ancienne que la requête |

Options : `--detectors` (défaut, lisible), `--json` (machine), `--list`.

### 4.6 La console web

`~/aiven-kafka-demo/site/` — application statique + fonctions serverless
(Vercel, projet `site`). Trois endpoints :

| Route | Rôle | Budget |
|---|---|---|
| `api/health.js` | état du cluster | 15 s |
| `api/incident.js` | dernier incident / trace | 60 s |
| `api/report.js` | rapports publiés sur `otel-reports` | 60 s |

Elle lit le bus Kafka et affiche les rapports d'agents. Un **repli local**
existe (`tools/site-server.py`) pour travailler sans réseau.

---

## 5. Services et timers systemd (utilisateur)

| Unité | Type | Déclencheur | Rôle |
|---|---|---|---|
| `kafka.service` | simple | permanent | broker KRaft local, single-node, `-Xmx640M`, données dans `~/.local/opt/kafka` |
| `kafka-incident-watch.service` | simple | permanent | le watcher (cf. §4.3) |
| `kafka-health.timer` → `.service` | timer | **toutes les 1 min** | `kafka-health localhost:9092 --deep --json` → `~/logs/kafka-health.log` |
| `log-sync.timer` → `.service` | timer | **toutes les 10 min** | copie `~/logs/` → ce dépôt, scan de secrets, commit, push SSH |
| `aiden.service` | simple | permanent | daemon Aiden (cf. §2.4) |

`log-sync.timer` a `Persistent=true` : un tick manqué est rejoué au démarrage
suivant.

---

## 6. Inventaire des journaux

Tous produits dans `~/logs/`, copiés ici. **Format et producteur** :

### `kafka-health.log` — ~340 Ko, ~10 400 lignes *(croît d'une sonde/minute)*

Producteur : `kafka-health.timer` → `bin/kafka-health --deep --json`.

Ce fichier mélange **deux formats**, il faut le savoir avant de le parser :

**Format 1 — sonde courte, une ligne JSON** (les 422 premières lignes) :

```json
{"state":"DOWN","ok":false,"bootstrap":"localhost:9092","tcp_reachable":false,
 "deep_checked":true,"duration_ms":9.0,"timestamp":"2026-10-21T19:42:16+0200",
 "findings":[{"level":"error","code":"tcp_unreachable","msg":"Aucun bootstrap joignable…"}]}
```

Champs à lire : `state` (`UP`/`DEGRADED`/`DOWN`), `ok`, `tcp_reachable`,
`findings[]` (`level`, `code`, `msg`). Codes de sonde vus : `tcp_ok`,
`tcp_unreachable`, `brokers`, `topics`.

**Format 2 — rapport profond, JSON indenté sur plusieurs lignes** (à partir de
la ligne 423) : `topics{partitions, topic_id, detail[leader, replicas, isrs]}`,
`brokers[{id, host, port}]`, `consumer_groups[{group_id, state}]`
(`EMPTY` / `STABLE`), `expected_topics`, `missing_topics`, `warnings`.

> ⚠️ Ce fichier n'est **pas** du JSONL pur : `jq` ligne à ligne échoue sur la
> partie indentée. Les erreurs du client librdkafka (`%5|epoch|REQTMOUT|…`) y
> sont aussi entremêlées, plus des `{"ok":false,"error":"kafka_unreachable"}`.

Codes de sortie du script : `0` OK, `1` usage, `2` config, `3` DOWN.

### `decision-router.log` — 120 Ko, 565 lignes — *historique*

Producteur : `~/bin/decision-router --port 8799`, routeur local interposé
entre `phone-task` et le gateway Vercel. **Le script a été supprimé le 21/10**
(unit archivée dans `cleanup-20261021-121324/`) : ce journal **n'évolue plus**,
c'est une archive. **Aucun lien avec OpenCode** (zéro occurrence
`agent`/`session`).

Une ligne JSON par événement. Trois types :

```json
{"at":"2026-10-21T01:24:31","event":"fail","model":"winnow:e4b","status":0,
 "kind":"transient","cooldown":30,"detail":"[Errno 111] Connection refused"}
{"at":"2026-10-21T01:25:30","event":"route","model":"perplexity/pplx-decider-v1.2",
 "ms":1445,"attempts":2,"tokens":1553}
{"at":"2026-10-21T14:25:16","event":"race","model":"perplexity/pplx-decider-flash-v1.2",
 "chosen":"perplexity/pplx-decider-flash-v1.2","ms":556,"raced":3,"tokens":6009}
```

| `event` | Sens | Champs propres |
|---|---|---|
| `fail` | un modèle a échoué | `status`, `kind`, `cooldown`, `detail` |
| `route` | un modèle a répondu | `ms`, `attempts`, `tokens` |
| `race` | course de plusieurs modèles | `chosen` (gagnant), `raced` (nb concurrents) |

`kind` : `transient`, `restricted`, `rejected`, `missing`, `error`.
17 modèles distincts, courses de 3.

### `api-audit.log` — 11 Ko, 67 lignes — *historique*

Producteur : l'API HTTP locale du harnais téléphone (`phone-api.service`,
port `8787`). **Script retiré depuis** : archive, n'évolue plus.

Une ligne JSON par requête HTTP ou cycle de vie :

```json
{"ts":"2026-10-21T00:36:28+02:00","event":"request","method":"GET","path":"/health",
 "client":"127.0.0.1","user":"…","authorized":true,"reason":null}
{"ts":"2026-10-21T11:48:04+02:00","event":"start","port":8787,"serial":"…","pid":651086}
```

`event` : `request` (42), `state` (14), `start` (10), `shell` (1).
Routes : `/health`, `/state`, `/status`, `/audit`, `/shell`, `/logcat`,
`/install`. `authorized` a toujours été `true` — aucun refus enregistré.
Utile pour corréler un incident avec un appel API précis.

### `historique-pg.log` — 8 Ko, 6 entrées

Producteur : un **agent OpenCode** — ce ne sont pas des lignes automatiques
mais des entrées narratives rédigées à la main (préfixe `[agent-opencode]`).
Le fichier n'est donc **pas strictement chronologique**.

Format **texte**, un bloc = une date + un titre, puis des puces indentées :

```
2026-10-22T01:40:00+02:00 [agent-opencode] PROMPT-HISTORIQUE-PGROUCHE.md : version 3 reecrite
  - etat verifie : service Aiven "pg-memoire" ABSENT (0 service dans …) -> prompt v1 obsolete
```

Il trace les **opérations Aiven/SQL** sans jamais citer de SQL brut :
recréation de `pg-memoire` / `valkey-memoire`, plans, `service_uri_params`,
`avn service database-create`, extensions (`citext`, `pg_trgm`, `unaccent`),
migration v1→v2 (11→6 colonnes, 8→6 fonctions), `DATABASE_URL`, tests
(`occurrences=2`, `format_ok`), push GitHub.

### `incidents/` — 33 fichiers au moment de la rédaction (5 `.prompt`, 28 `.log`)

Deux familles :

- `<UTC>-<trace8>-<agent>.prompt` — le **prompt exact** envoyé à l'agent :
  `topic`, `TraceId`, `severite`, `error.type`, `horodatage`, `scenario`,
  `profil`, `message`, `attributs`, puis le bloc `PREUVE (obligatoire)` qui
  impose `trace-dump`, et le format de réponse attendu.
- `<UTC>-<trace8>-<agent>.log` — la **transcription JSONL** d'OpenCode
  (`step_start`, `text`, `tool_use`, `step_finish`). Le rapport final est la
  dernière partie `type=text`.

C'est la pièce la plus utile pour comprendre *pourquoi* un agent a conclu ce
qu'il a conclu : on a l'entrée (`.prompt`) et la sortie (`.log`).

### `scope-watch.log` — 16 Ko, 237 lignes — *historique*

Producteur : `~/bin/scope-watch` (boucle de 60 s), chien de garde du miroir
ScreenScope + ADB. **Script supprimé le 21/10** et unit **neutralisée** par un
drop-in (`ExecStart=/bin/false`) : archive. Format texte :

```
2026-10-21T02:32:12 etat: miroir=True adb=False launlse
2026-10-21T02:32:12 adb toujours injoignable (le 'debogage sans fil' est-il actif ?)
```

6 redémarrages du service d'accessibilité enregistrés.

### `phone-auto.log`, `phone-watch.log`, `phone-wait-adb.log` — *historique*

Déploiement et supervision des agents téléphone (helpers et services poussés
sur les machines USB, attente d'`adb`). Producteurs supprimés le 21/10.

| Fichier | Lignes | Contenu |
|---|---|---|
| `phone-watch.log` | 35 | heartbeat 10 min : `heartbeat etat=device serial=…`, `[OK] telephone connecte`, `[KO] etat=absent` |
| `phone-auto.log` | 84 | déploiement : `deploiement des helpers et services sur les machines USB`, `telephone non joignable : branche-le en USB sur baptiste@…` |
| `phone-wait-adb.log` | 2 | guet de `100.79.244.93:5555` (timeout 900 s) puis `timeout : le telephone n'ecoute toujours pas` |

### `suite-pilot2.log`, `suite-pilot3.log` — *historique*

Banc de suites du harnais mobile (`phone-task`), rapports détaillés dans
`~/.phone-tasks/suite/`. Format :

```
[1/4] settings-night-mode-on
      ECHEC  (2 tours, 4160 ms)  [boucle] cmd '...' -> '0' (attendu {'equals': '2'})
=== 1/4 reussies (25.0 %) — moyenne 2.5 tours — $0.004080
echecs : boucle=3
```

`pilot2` = 4 tests terminés (21/10 03:25) ; `pilot3` = 1 ligne, exécution
interrompue.

> **Producteurs disparus.** `decision-router`, `scope-watch`, `phone-watch`,
> `phone-auto`, `phone-api` ont été **supprimés le 21/10**. Leurs units sont
> archivées dans `cleanup-20261021-121324/*.service` et `restore.sh` (dans
> `cleanup-20261021-131324/`) permet de les réactiver. Les journaux
> correspondants ci-dessus sont donc des **archives figées**, pas des flux
> vivants. Seuls `kafka-health.log`, `incidents/` et `log-sync.log` sont
> encore alimentés.

### `cleanup-*/` et `pre-kill-*/`

**Captures d'état**, pas des journaux au fil de l'eau : listes de processus,
ports ouverts, fichiers temporaires, prises juste **avant** un nettoyage
(`cleanup-20261021-*`) ou un arrêt de processus (`pre-kill-20261021-*`). Elles
servent de point de comparaison si quelque chose casse après l'opération.

---

## 7. Synchronisation vers GitHub

### Le mécanisme

`~/bin/sync-logs.sh`, déclenché par `log-sync.timer` toutes les 10 minutes :

1. **Verrou** `flock` — une seule instance à la fois.
2. **Copie** `cp -a ~/logs/. → ~/Log/`, puis suppression de `log-sync.log`
   (il change à chaque tick et produirait un commit vide).
3. **Scan de secrets bloquant** — `~/bin/scan-secrets.py`. Si un secret est
   trouvé : **rien n'est committé ni poussé**, l'incident est journalisé.
4. **Commit + push SSH** vers `git@github.com:BaptisteFaisy/Log.git`, branche
   `main`.

### Le scan de secrets

`scan-secrets.py` combine deux détections :

- **valeurs réelles** lues sur la machine (fichiers de credentials, jetons
  GitHub, mots de passe Aiven) — comparaison littérale. Depuis le 22/10, les
  fichiers d'environnement de la démo Kafka sont lus aussi
  (`~/aiven-kafka-demo/env*.sh`, `.secrets/*.env`, `.creds.json`), mais
  uniquement pour les clés qui portent un secret (`*PASS*`, `*SECRET*`,
  `*TOKEN*`, `*CREDENTIAL*`, `*PRIVATE*`) : `KAFKA_SERVICE` ou `PGDATABASE`
  ne sont pas confidentiels et noieraient le signal ;
- **motifs** : `gho_/ghp_/ghu_/ghs_`, `github_pat_`, `aivenv1`, `avnpw_`,
  `AVNS_` (mot de passe de service Aiven), `sk-…`, mots de passe dans une URL
  `postgres://user:pw@…`, `Bearer …`, chaînes hex de 24 caractères, clés
  privées PEM.

Il n'affiche **jamais** la valeur d'un secret : seulement sa nature et sa
position. Sortie `0` = propre, `1` = secret détecté.

`log-sync.log` (416 lignes) en garde la trace : 8 push réussis, 1
`SECRET DETECTE … PUSH ANNULE`, 3 échecs. Ce journal n'est **pas versionné**
(cf. `.gitignore`) — il changerait à chaque tick.

### ✅ Incident du 22/10 10:13 — résolu (mot de passe Aiven dans les logs)

`log-sync.service` était en échec : 4 commits locaux non publiés (dépôt distant
arrêté à `0d85386`). Le scan local disait « PROPRE » mais le *secret scanning*
de GitHub refusait le push (`GH013`).

Cause : un sous-agent a fait `cat env-agent-kafka.sh` et son transcript a été
journalisé dans `incidents/` — mot de passe SASL Aiven (`AVNS_…`) en clair dans
5 fichiers. Deux lacunes du garde-fou : `scan-secrets.py` ne connaissait ni le
motif `AVNS_`, ni les `env*.sh` de la démo comme source de valeurs secrètes.

Traitement (22/10 11:01) :

1. `scan-secrets.py` corrigé : motif `AVNS_` + sources `env*.sh` / `.creds.json`
   (clés sensibles seulement). Un contrôle d'index (`git show :<fichier>`) a
   été ajouté au passage : vérifier le contenu **indexé**, pas seulement le
   working tree.
2. Valeurs remplacées par `***REDACTED***` dans les 5 transcripts (`~/logs` et
   `~/Log`) — 74 remplacements, aucun secret affiché pendant l'opération.
3. Historique local réécrit : les 4 commits auto + le commit du générateur ont
   été rejoués sur `0d85386`, donc **le secret n'est jamais entré dans
   l'historique publié** (aucune de ces versions n'avait été poussée).
4. `log-sync.service` repassé au vert, `main` à jour.

Reste à faire, côté humain : **faire tourner le mot de passe SASL Aiven**
(`demo-app`), puis mettre à jour `env-agent-kafka.sh` et redémarrer
`kafka-incident-watch.service`. Le mot de passe a circulé dans des transcripts,
il doit être considéré comme compromis même s'il n'a jamais été publié.

Règle qui en sort : **ne jamais `cat` un `env*.sh`** (ni dans un sous-agent, ni
dans une commande dont la sortie est journalisée) — utiliser
`sed 's/=.*/=<redacted>/'` ou `grep -oE '^[A-Z_]+'`.

---

## 8. Bases de données

### 8.1 Base « historique » — mémoire de débogage partagée

Base PostgreSQL `historique` du service Aiven `pg-memoire` (plan `hobbyist`).
Chaque bug connu y est stocké sous forme d'un **nom + une résolution**, pour
que l'agent suivant confronté au même bug reparte d'une piste.

**Table `historique` — 6 colonnes :**

| colonne | type | rôle |
|---|---|---|
| `id` | `bigserial` PK | identifiant technique |
| `nom` | `citext` UNIQUE | le nom du problème (insensible à la casse) |
| `resolution` | `text` | la résolution (append enrichissant) |
| `occurrences` | `int` | nombre de résolutions cumulées |
| `created_at` | `timestamptz` | création |
| `updated_at` | `timestamptz` | dernière mise à jour |

3 extensions : `citext` (casse), `unaccent` (accents), `pg_trgm`
(reformulation). 4 index : PK, UNIQUE `nom`, trigram sur `nom`,
`updated_at DESC`.

**API — 6 fonctions SQL :**

| fonction | rôle |
|---|---|
| `historique_get(nom)` | lecture exacte, insensible à la casse |
| `historique_trouver(nom)` | recherche par ressemblance, la plus pertinente en 1ʳᵉ ligne |
| `historique_set(nom, résolution, écraser=false)` | création — **refuse** d'écraser une entrée existante |
| `historique_ajouter_resolution(nom, résolution)` | append atomique, `occurrences + 1` |
| `historique_liste(limite)` | listing, plus récents d'abord |
| `historique_export_data()` | export `(nom, résolution)` |

**Format du document** — un nom + une résolution. L'export produit un `.md`
par document, **nom en ligne 1**, résolution en ligne 2 :

```
Mot de passe PostgreSQL Aiven masque dans l'API
Cause racine : l'API Aiven masque les mots de passe en lecture… Correctif : reset-credentials…
```

Après un *append*, le fichier fait 4 lignes ou plus : nom, résolution
d'origine, séparateur horodaté `--- resolution complementaire <date> ---`,
puis la nouvelle résolution. La ligne 1 reste toujours le nom.

**Usage — sans SQL** (`scripts/historique_client.py`, projet MEMOIRE) :

```bash
cd /home/baptistefaisy/hackathon-memory

.venv/bin/python scripts/historique_client.py trouver "nom du problème"  # étape 1
.venv/bin/python scripts/historique_client.py get     "nom du problème"
.venv/bin/python scripts/historique_client.py ajouter "nom" "résolution"  # cas A
.venv/bin/python scripts/historique_client.py set     "nom" "résolution"  # cas B
```

Prompt d'usage de l'agent de débogage : `~/PROMPT-AGENT-DEBUG-HISTORIQUE.md`

### 8.2 Base `pg-erreurs` — le motif *transactional outbox*

Base PostgreSQL qui contient un catalogue d'erreurs. Une erreur insérée en
base est **publiée sur Kafka** par `tools/emit_db_errors.py`, avec le SQLSTATE
d'origine — ce qui permet de rejouer de vraies pannes dans la chaîne
d'incidents, sans les simuler.

- Schéma : `~/aiven-kafka-demo/db/erreurs_schema.sql`
- Jeu de départ : `db/erreurs_seed.sql`
- Décor de provocation : `db/erreurs_scratch.sql` (13 sondes réelles)

Le détail complet est dans `~/aiven-kafka-demo/README.md`, sections 12bis et
12ter.

### 8.3 Valkey — mémoire de travail court terme

Service Aiven `valkey-memoire` (plan `hobbyist`), TTL 86400 s.

> **Règle d'or** : host et port sont **toujours lus via l'API Aiven**
> (`service_uri_params`). Ils changent à chaque recréation de service, et un
> host codé en dur produit un `.env` inconnectable.

---

## 9. Infrastructure Aiven

| Service | Plan | Rôle |
|---|---|---|
| `pg-memoire` | `hobbyist` | PostgreSQL 18 — base `defaultdb` (application MEMOIRE) + base `historique` (mémoire de debug) |
| `valkey-memoire` | `hobbyist` | Valkey 7.2 — mémoire de travail court terme (TTL 86400 s) |
| `pg-erreurs` | gratuit | PostgreSQL — catalogue d'erreurs → outbox Kafka |
| `agent-kafka` | — | cluster Kafka managé (repli : cluster local si indisponible) |

Le cluster actif est dans un fichier d'état commun
(`{"active": "primary", "at": …}`), ce qui permet de basculer entre local et
managé sans changer les scripts.

---

## 10. Règles de sécurité

- **Aucun secret n'est versionné.** Jetons, mots de passe et URLs
  d'authentification sont filtrés avant chaque commit (cf. `.gitignore` et le
  scan bloquant du §7).
- **Un log qui contient un token est un incident, pas un push.**
- Les journaux sont **en lecture seule** ici : la source reste `~/logs/`.
- Le dépôt est **public** : chaque push est une publication. Relire le diff
  avant de pousser autre chose que des journaux.
- Poussée par **SSH** (clé sans expiration), branche `main`.
- Ne jamais coller un jeton dans un chat, un log ou un commit — y compris le
  contenu de `~/.config/gh/hosts.yml`.

---

## 11. Diagnostic rapide

```bash
# La chaîne tourne-t-elle ?
systemctl --user list-timers
systemctl --user status kafka-incident-watch.service log-sync.service

# Le broker répond-il ?
~/bin/kafka-health localhost:9092 --deep

# Que voit le watcher ?
journalctl --user -u kafka-incident-watch.service -n 50 --no-pager

# Quels incidents ont été traités ?
ls -lt ~/logs/incidents/ | head -20

# Pourquoi cet agent a-t-il conclu ça ?
cat ~/logs/incidents/<fichier>.prompt     # l'entrée
~/bin/trace-dump <traceId> --detectors    # la preuve
jq -r 'select(.type=="text") | .part.text' ~/logs/incidents/<fichier>.log | tail -40   # la sortie

# Sessions d'agents en cours
oc status

# État du dépôt et du push
cd ~/Log && git status --short && git log --oneline origin/main..HEAD
tail -20 ~/logs/log-sync.log
```

---

## 12. Arborescence

```
~/logs/                      source des journaux (lecture seule pour ce dépôt)
├── kafka-health.log         sonde Kafka, 1 ligne JSON / minute
├── decision-router.log      routage de modèles (course, échecs)
├── api-audit.log            audit des appels de l'API locale
├── historique-pg.log        maintenance de la base « historique »
├── scope-watch.log          veilleur de périmètre
├── phone-*.log              agents téléphone
├── suite-pilot*.log         suites de tests pilotes
├── incidents/               prompts + transcriptions des agents d'incident
├── cleanup-*/ pre-kill-*/   captures d'état avant nettoyage
└── log-sync.log             journal du sync (non versionné)

~/bin/                       outillage
├── oc                       lanceur/pilote de sessions OpenCode
├── kafka-health             sonde de cluster (→ aiven-kafka-demo)
├── trace-dump               extraction de preuves (→ aiven-kafka-demo)
├── sync-logs.sh             copie + scan + commit + push
├── scan-secrets.py          détection de secrets (bloquante)
├── zc-run, zc-ms            ZeroClaw
└── oc-remote, oc-remote-run OpenCode distant

~/.config/opencode/          configuration OpenCode
├── opencode.json            modèle par défaut, épinglage, provider
├── AGENTS.md                instructions globales
├── agents/                  10 agents (+ 9 fantômes dans .bak-20261022/)
├── commands/                /fanout, /research, /review
└── routes.yaml →            lien vers aiven-kafka-demo/routes.yaml

~/aiven-kafka-demo/          source de vérité de la chaîne d'incidents
├── agents/*.md              les 6 agents d'incident
├── routes.yaml              30 routes error.type → agent
├── tools/kafka-incident-watch   le watcher
├── tools/{emit_*,db_fault_probe,detectors}.py   producteurs + détecteurs
├── db/                      schémas et jeux d'erreurs
├── scenarios/               6 scénarios + catalogue
├── site/                    console web (Vercel)
└── README.md                documentation détaillée de la chaîne

~/.claude/                   configuration [CC]
├── settings.json            bypassPermissions, effort max, plugin vercel
├── projects/-home-baptistefaisy/   transcriptions + mémoire
└── sessions/<pid>.json      registres de sessions vivantes
```
