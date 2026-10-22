# Log — journaux et flotte d'agents du poste

Ce dépôt a **trois rôles** :

1. **Sauvegarde** des journaux produits par les agents qui tournent sur le poste
   (source : `~/logs/`, copie en lecture seule ici).
2. **Documentation** de la flotte d'agents : qui tourne, pourquoi, déclenché par
   quoi, et ce que chaque journal contient.
3. **Traçabilité** de la chaîne d'incidents Kafka, de la panne simulée jusqu'au
   rapport d'agent.

Pour les journaux, ce dépôt reste un miroir : les scripts de collecte vivent dans
`~/bin/` et `~/aiven-kafka-demo/`. Le site `log-lac-five.vercel.app` fait
exception : sa source est `site/` (voir §4.6).

> **État au 2026-10-22 15:15.** Tous les chiffres de ce document (agents, routes,
> tailles de journaux, services) ont été relevés à cette date sur la machine, pas
> recopiés d'une version antérieure. Les commandes de vérification sont données
> au §11 pour pouvoir les rafraîchir.

---

## 1. Vue d'ensemble — une seule chaîne

```
  PRODUCTEURS                    BUS (Aiven)           DÉCISION              AGENT
┌──────────────────┐      ┌──────────────┐      ┌─────────────────┐    ┌──────────────────┐
│ ./seed           │      │ otel.traces  │      │ kafka-incident- │    │ opencode run     │
│ emit_sql_error   │─────▶│ otel.logs    │─────▶│ watch           │───▶│ --agent <nom>    │
│ db_fault_probe   │      │ events       │      │                 │    │                  │
│ (vraie base PG)  │      └──────────────┘      │ lit routes.yaml │    │ debug-historique │
└──────────────────┘                            └─────────────────┘    │ (défaut) ou      │
                                                         │            │ 1 des 5          │
                                                         │            │ spécialistes     │
                                                         ▼            └────────┬─────────┘
                                                ┌─────────────────┐            │
                                                │ otel-reports    │◀───────────┘
                                                └────────┬────────┘
                                                         │
                            ┌────────────────────────────┴──────────────┐
                            ▼                                           ▼
                   ┌─────────────────┐                        ┌──────────────────┐
                   │ console web     │                        │ ~/logs/incidents │
                   │ (Vercel)        │                        │ → sync-logs.sh   │
                   └─────────────────┘                        │ → ce dépôt       │
                                                              └──────────────────┘
```

**En une phrase** : une panne (réelle ou simulée) est publiée sur Kafka, un
watcher lit le message, choisit un agent dans une table de routage YAML, lance
cet agent avec la preuve à examiner, et le rapport atterrit à la fois sur le
bus (`otel-reports`, pour la console web) et dans `~/logs/incidents/`
(pour ce dépôt).

**Le routage est en mode « agent unique » depuis le 2026-10-22** :
`routes.yaml` n'a plus aucune route spécifique, donc **tout** `error.type` part
vers `debug-historique` (l'agent qui consulte la mémoire PostgreSQL). Le mode
« un orchestrateur + 5 spécialistes » reste disponible, dormant, dans
`routes.specialistes.yaml` (cf. §4.4).

---

## 2. Les quatre runtimes d'agents

Quatre moteurs d'agent coexistent sur le poste. Ils **ne partagent aucune
configuration** : ce sont quatre installations indépendantes.

| Runtime | Binaire | Rôle | État vérifié le 22/10 15:15 |
|---|---|---|---|
| **OpenCode** | `~/.opencode/bin/opencode` v2.1.1 | Runtime principal : la flotte d'incidents Kafka, les sous-agents de dev | **actif** — serveur `opencode serve --service` |
| **[CC]** | `~/.local/bin/claude` 2.1.308 | Assistant interactif de développement (TUI) | **installé, aucune session ouverte** |
| **ZeroClaw** | `zerocode` 0.8.6 + daemon local | Passerelle d'agents distante (WSS/mTLS) | **arrêté** — `zeroclaw.service` inactive, rien n'écoute sur `42617` |
| **Aiden** | `aiden-runtime` 4.21.3 (Node) | Agent autonome local-first, daemon `127.0.0.1:4200` | **actif** — `aiden.service`, écoute confirmée |

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
compatible [OI] (`https://api.inferhub.dev/v1`), clé lue depuis la variable
d'environnement `INFERHUB_API_KEY`. Quatre agents sont épinglés sur des modèles
gratuits plus rapides :

| Agent | Modèle épinglé | Raison |
|---|---|---|
| `explore` | `opencode/deepseek-v4.1-flash-free` | exploration de code, volume élevé |
| `researcher` | `opencode/deepseek-v4.1-flash-free` | recherche web + dépôt |
| `test-runner` | `opencode/deepseek-v4.1-flash-free` | exécution de suites, sortie verbeuse |
| `code-reviewer` | `opencode/glm-5.3-flash-free` | relecture de diff |

Les sept agents d'incident et `kafka-watch` **n'ont pas de champ `model:`** :
ils héritent du défaut `inferhub/combo/cheap`.

`opencode.json` ne pose qu'une seule permission globale :
`subagent: * → allow`. Le reste est par défaut ; `cli.json` ajoute
`session.permissions: "autoaccept"` pour les sessions CLI.

#### Le plugin réseau `net-resilience`

Déclaré dans `plugins` de `opencode.json`
(`~/.config/opencode/plugins/net-resilience`). Il branche
`session.hook("retry")` et, **uniquement** pour
`error.type === "provider.transport"`, remplace le backoff d'OpenCode par
15 s → 30 s → 1 min → 1 min 30 → 2 min → 3 min → 4 min → 5 min (≈ 21 min de
fenêtre). Les erreurs d'auth, de quota et les 429 gardent la politique par
défaut. Ce plugin est **volontaire** : il absorbe les rafales `ECONNRESET` du
lien Wi-Fi/Crostini. Un message `Retrying in …s · attempt N` est donc le
backoff qui travaille, pas une panne. Contrôle :
`opencode api get /api/plugin` → `net-resilience` en `"status": "active"`.

### 2.2 [CC] — l'assistant interactif

Installation native (`installMethod: native`), mises à jour automatiques
désactivées. Réglages dans `~/.claude/settings.json` :

| Réglage | Valeur | Effet |
|---|---|---|
| `permissions.defaultMode` | `bypassPermissions` | aucune demande de confirmation |
| `effortLevel` / `maxEffortLevel` | `xhigh` / `max` | budget de raisonnement maximal |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | `max` | idem, forcé par l'environnement |
| `enabledPlugins` | `vercel@claude-plugins-official` | plugin Vercel |

**Un seul serveur MCP** est branché : `vercel` (type `http`,
`https://mcp.vercel.com`, authentification OAuth). Il n'y a **aucun**
`mcpServers` utilisateur et aucun `.mcp.json` de projet.

Les sessions sont enregistrées dans `~/.claude/projects/-home-baptistefaisy/`
(transcriptions `.jsonl`) avec une mémoire longue dans `memory/MEMORY.md`.
Chaque session vivante a son socket dans `/run/user/1000/cc-socks/<pid>.sock`
et son descripteur dans `~/.claude/sessions/<pid>.json`. **Au 22/10 15:15 :
zéro socket, zéro descripteur** — [CC] n'a aucune session en cours, il est
seulement disponible.

> **Pas de pont entre [CC] et OpenCode.** Aucun script de `~/bin/` n'invoque
> `claude` ; les deux ne partagent ni modèle, ni serveur, ni configuration. Le
> seul lien est documentaire : une note de mémoire [CC] explique comment lire
> la base SQLite d'OpenCode (`~/.local/share/opencode/opencode.db`, en lecture
> seule).

