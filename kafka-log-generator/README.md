# kafka-log-generator

Générateur de **logs OpenTelemetry** publiés dans **Apache Kafka (Aiven)**.
Il fabrique de la télémétrie d'agent réaliste — traces, logs, métriques — pour
6 scénarios : 5 pannes de plateforme et 1 run nominal de référence.

C'est le générateur qui alimente la démo d'observabilité qui tourne sur Aiven
(cluster `agent-kafka`) : les messages publiés sont consommés en direct par un
watcher d'incidents et par les détecteurs (`tools/detectors.py`).

Aucun secret n'est présent dans ce dépôt : la configuration passe par un
fichier d'environnement local (`env.sh`, mode 600, ignoré par git).

## Ce qu'il publie

Trois topics, préfixe configurable (`KAFKA_TOPIC_PREFIX`, défaut `otel`) :

| Topic | Contenu |
|---|---|
| `otel.traces` | spans OTel (un span par étape de l'agent, `TraceId` en clé Kafka) |
| `otel.logs` | logs applicatifs corrélés au `TraceId` |
| `otel.metrics` | métriques (`TimeUnix` en ns) |

Chaque message porte un `TraceId` qui sert de **clé Kafka** : toutes les lignes
d'un même incident atterrissent dans la même partition et se relisent dans
l'ordre.

## Les 6 scénarios

| id | `error.type` | profil | ce que ça simule |
|---|---|---|---|
| `platform_db_pool_exhausted` | `db_pool_exhausted` | infra | pool de connexions PostgreSQL saturé (4 appels `tool.check_reservation` en échec) |
| `platform_db_connection_timeout` | `db_connection_timeout` | infra | timeout de connectique PostgreSQL (port 5432) |
| `platform_kafka_broker_unreachable` | `kafka_broker_unreachable` | infra | broker Kafka injoignable (`ERR__TRANSPORT`) |
| `platform_oom` | `oom` | infra | `OutOfMemoryError` (heap JVM saturée) |
| `platform_disk_full` | `disk_full` | infra | disque plein (tampon de télémétrie) |
| `healthy` | — | référence | run nominal, sans erreur |

Le catalogue est dans `scenarios/catalog.json` : c'est la source unique des
scénarios (lue par `seed`, par les détecteurs et par les outils de relecture).
Aucun scénario n'est réécrit à la main ailleurs.

## Installation

```sh
git clone <ce-depot> kafka-log-generator && cd kafka-log-generator
cp env.example.sh env.sh && chmod 600 env.sh   # puis remplir les valeurs
./tools/venv.sh install                        # venv + confluent-kafka
```

`env.sh` attendu (format `KEY="valeur"`, sans `export`, lisible par bash et par
systemd) :

```sh
KAFKA_BOOTSTRAP="mon-service-xxxx.aivencloud.com:21505"
KAFKA_SECURITY_PROTOCOL="SASL_SSL"
KAFKA_SASL_MECHANISM="SCRAM-SHA-256"
KAFKA_USERNAME="..."          # utilisateur SASL Aiven
KAFKA_PASSWORD="..."          # mot de passe SASL
KAFKA_CA_FILE="$HOME/.config/kafka/ca.pem"   # CA Aiven
KAFKA_TOPIC_PREFIX="otel"
```

## Utilisation

```sh
set -a; . ./env.sh; set +a       # charge la configuration

./seed --list                    # liste les scénarios du catalogue
./seed                           # publie les 6 scénarios
./seed --emit platform_oom       # publie un seul scénario (un "bouton")
./seed --out-dir out             # exporte en JSONL, sans publier dans Kafka
./seed --self-check              # rejoue les 3 détecteurs sur les données générées
./seed --self-check --live       # + vérifie dans Kafka que les 6 runs sont conformes
./seed --prefix otel-test        # publie sous un autre préfixe de topics
./seed --json                    # sortie machine (succès comme échec)
```

Le script se ré-exécute tout seul dans le venv dédié s'il ne trouve pas
`confluent-kafka` (`KAFKA_VENV`, défaut `~/.venvs/aiven-kafka`), donc
`./seed` marche directement.

### Codes de sortie

| code | sens |
|---|---|
| 0 | ok |
| 1 | erreur d'usage (scénario inconnu, argument invalide) |
| 2 | configuration manquante ou incomplète |
| 3 | Kafka injoignable |

## Les 3 détecteurs

`tools/detectors.py` analyse les messages générés et doit trouver :

- **retry_spiral** — boucle de retry : 4+ appels du même outil sur une trace
  (seuil strictement supérieur à 3) ;
- **silent_failure** — run qui échoue sans jamais logguer d'erreur ;
- **stale_source** — donnée servie depuis une source périmée.

`./seed --self-check` vérifie que ces détecteurs se déclenchent sur un jeu
volontairement cassé et **pas** sur le jeu sain : c'est le test de
non-régression du générateur, il ne touche pas à Kafka (sauf `--live`).

## Structure

```
seed                     générateur (CLI) : publie, exporte, auto-vérifie
tools/contract.py        contrat des messages + chargement du catalogue
tools/kafkalib.py        config Kafka, client producteur, bascule de cluster
tools/detectors.py       les 3 détecteurs d'anomalies
tools/venv.sh            venv dédié (confluent-kafka)
scenarios/catalog.json   catalogue des 6 scénarios
env.example.sh           modèle de configuration (sans secret)
```

## Notes d'exploitation

- **Bascule de cluster** : si `KAFKA_FALLBACK_ENV_FILE` pointe vers un second
  fichier d'env, le générateur bascule automatiquement sur le cluster de repli
  quand le primaire tombe, et partage le choix via un fichier d'état
  (`KAFKA_PROFILE_STATE`) pour que tous les outils parlent au même cluster.
- **Aucun secret journalisé** : ni mot de passe, ni certificat, ni chaîne de
  connexion complète n'apparaissent dans la sortie ou les logs.
- Le générateur ne crée pas les topics : ils doivent exister (ou
  `auto.create.topics.enable` côté broker).