### 2.3 ZeroClaw — la passerelle distante

Chaîne séparée, **actuellement à l'arrêt** (`zeroclaw.service` inactive, rien
n'écoute sur `127.0.0.1:42617`).

- `~/.zeroclaw/` — le **daemon local** : deux alias d'agents (`a` sur
  OpenRouter, `b` sur InferHub), un profil de risque `yolo`, un webhook sur
  `127.0.0.1:42617`, un plan de contrôle SQLite (`data/`), du TLS.
- `~/.zeroclaw-remote/` — le **client** vers un daemon distant : mTLS
  (`ca.crt`, `client.crt/key`), jeton WSS.
- `~/bin/zc-run` — one-shot : POST sur le webhook local avec l'alias d'agent.
- `~/bin/zc-ms` — TUI `zerocode` branchée sur le daemon distant.

> ⚠️ La TUI et le daemon doivent être **exactement** de la même version
> (`0.8.6` ici) : le protocole de fil n'a aucune compatibilité croisée.

### 2.4 Aiden — l'agent autonome

`aiden.service` (systemd utilisateur) fait tourner `aiden-runtime` en mode
daemon sur `127.0.0.1:4200`, avec `Restart=always` et un backoff progressif.
Branché sur le **même endpoint InferHub** qu'OpenCode, mais **sans aucun lien**
avec Kafka ni avec la flotte d'incidents. Détails d'installation :
`~/AIDEN-SETUP.md`.

> ⚠️ Le paquet npm `aiden` n'est **pas** Aiden (c'est un autre projet, binaire
> `ai`). Le bon paquet est `aiden-runtime`.

---

## 3. La flotte OpenCode — 18 agents exposés, 11 agents métier

`opencode api get /api/agent` renvoie **18 agents** :

| Origine | Nombre | Détail |
|---|---|---|
| Agents intégrés | 7 | `build`, `plan`, `general`, `explore` + 3 internes cachés (`compaction`, `title`, `summary`) |
| Fichiers réels dans `~/.config/opencode/agents/` | 4 | `kafka-watch`, `code-reviewer`, `researcher`, `test-runner` |
| Liens symboliques vers `~/aiven-kafka-demo/agents/` | 7 | les 7 agents d'incident |

Les 11 agents « métier » (7 incidents + 4 développement) sont décrits dans
`~/aiven-kafka-demo/agents/group.json`, le **manifeste des groupes** — source
unique de l'appartenance agent → groupe → cas d'usage → machine d'origine.

| Groupe | Membres | Rôle du groupe |
|---|---|---|
| `debug-historique` | `debug-historique` | **actif** (`default: true`) : tous les incidents |
| `incident-triage` | `incident-watch` + 5 spécialistes | **dormant** : activé en copiant `routes.specialistes.yaml` |
| `poste-de-travail` | `code-reviewer`, `researcher`, `test-runner`, `kafka-watch` | lancement manuel, jamais routé |

`routes: true` dans le manifeste = l'agent peut recevoir un incident ;
`routes: false` = lancement manuel uniquement. Le watcher **relit ce fichier à
chaud** et l'utilise pour **estampiller les rapports** (`agent_group`,
`agent_use_case`, `agent_origin`, `agent_role`) ; il ne route jamais à partir de
là — le routage reste exclusivement dans `routes.yaml`. Un manifeste absent ou
cassé n'est **jamais bloquant** : les rapports sortent simplement sans les
champs de groupe.

### 3.1 Les agents d'incident (7 fichiers, `~/aiven-kafka-demo/agents/`)

Source de vérité : `~/aiven-kafka-demo/agents/*.md`. Ces fichiers sont
**liés symboliquement** dans `~/.config/opencode/agents/` — une seule copie,
deux points d'entrée.

| Agent | Groupe | `mode` | `steps` | Format de réponse imposé |
|---|---|---|---|---|
| `debug-historique` | debug-historique | `primary` | **80** | `PROBLÈME` / `CAUSE RACINE` / `PREUVES` / `HISTORIQUE` / `CORRECTIF` / `VÉRIFICATION` / `INCONNUES` |
| `incident-watch` | incident-triage | `all` | 26 | `PANNE` / `CAUSE` / `PREUVES` / `ACTION` + ligne `DELEGATION :` |
| `kafka-diagnose` | incident-triage | `subagent` | 16 | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |
| `db-diagnose` | incident-triage | `subagent` | 16 | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` / `PATCH` |
| `runtime-diagnose` | incident-triage | `subagent` | 16 | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |
| `cache-diagnose` | incident-triage | `subagent` | 16 | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |
| `policy-review` | incident-triage | `subagent` | 16 | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |

**Ce qui distingue chaque agent :**

| Agent | Mission | Outils imposés | Particularité |
|---|---|---|---|
| `debug-historique` | Recevoir seul chaque incident et produire un diagnostic appuyé sur la base de bugs historiques, avec **patch en brouillon** | `trace-dump`, `tools/pg-diag`, `scripts/historique_client.py`, `$LOG_PATCH_KEY` | Seul agent autorisé à **écrire** — uniquement sous `/tmp/opencode/*`. Attend jusqu'à 20 min une **décision humaine** avant d'appliquer quoi que ce soit |
| `incident-watch` | Orchestrateur : lit `routes.yaml`, délègue au spécialiste, consolide | `trace-dump` (**un seul appel shell**) | Interdit deux spécialistes en parallèle sur la même trace ; relance **une fois** un agent qui répond « hors de mon périmètre » |
| `kafka-diagnose` | Panne du **broker** : injoignable, ISR, partitions offline, ACL, TLS | `trace-dump`, puis `kafka-health --deep` **si le type l'exige** | Codifie les pièges : `ERR__TRANSPORT` invisible dans `list_topics` = ACL `Describe` manquante |
| `db-diagnose` | Panne **base de données** : connectique, pool, SQLSTATE d'exécution | `debug-bundle` (1 appel = tout), `trace-dump`, `pg-diag` (lecture seule), `patch-new`, `patch-validate` | Le plus fourni (169 lignes) : tableau SQLSTATE, discrimine « DDL non appliqué » / « mauvaise base » avant de corriger ; `--cause infra` est **refusé** par l'outil |
| `runtime-diagnose` | Panne **machine/JVM** : OOM, heap, disque plein | `trace-dump` + `df -h`, `free -m`, `ps` locaux | Seul à autoriser explicitement des commandes système locales |
| `cache-diagnose` | **Cache** : tempêtes de miss, invalidation | `trace-dump` uniquement | Protocole le plus léger (69 lignes), causes typées : froid / invalidation / taille / non partage |
| `policy-review` | Bug de **politique de l'agent** : promesse non tenue, boucle de retry, donnée périmée | `trace-dump` puis `agent.result` / `source.*` | Seul à trancher « agent vs infra », et à admettre explicitement « la trace ne permet pas de conclure » |

**Garde-fous communs aux 7 agents.** `edit` est refusé partout (sauf
`/tmp/opencode/*` pour `debug-historique`), les sous-agents sont refusés partout
sauf pour `incident-watch` (allow-list nominative des 5 spécialistes), et
**19 règles `deny` de secrets** sont posées en dernier — elles portent sur
`action: "*"`, donc read/grep/shell compris : `*env*.sh*`, `*.env*`,
`*.creds*`, `*.secrets*`, `*PASSWORD*`, `*printenv*`, `*hosts.yml*`,
`*aiven_token*`, `*gh-pat*`, `*service.json*`, `*.ssh/*`, etc.
`debug-historique` en ajoute trois ceintures : anti-dump d'environnement
(`set`, `declare -p`, `export -p`, `compgen -v`…), anti-fuite de
`$LOG_PATCH_KEY` (`curl -v`, `set -x`…), et refus de la décision humaine.

> **Coquilles connues dans les fichiers d'agent, non corrigées ici** :
> `incident-watch` écrit `PANNIE` dans son gabarit (au lieu de `PANNE`), et
> `db-diagnose` annonce « 3 blocs courts » alors qu'il en impose 5.

### 3.2 Les agents de développement

Fichiers réels (non liés) dans `~/.config/opencode/agents/` :

| Agent | `steps` | Rôle | Format |
|---|---|---|---|
| `kafka-watch` | 10 | État du cluster à la demande ; lit le log du broker, peut le **relancer** | `ETAT` / `CAUSE` / `PREUVES` / `ACTION` |
| `code-reviewer` | 15 | Relit un diff, classe par gravité, lecture seule | liste bloquant → important → mineur, ou exactement « Aucun problème trouvé. » |
| `researcher` | 12 | Recherche code + web, synthèse sourcée, lecture seule | `REPONSE` / `PREUVES` / `INCERTITUDES` |
| `test-runner` | 12 | Lance build + tests, tranche régression vs. test préexistant | `COMMANDE` / `RESULTAT` / `ECHECS` / `REGRESSION` |

Les quatre sont en `mode: subagent` et refusent `edit` et `subagent` : ils
rapportent, l'agent principal modifie.

### 3.3 Agents intégrés d'OpenCode

Disponibles partout, sans fichier de configuration : `build` (défaut, toutes
permissions), `plan` (analyse seule), `general` (multi-étapes, ne peut pas
déléguer), `explore` (recherche rapide dans un dépôt), et les trois agents
internes **cachés** que sont `compaction`, `title` et `summary`.

### 3.4 `kafka-watch` ≠ `kafka-diagnose`

La confusion est fréquente, la frontière est nette :

| | `kafka-watch` | `kafka-diagnose` |
|---|---|---|
| Déclencheur | **vous**, à la main | le **watcher**, sur incident |
| Portée | état **général** du cluster | **une** trace précise |
| Outil principal | `kafka-health --deep --json` | `trace-dump <traceId> --detectors` |
| Peut agir ? | **oui**, peut relancer le broker | **non**, diagnostic seulement |
| Budget | 10 étapes | 16 étapes |

### 3.5 Commandes globales

Dans `~/.config/opencode/commands/` :

| Commande | Effet |
|---|---|
| `/fanout <sujet>` | découpe le sujet et lance 2 à 5 sous-agents **en parallèle** |
| `/research <question>` | 2-3 chercheurs en parallèle, puis synthèse sourcée |
| `/review` | passe le diff courant au sous-agent `code-reviewer` |

### 3.6 `oc` — piloter un agent depuis le terminal

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

### 3.7 Anomalie corrigée — les « agents fantômes » n'existent plus

Une version antérieure de ce README décrivait 26 agents exposés, dont 9 doublons
préfixés `.bak-20261022/`. **Ce n'est plus le cas** : la sauvegarde a été
déplacée hors de `agents/`, et `ls -la ~/.config/opencode/agents/` ne montre
plus que 11 entrées `.md` (4 fichiers réels + 7 liens symboliques), sans
sous-dossier. `opencode api get /api/agent` renvoie 18 agents, chacun unique.

---

## 4. La chaîne d'incidents Kafka

### 4.1 Les producteurs

Tous dans `~/aiven-kafka-demo/`. Ils publient des messages au format OTLP sur
le bus Aiven.

| Outil | Ce qu'il produit |
|---|---|
| `./seed --emit <id>` | rejoue un **scénario** du catalogue (5 pannes + run nominal) |
| `tools/emit_sql_error.py` | publie une **vraie** erreur PostgreSQL (SQLSTATE capturé par le serveur) |
| `tools/emit_db_errors.py` | vide la base d'erreurs `pg-erreurs` vers Kafka (motif *transactional outbox*) |
| `tools/db_fault_probe.py` | **provoque** réellement 13 pannes en base et remonte le résultat |
| `tools/emit_incident.py` | publie un incident ad hoc |
| `tools/generator on\|off\|status` | arme/coupe le générateur d'erreurs continu |

Les 6 scénarios du catalogue (`scenarios/catalog.json`) :
`platform_db_pool_exhausted`, `platform_db_connection_timeout`,
`platform_kafka_broker_unreachable`, `platform_oom`, `platform_disk_full`,
`healthy`.

> **Le générateur se coupe tout seul.** `routes.yaml` porte
> `disable_generators_on_incident: true` : à chaque incident mis en file, le
> watcher **coupe** les générateurs d'erreurs (sans les supprimer), pour que la
> chaîne ne s'auto-alimente pas pendant qu'un agent travaille. Pour les
> relancer : `./tools/generator on`. `./tools/generator status` dit qui les a
> coupés, quand, et sur quel `error.type`.

### 4.2 Les topics

| Topic | Contenu |
|---|---|
| `otel.traces` | spans au format OTLP — c'est là que vivent les `TraceId` |
| `otel.logs` | logs applicatifs, avec `SeverityText` et attributs |
| `events` | événements applicatifs |
| `otel-reports` | **sortie** : les rapports d'agents republiés pour la console |

Le préfixe est configurable (`KAFKA_TOPIC_PREFIX`, défaut `otel`). Le topic de
republication est calculé, pas codé : `<préfixe>-reports`.

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
   `routes.yaml` est relu **à chaud**, sans redémarrage.
2. Lance : `opencode run --agent <agent> --auto --format json
   --title "[<error.type>] <traceId[:8]>"`, répertoire de travail
   `~/aiven-kafka-demo`.
   **Le prompt est passé sur `stdin`** (fichier temporaire anonyme), jamais en
   argument : en argument, `opencode` le stocke entre guillemets en échappant
   chaque `"` en `\"`, ce qui abîme les extraits shell et JSON du prompt
   (constaté le 2026-10-22).
3. Écrit la sortie dans `~/logs/incidents/<AAAAMMJJ-HHMMSS>-<trace8>-<agent>.log`
   (horodatage **UTC**, JSONL d'OpenCode ; le rapport final est la dernière
   partie `type=text`, avec repli sur les 8 000 derniers caractères bruts).
4. Republie le rapport sur `otel-reports`, estampillé des champs de groupe lus
   dans `agents/group.json`.

**Garde-fous** (variables d'environnement) :

| Variable | Défaut | Rôle | Valeur effective au 22/10 |
|---|---|---|---|
| `WATCHER_MAX_CONCURRENT` | 2 | agents simultanés | 2 |
| `WATCHER_MAX_PER_HOUR` | 6 | plafond horaire | **1 000 000** (drop-in, cf. ci-dessous) |
| `WATCHER_COOLDOWN_TRACE_S` | 300 | pas de re-traitement de la même trace | 300 |
| `WATCHER_COOLDOWN_ERROR_S` | 1800 | même `error.type` | 1800 |
| `WATCHER_AGENT_TIMEOUT_S` | 900 | au-delà, l'agent est coupé | **2700** (`agents.debug-historique.timeout_s`) |
| `WATCHER_WAIT_REMINDER_S` | 300 | rappel pendant l'attente d'un agent | 300 |
| `WATCHER_LAUNCH_RETRY_S` | 60 | ré-essai si le lancement échoue | 60 |
| `WATCHER_STATE_DIR` | `~/.local/state/kafka-incident-watch` | offsets + cooldowns | défaut |
| `WATCHER_INCIDENT_DIR` | `~/logs/incidents` | destination des transcripts | défaut |
| `WATCHER_ROUTES` / `WATCHER_GROUPS` | projet | `routes.yaml` / `group.json` | défaut |
| `WATCHER_DECISION_KEY_FILE` | `~/.secrets/patch-decision.key` | clé de la console de décision | défaut |

**Le plafond horaire a été levé le 22/10** (demande explicite), par le drop-in
`kafka-incident-watch.service.d/sans-plafond-horaire.conf`
(`WATCHER_MAX_PER_HOUR=1000000` — le code n'a pas de valeur « illimité », et `0`
bloquerait *tout*). Restent actifs : 2 agents simultanés et les deux cooldowns.
Retour à 6/h : supprimer le fichier, puis `daemon-reload` + `restart`.

L'environnement passé à l'agent est **filtré** : `SENSITIVE_ENV_NAMES`
(`KAFKA_PASSWORD`, `KAFKA_USERNAME`, `KAFKA_CA_PEM`, `SSH_AUTH_SOCK`), tout nom
contenant `PASSWORD`/`SECRET`/`TOKEN`/`KEY`/`CREDENTIAL`, tout préfixe `PG`, et
`LOG_PATCH_KEY` est retiré s'il vaut la clé de décision.

**Un seul agent par message (règle à ne pas régresser).** Si le même message
d'erreur réapparaît alors qu'un agent le traite déjà, **rien n'est relancé**.
C'est nécessaire parce qu'une erreur réémise repart avec un **nouveau
`TraceId`** : le cooldown par trace ne l'attrape pas. Le message est reconnu par
une empreinte `sha1(error.type + texte normalisé)` — ids, adresses, nombres et
durées sont masqués, donc « timeout après 312 ms » et « après 87 ms » sont le
même message. Trois verrous : message déjà en cours, message déjà en file,
doublon encore en attente. La même règle est appliquée dans la console web
(`site/app.js`). Preuve : `./tools/dedup-selftest` — **9 contrôles, 0 échec** au
22/10, sans Kafka — intégré à `./tools/check.sh` (étape 3bis). Détail :
`~/aiven-kafka-demo/README.md` §6.5.

Un `flock` garantit une instance unique ; l'état (offsets, cooldowns) est
persisté dans `~/.local/state/kafka-incident-watch/<hash>.json`.

### 4.4 `routes.yaml` — la table de routage

Le fichier `~/aiven-kafka-demo/routes.yaml` (lié dans
`~/.config/opencode/`) est en **mode « agent unique » depuis le 2026-10-22** :

```yaml
default_agent: debug-historique

disable_generators_on_incident: true

agents:
  debug-historique:
    prompt_file: /home/baptistefaisy/PROMPT-AGENT-DEBUG-HISTORIQUE.md
    timeout_s: 2700

# Aucune route specifique : chaque error.type tombe sur default_agent.
routes:
```

**Zéro route déclarée.** Tout `error.type` atterrit donc sur
`debug-historique`, dont le prompt complet est relu à chaque lancement
(`PROMPT-AGENT-DEBUG-HISTORIQUE.md`, jamais modifié par le watcher : l'incident
est injecté dans son bloc `<log>`, §5 « JOURNAL DU BUG »).

**Revenir au mode « un orchestrateur + 5 spécialistes »** :

```bash
cd ~/aiven-kafka-demo && cp routes.specialistes.yaml routes.yaml
```

`routes.specialistes.yaml` est la variante **dormante** : **32 routes** +
`default_agent: incident-watch`. Elle couvre les 5 pannes de plateforme, les
variantes de nommage (`broker_unreachable`, `timeout`…), les pannes de politique
de l'agent (`rate_limit`, `silent_failure`, `stale_source`), les erreurs SQL
réelles (`db_*`, 10 SQLSTATE) et `cache_miss_storm`. Le watcher signale
l'incohérence entre le manifeste de groupes et le routage actif
(`routing_group_mismatch`) sans jamais la traiter comme une erreur.

**Vérifier le routage sans Kafka** :

```bash
./tools/kafka-incident-watch --check-routes                  # état global
./tools/kafka-incident-watch --check-routes db_undefined_column   # un type précis
```

**Ajouter un agent = ajouter un `.md` dans `agents/` + une ligne dans
`routes.yaml` + une entrée dans `agents/group.json`.** Aucune ligne du watcher
n'est touchée.

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

**Deux applications distinctes**, à ne pas confondre :

**(a) La console de démonstration** — `~/aiven-kafka-demo/site/`, statique +
fonctions serverless (projet Vercel `site`). Quatre endpoints :

| Route | Rôle |
|---|---|
| `api/health.js` | état du cluster |
| `api/incident.js` | dernier incident / trace |
| `api/report.js` | rapports publiés sur `otel-reports` |
| `api/agents.js` | manifeste des groupes d'agents (`agents/group.json`) |

Elle lit le bus Kafka et affiche les rapports d'agents. Un **repli local**
existe (`tools/site-server.py`) pour travailler sans réseau.

**(b) Le site publié** — `https://log-lac-five.vercel.app`, projet Vercel
**`log`**, source `~/Log/site/` :

```bash
cd ~/Log/site
vercel deploy --prod --yes --global-config ~/.config/vercel-log
```

**Fonctions serverless du projet `log`** (`site/api/`, toutes en lecture seule
sauf `incident`) :

| Route | Rôle |
|---|---|
| `api/pg-memoire.js` | tables et colonnes de `historique`, 25 dernières lignes, cellules bornées à 8 000 caractères |
| `api/pg-memoire-row.js` | **une ligne entière** : `?db=&table=&id=&key=` (la popup « Plein écran » du guide) |
| `api/dump.js` | export `.sql` de la base (schéma + données, secrets masqués) |
| `api/tail.js` | les N derniers messages réels de `otel.logs` pour le terminal |
| `api/logs.js`, `api/kafka.js` | ingestion des lignes de console, état du cluster |
| `api/report.js`, `api/incident.js` | rapports d'agents, publication d'un incident |
| `_kafka.js`, `_redact.js` | modules partagés (client Kafka, masquage) — préfixe `_` = non exposés |

`pg-memoire-row` existe parce que la liste tronque les cellules : le tableau a
besoin de textes courts, la popup a besoin de la résolution complète. Elle
refuse toute table hors `PG_MEMOIRE_DATABASES`, tout nom de table hors
`[A-Za-z_][A-Za-z0-9_]{0,62}` et toute colonne de secret (`_redact.js`).

**Le bouton « Trigger an error log » lance un VRAI agent.** La chaîne complète,
vérifiée en production le 2026-10-22 :

```
navigateur → POST /api/incident {scenario:"platform_oom"}
           → site/api/incident.js publie le contrat du catalogue
             dans otel.traces + otel.logs + otel.metrics (clé = TraceId)
           → kafka-incident-watch (sur la machine) consomme et lance
             `opencode run --agent debug-historique` (vrai processus)
           → le watcher republie le rapport dans otel-reports
           → GET /api/report?trace_id=… renvoie le rapport réel
           → la carte d'agent du site affiche ce rapport
```

| Route | Rôle | Réponse |
|---|---|---|
| `POST /api/incident` | publie un scénario du catalogue | `200 {trace_id, error_type, messages}` · `400 unknown_scenario` · `503 kafka_unreachable` |
| `GET /api/report?trace_id=` | lit le rapport publié par le watcher | `200 {agent, exit_code, report}` · `404 pending` · `503` |

Le catalogue est `site/scenarios/catalog.json` (copie de
`aiven-kafka-demo/scenarios/`), lu par `site/lib/contract.js` : la console et
`tools/seed` produisent donc **exactement** le même message.

**Deux règles à ne pas régresser :**

1. **La simulation ne verrouille rien.** La carte d'agent s'anime tout de suite
   (comportement voulu, `startSimulation`), mais tant que l'incident a été
   publié, la carte reste **verrouillée** (`entry.state = "run"`,
   `entry.simulatedDone`) jusqu'à l'arrivée du rapport réel : c'est ce qui
   empêche un second agent de partir sur un message qui réapparaît. Si on laisse
   la simulation terminer la carte (`state = "done"`), l'anti-doublon se rouvre
   au bout de ~2,5 s et trois erreurs identiques publient trois incidents.
2. **Un seul POST par message en cours.** `fireError()` calcule
   `metrics.fingerprint(code, message, stack)` et vérifie `state.agents` **avant**
   de publier ; `addErrorCard`/`createAgent` revérifient (même trace ou même
   empreinte) pour les erreurs JS du site. Côté machine, le watcher applique la
   même règle (§4.3, `running_messages`).

**Trois pièges, tous rencontrés :**

1. **Le dossier doit être lié au projet `log`.** Sans `.vercel/project.json`
   (`{"projectId":"prj_kNIldg2h6v3Q0VjdJGQizMkMGrwU","orgId":"team_2mVkYxiteDPS64R4CJj8TDPG"}`),
   `vercel deploy` crée le projet `site` — un autre site, pas celui-ci.
2. **Ne pas déployer depuis une copie temporaire** (`/tmp/...`) : un déploiement
   lancé depuis une copie ancienne **écrase la production** et fait disparaître
   les correctifs. C'est arrivé le 2026-10-22 (l'anti-doublon d'agent de §4.3
   avait été remplacé par un `app.js` plus vieux). Après tout déploiement,
   vérifier que le fichier servi est bien le fichier local :

   ```bash
   curl -s https://log-lac-five.vercel.app/app.js | md5sum
   md5sum ~/Log/site/app.js        # les deux empreintes doivent être identiques
   ```

3. **La racine du dépôt contient une ancienne copie du site** (`app.js`,
   `index.html`, `styles.css`, `metrics.js`, `observability.js`,
   `previews.html`, `bg.js`) qui a **divergé** de `site/` : la racine garde les
   étapes de démonstration (`analyze/patch/verify/ready`), `site/` a les étapes
   réelles du watcher (`queued/running/verify/report`). **La seule source qui
   compte est `site/`** — les fichiers de la racine ne sont ni déployés
   (`.vercelignore`) ni à jour. `site/node_modules` est de surcroît versionné
   comme lien symbolique absolu (`/home/baptistefaisy/aiven-kafka-demo/site/node_modules`),
   ce qui casse sur toute autre machine : à supprimer du suivi git.

---

## 5. Services et timers systemd (utilisateur)

| Unité | Type | État au 22/10 15:15 | Déclencheur | Rôle |
|---|---|---|---|---|
| `kafka.service` | simple | **active** | permanent | broker KRaft local, single-node, `-Xmx640M`, données dans `~/.local/opt/kafka`. **La chaîne d'incidents ne l'utilise plus** : elle passe par le cluster Aiven |
| `kafka-incident-watch.service` | simple | **active** (depuis 13:57) | permanent | le watcher (cf. §4.3) |
| `kafka-health.timer` → `.service` | timer | **active** | **toutes les 1 min** | `kafka-health localhost:9092 --deep --json` → `~/logs/kafka-health.log` |
| `log-sync.timer` → `.service` | timer | **active** (tick 10 min) | **toutes les 10 min** | copie `~/logs/` → ce dépôt, scan de secrets, commit, push SSH |
| `aiden.service` | simple | **active** (depuis le 21/10) | permanent | daemon Aiden (cf. §2.4) |
| `zeroclaw.service` | simple | **inactive** | — | passerelle distante (cf. §2.3), unité archivée dans `cleanup-20261021-121324/` |

`log-sync.timer` a `Persistent=true` : un tick manqué est rejoué au démarrage
suivant.

**Drop-ins en place** (ils changent le comportement par défaut, à connaître) :

| Fichier | Effet |
|---|---|
| `log-sync.service.d/scan.conf` | `LOG_SYNC_SCAN=1` → **le scan de secrets est bloquant** (cf. §7) |
| `kafka-incident-watch.service.d/sans-plafond-horaire.conf` | `WATCHER_MAX_PER_HOUR=1000000` → plus de plafond horaire |

> Le service `kafka-incident-watch` peut apparaître **actif** tout en
> accumulant des erreurs réseau vers le cluster Aiven
> (`Network is unreachable`, `GroupCoordinator: Connection setup timed out`) :
> c'est la même instabilité de lien que celle qui fait échouer les push
> `log-sync`. Un service `active` ne prouve donc pas que les incidents entrent.

---

## 6. Inventaire des journaux

Tous produits dans `~/logs/`, copiés ici. **Format et producteur**, avec les
volumes relevés le 2026-10-22 15:15 :

| Fichier | Poids | Lignes | Dernière écriture | État |
|---|---|---|---|---|
| `kafka-health.log` | 823 Ko | 35 155 | 22/10 | **vivant** (1/min) |
| `log-sync.log` | 30 Ko | 509 | 22/10 | **vivant** (1/10 min) |
| `historique-pg.log` | 11 Ko | 118 | 22/10 | **vivant** (manuel) |
| `config-changes.log` | 574 o | 8 | 22/10 | **vivant** (manuel) |
| `decision-router.log` | 118 Ko | 565 | 21/10 | archive figée |
| `api-audit.log` | 11 Ko | 67 | 21/10 | archive figée |
| `scope-watch.log` | 16 Ko | 237 | 21/10 | archive figée |
| `phone-auto.log` | 9,3 Ko | 84 | 21/10 | archive figée |
| `phone-watch.log` | 2,3 Ko | 35 | 21/10 | archive figée |
| `phone-wait-adb.log` | 161 o | 2 | 21/10 | archive figée |
| `suite-pilot2.log` | 607 o | 12 | 21/10 | archive figée |
| `suite-pilot3.log` | 29 o | 1 | 21/10 | archive figée |
| `incidents/` | 5,4 Mo | 54 fichiers | 22/10 | **vivant** |

### `kafka-health.log` — 823 Ko, 35 155 lignes *(croît d'une sonde/minute)*

Producteur : `kafka-health.timer` → `bin/kafka-health --deep --json`.

Ce fichier mélange **deux formats**, il faut le savoir avant de le parser :

**Format 1 — sonde courte, une ligne JSON** (les premières centaines de lignes) :

```json
{"state":"DOWN","ok":false,"bootstrap":"localhost:9092","tcp_reachable":false,
 "deep_checked":true,"duration_ms":9.0,"timestamp":"2026-10-21T19:42:16+0200",
 "findings":[{"level":"error","code":"tcp_unreachable","msg":"Aucun bootstrap joignable…"}]}
```

Champs à lire : `state` (`UP`/`DEGRADED`/`DOWN`), `ok`, `tcp_reachable`,
`findings[]` (`level`, `code`, `msg`). Codes de sonde vus : `tcp_ok`,
`tcp_unreachable`, `brokers`, `topics`.

**Format 2 — rapport profond, JSON indenté sur plusieurs lignes** :
`topics{partitions, topic_id, detail[leader, replicas, isrs]}`,
`brokers[{id, host, port}]`, `consumer_groups[{group_id, state}]`
(`EMPTY` / `STABLE`), `expected_topics`, `missing_topics`, `warnings`.

> ⚠️ Ce fichier n'est **pas** du JSONL pur : `jq` ligne à ligne échoue sur la
> partie indentée. Les erreurs du client librdkafka (`%5|epoch|REQTMOUT|…`) y
> sont aussi entremêlées, plus des `{"ok":false,"error":"kafka_unreachable"}`.

Codes de sortie du script : `0` OK, `1` usage, `2` config, `3` DOWN.

### `decision-router.log` — 118 Ko, 565 lignes — *historique*

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

### `historique-pg.log` — 11 Ko, 118 lignes

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

### `config-changes.log` — 574 o, 8 lignes

Journal **manuel** des changements de configuration du poste (modèle par
défaut, épinglages, drop-ins systemd). Format texte horodaté. C'est la mémoire
de « pourquoi cette valeur et pas une autre » — la seule source qui explique les
drop-ins du §5.

### `incidents/` — 54 fichiers au 22/10 (5 `.prompt`, 49 `.log`)

Deux familles :

- `<UTC>-<trace8>-<agent>.prompt` — le **prompt exact** envoyé à l'agent :
  `topic`, `TraceId`, `severite`, `error.type`, `horodatage`, `scenario`,
  `profil`, `message`, `attributs`, puis le bloc `PREUVE (obligatoire)` qui
  impose `trace-dump`, et le format de réponse attendu.
- `<UTC>-<trace8>-<agent>.log` — la **transcription JSONL** d'OpenCode
  (`step_start`, `text`, `tool_use`, `step_finish`). Le rapport final est la
  dernière partie `type=text`.

C'est la pièce la plus utile pour comprendre *pourquoi* un agent a conclu ce
qu'il a conclu : on a l'entrée (`.prompt`) et la sortie (`.log`). Les `.log`
dominent largement (5,3 Mo sur 5,4) : un run de `debug-historique` avec 80
étapes produit un fichier volumineux.

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
> `phone-auto`, `phone-api` ont été **supprimés le 21/10** (binaires absents de
> `~/bin/`). Leurs units sont archivées dans `cleanup-20261021-121324/*.service`
> et `restore.sh` (dans `cleanup-20261021-131324/`) permet de les réactiver. Les
> journaux correspondants ci-dessus sont donc des **archives figées au 21/10**,
> pas des flux vivants. Seuls `kafka-health.log`, `log-sync.log`,
> `historique-pg.log`, `config-changes.log` et `incidents/` sont encore
> alimentés.

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
3. **Scan de secrets** — `~/bin/scan-secrets.py`, **si** `LOG_SYNC_SCAN=1`.
4. **Commit + push SSH** vers `git@github.com:BaptisteFaisy/Log.git`, branche
   `main`.

### Le scan de secrets — attention à la contradiction

Le script a le scan **désactivé par défaut** (`LOG_SYNC_SCAN` vaut `0` s'il
n'est pas posé). Mais le drop-in `log-sync.service.d/scan.conf` pose
`Environment=LOG_SYNC_SCAN=1` : **en service, le scan est donc bloquant.**

C'est le seul état qui compte, et il contredit deux documents :

- ce README, dans ses versions antérieures, présentait le scan comme
  inconditionnellement bloquant ;
- `~/AGENTS.md` affirme que « le scan de secrets a été retiré de la synchro le
  2026-10-22 » — vrai pour le **script**, faux pour le **service**.

**Constat de terrain (22/10 15:13)** : `[scan] 181 fichiers, 20 familles de
secrets : PROPRE`, puis push. Le scan tourne. Pour le lever réellement, il faut
retirer le drop-in, pas éditer le script.

`scan-secrets.py` combine deux détections :

- **valeurs réelles** lues sur la machine (fichiers de credentials, jetons
  GitHub, mots de passe Aiven) — comparaison littérale. Les fichiers
  d'environnement de la démo Kafka sont lus aussi (`~/aiven-kafka-demo/env*.sh`,
  `.secrets/*.env`, `.creds.json`), mais uniquement pour les clés qui portent un
  secret (`*PASS*`, `*SECRET*`, `*TOKEN*`, `*CREDENTIAL*`, `*PRIVATE*`) :
  `KAFKA_SERVICE` ou `PGDATABASE` ne sont pas confidentiels et noieraient le
  signal ;
- **motifs** : `gho_/ghp_/ghu_/ghs_`, `github_pat_`, `aivenv1`, `avnpw_`,
  `AVNS_` (mot de passe de service Aiven), `sk-…`, mots de passe dans une URL
  `postgres://user:pw@…`, `Bearer …`, chaînes hex de 24 caractères, clés
  privées PEM.

Il n'affiche **jamais** la valeur d'un secret : seulement sa nature et sa
position. Sortie `0` = propre, `1` = secret détecté. Il contrôle aussi l'**index**
git (`git show :<fichier>`), pas seulement le working tree.

`log-sync.log` (509 lignes) en garde la trace. Ce journal n'est **pas versionné**
(cf. `.gitignore`) — il changerait à chaque tick.

> **Les push échouent par rafales, pas par bug.** Le 22/10 à 15:13 :
> `Read from remote host github.com: Connection reset by peer`,
> `send-pack: unexpected disconnect`, puis `!! echec du push`. Le tick suivant
> passe. C'est la même instabilité réseau que celle décrite au §2.1 : un
> `log-sync.service` en `failed` isolé n'est pas un incident, il faut regarder
> si le tick d'après a rattrapé.

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
   été ajouté au passage.
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

#### À quoi ça sert, concrètement

`pg-memoire` est la **mémoire longue des bugs** : c'est la seule base de la
flotte qui garde la trace d'un problème *déjà résolu* et de *comment* il l'a
été. Sans elle, chaque agent repart de zéro et re-diagnostique le même incident
la semaine suivante.

Le cycle qu'elle rend possible — c'est exactement celui qu'applique
`debug-historique`, l'agent par défaut du §4.4 :

1. **Avant** d'analyser, l'agent de diagnostic cherche le nom du problème
   signalé dans la base (`trouver`, insensible à la casse et aux accents).
2. S'il trouve une entrée, il **réutilise la piste** qu'elle décrit — sans la
   prendre pour une preuve : il la confronte aux faits observés.
3. Après résolution, il **documente** : mise à jour de l'entrée existante
   (*append*, jamais d'écrasement, `occurrences + 1`) ou création d'une
   nouvelle entrée nom + résolution.

Ce qu'elle n'est **pas** :

- ni un journal d'événements — les logs sont dans `~/logs/` et ce dépôt ;
- ni le catalogue d'erreurs applicatives — c'est `pg-erreurs` (§8.2), un
  service **distinct**, avec ses propres identifiants ;
- ni un cache — le service Valkey a été supprimé (§8.3).

État vérifié le 2026-10-22 : service `RUNNING` (PG 18, `do-lon`), base
`historique` en ligne, **5 entrées**, dernière mise à jour
`2026-10-22 07:53 UTC` (timeout de connexion, port PostgreSQL changé après
recréation du service, mot de passe masqué dans l'API Aiven, `password
authentication failed` via `avn service cli psql`, auth PG après recréation).

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

**Lecture seule en diagnostic** : `~/aiven-kafka-demo/tools/pg-diag "<SELECT>"`
ouvre la base avec `default_transaction_read_only`. C'est l'outil que les
agents ont le droit d'appeler — jamais `psql` en écriture.

Prompt d'usage de l'agent de débogage : `~/PROMPT-AGENT-DEBUG-HISTORIQUE.md`
(c'est le `prompt_file` de `routes.yaml`).

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

### 8.3 Valkey — *supprimé*

Le service Aiven `valkey-memoire` (plan `hobbyist`, TTL 86400 s) **n'existe
plus** : `avn service list` ne renvoie que `kafka-1687d005`, `pg-erreurs` et
`pg-memoire`. La mémoire de travail court terme n'a plus de backend dédié.

> **Règle d'or conservée** : quand un service Aiven est recréé, host et port
> sont **toujours relus via l'API** (`service_uri_params`). Ils changent à
> chaque recréation, et un host codé en dur produit un `.env` inconnectable.
> C'est la cause du bug n°2 de la table `historique`.

---

## 9. Infrastructure Aiven

État réel au 2026-10-22 15:15 (`avn service list`) :

| Service | Type | Plan | Cloud | État | Rôle |
|---|---|---|---|---|---|
| `kafka-1687d005` | kafka | `developer-2-1d` | `do-fra` | `RUNNING` | **le** bus de la chaîne d'incidents |
| `pg-memoire` | pg | `hobbyist` | `do-lon` | `RUNNING` | PostgreSQL 18 — base `defaultdb` (application MEMOIRE) + base `historique` (mémoire de debug) |
| `pg-erreurs` | pg | `free-1-1gb` | `do-lon` | `RUNNING` | catalogue d'erreurs → outbox Kafka |

**Ce qui a changé** : l'ancien service de repli `agent-kafka` a été **supprimé**
après migration des données, et `valkey-memoire` aussi. Il n'y a donc plus de
bascule local/managé : `tools/kafkalib.py` ne construit un profil de repli que
si `KAFKA_FALLBACK_ENV_FILE` désigne un fichier existant (ce n'est pas le cas).
Un seul profil, `primary`, sur `kafka-1687d005`. L'état de sélection est écrit
dans `~/.local/state/aiven-kafka-demo/active.json`.

> Le `kafka.service` **local** tourne encore (§5) mais n'est plus utilisé par la
> chaîne : c'est un vestige. Le confondre avec le bus réel est un piège — la
> sonde `kafka-health localhost:9092` mesure le local, pas Aiven.

---

## 10. Règles de sécurité

- **Aucun secret n'est versionné.** Jetons, mots de passe et URLs
  d'authentification sont filtrés avant chaque commit (cf. `.gitignore` et le
  scan bloquant du §7).
- **Un log qui contient un token est un incident, pas un push.**
- Les journaux sont **en lecture seule** ici : la source reste `~/logs/`.
- Le dépôt est **public** : chaque push est une publication. Relire le diff
  avant de pousser autre chose que des journaux.
- Poussée par **SSH** (clé sans expiration), branche `main`, **jamais de
  `--force`**.
- Ne jamais coller un jeton dans un chat, un log ou un commit — y compris le
  contenu de `~/.config/gh/hosts.yml`.
- Les agents d'incident portent 19 règles `deny` de secrets qui couvrent aussi
  `read` et `grep`, pas seulement `shell` : un agent ne peut pas lire un
  `env*.sh` même s'il le voulait.

---

## 11. Diagnostic rapide

```bash
# La chaîne tourne-t-elle ?
systemctl --user list-timers
systemctl --user status kafka-incident-watch.service log-sync.service

# Quel agent va être choisi, sans consommer de Kafka ?
cd ~/aiven-kafka-demo
./tools/kafka-incident-watch --check-routes
./tools/kafka-incident-watch --check-routes db_undefined_column

# Les générateurs d'erreurs tournent-ils ?
./tools/generator status

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

# La table de routage est-elle cohérente avec le manifeste ?
./tools/check.sh          # 9 étapes : preflight, seed, contrat, anti-doublon (3bis), catalogue, groupes, traceback, JS, secrets

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
├── log-sync.log             journal du sync (non versionné)
├── historique-pg.log        maintenance de la base « historique »
├── config-changes.log       changements de configuration du poste
├── decision-router.log      routage de modèles (course, échecs)   [archive 21/10]
├── api-audit.log            audit des appels de l'API locale      [archive 21/10]
├── scope-watch.log          veilleur de périmètre                 [archive 21/10]
├── phone-*.log              agents téléphone                      [archive 21/10]
├── suite-pilot*.log         suites de tests pilotes               [archive 21/10]
├── incidents/               prompts + transcriptions des agents (54 fichiers)
├── guides/                  scripts d'écriture des guides pg-memoire
├── guides-pg-memoire.md     guide de la base historique
└── cleanup-*/ pre-kill-*/   captures d'état avant nettoyage

~/bin/                       outillage
├── oc                       lanceur/pilote de sessions OpenCode
├── kafka-health             sonde de cluster (→ aiven-kafka-demo)
├── trace-dump               extraction de preuves (→ aiven-kafka-demo)
├── sync-logs.sh             copie + scan + commit + push
├── scan-secrets.py          détection de secrets (bloquante en service)
├── zc-run, zc-ms            ZeroClaw
└── oc-remote, oc-remote-run OpenCode distant

~/.config/opencode/          configuration OpenCode
├── opencode.json            modèle par défaut, épinglage, provider, plugin
├── cli.json                 session.permissions = autoaccept
├── AGENTS.md                instructions globales (délégation, réseau, git)
├── agents/                  11 entrées = 4 fichiers réels + 7 liens symboliques
├── commands/                /fanout, /research, /review
├── plugins/net-resilience/  backoff réseau long (ne pas retirer)
├── backups/                 sauvegardes datées (net-resilience-*.tgz)
├── skills/                  vide
├── service.json             port du serveur (600)
└── routes.yaml →            lien vers aiven-kafka-demo/routes.yaml

~/aiven-kafka-demo/          source de vérité de la chaîne d'incidents
├── agents/*.md              les 7 agents d'incident
├── agents/group.json        manifeste des 3 groupes (11 membres)
├── routes.yaml              mode actuel : 0 route, default debug-historique
├── routes.specialistes.yaml mode dormant : 32 routes, default incident-watch
├── tools/kafka-incident-watch   le watcher
├── tools/{emit_*,db_fault_probe,detectors}.py   producteurs + détecteurs
├── tools/{pg-diag,patch-new,patch-validate,debug-bundle,preflight,generator}
├── tools/dedup-selftest     9 contrôles anti-doublon, sans Kafka
├── tools/check.sh           vérification complète en 9 étapes
├── db/                      schémas et jeux d'erreurs
├── scenarios/               6 scénarios + catalogue
├── site/                    console web de démonstration (Vercel)
└── README.md                documentation détaillée de la chaîne

~/Log/site/                  source du site publié log-lac-five.vercel.app
├── api/                     10 fonctions serverless (pg-memoire, dump, tail…)
├── historique.js/.css       panneau de la base historique
├── db.js/.css, dump.js/.css panneau base + export SQL
└── app.js, index.html       console (étapes réelles du watcher)

~/.claude/                   configuration [CC]
├── settings.json            bypassPermissions, effort max, plugin vercel
├── projects/-home-baptistefaisy/   transcriptions + mémoire
└── sessions/<pid>.json      registres de sessions vivantes
```
