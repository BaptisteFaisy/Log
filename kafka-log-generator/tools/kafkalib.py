#!/usr/bin/env python3
"""Boite a outils Kafka partagee (config, producteur, consommateur).

Regles de securite :
  - aucun secret n'est jamais affiche ni journalise ;
  - chaque appel reseau a un timeout ;
  - les erreurs sont transformees en messages lisibles
    ("quoi / pourquoi / quoi faire maintenant"), jamais en traceback.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_CONFIG = 2
EXIT_KAFKA = 3
EXIT_RUNNING = 4

REQUIRED_ENV = [
    "KAFKA_BOOTSTRAP",
    "KAFKA_USERNAME",
    "KAFKA_PASSWORD",
    "KAFKA_CA_FILE",
    "KAFKA_TOPIC_PREFIX",
]


class ConfigError(Exception):
    """Configuration incomplete (variables manquantes, fichier illisible...)."""


class KafkaUnreachable(Exception):
    """Le broker ne repond pas (reseau, TLS, ACL, service en construction...)."""


def load_env_file(path: Optional[str] = None) -> Dict[str, str]:
    """Charge un env-<service>.sh sans l'executer (parsing KEY=VALUE)."""
    p = Path(path or PROJECT_ROOT / "env-agent-kafka.sh")
    values: Dict[str, str] = {}
    if not p.exists():
        return values
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            values[key] = val
    return values


def ensure_config() -> None:
    """Remplit les variables KAFKA_* manquantes depuis le fichier d'env.

    Le fichier est au format systemd (KEY="valeur", sans `export`) : il est
    lisible par `EnvironmentFile=` ET par bash. En bash, on le charge avec
    `set -a; . env-agent-kafka.sh; set +a` pour l'exporter.
    """
    if all(os.environ.get(k) for k in REQUIRED_ENV):
        return
    env_file = os.environ.get("KAFKA_ENV_FILE")
    for key, val in load_env_file(env_file).items():
        os.environ.setdefault(key, val)


def config() -> Dict[str, str]:
    ensure_config()
    missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        raise ConfigError(
            "configuration incomplete : variable(s) manquante(s) "
            + ", ".join(missing)
            + " -> source env-agent-kafka.sh (mode 600) puis reessaye"
        )
    return {k: os.environ[k] for k in REQUIRED_ENV}


# --------------------------------------------------------------------------
# basculement de cluster (repli)
# --------------------------------------------------------------------------
# Le service principal (agent-kafka) peut tomber : le systeme bascule alors sur
# le service de repli (kafka-1687d005) sans intervention. Le choix est partage
# par tous les outils (fichier d'etat commun) pour que le generateur, le
# watcher, l'agent et le site parlent au MEME cluster.
FALLBACK_ENV_FILE = os.environ.get(
    "KAFKA_FALLBACK_ENV_FILE", str(PROJECT_ROOT / "env-kafka-1687d005.sh"))
PROFILE_STATE = Path(os.environ.get(
    "KAFKA_PROFILE_STATE",
    str(Path.home() / ".local" / "state" / "aiven-kafka-demo" / "active.json")))
HEALTH_TTL_S = float(os.environ.get("KAFKA_HEALTH_TTL_S", "20"))


def _profile_env(values: Dict[str, str]) -> Dict[str, str]:
    env = dict(values)
    env.setdefault("KAFKA_SECURITY_PROTOCOL", "SASL_SSL")
    env.setdefault("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256")
    return env


def profiles() -> List[Tuple[str, Dict[str, str]]]:
    """Les profils disponibles : (nom, variables KAFKA_*)."""
    ensure_config()
    out: List[Tuple[str, Dict[str, str]]] = []
    primary = {k: os.environ.get(k) for k in REQUIRED_ENV}
    if all(primary.get(k) for k in REQUIRED_ENV):
        out.append(("primary", _profile_env(primary)))
    fallback = load_env_file(FALLBACK_ENV_FILE)
    if all(fallback.get(k) for k in REQUIRED_ENV):
        if fallback.get("KAFKA_BOOTSTRAP") != primary.get("KAFKA_BOOTSTRAP"):
            out.append(("fallback", _profile_env(fallback)))
    return out


def _read_state() -> Dict[str, Any]:
    try:
        return json.loads(PROFILE_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_state(name: str) -> None:
    try:
        PROFILE_STATE.parent.mkdir(parents=True, exist_ok=True)
        PROFILE_STATE.write_text(
            json.dumps({"active": name, "at": time.time()}), encoding="utf-8")
    except OSError:
        pass


def invalidate_profile_cache() -> None:
    """Force un nouveau sondage (le watcher l'appelle apres une erreur)."""
    state = _read_state()
    state["at"] = 0
    try:
        PROFILE_STATE.parent.mkdir(parents=True, exist_ok=True)
        PROFILE_STATE.write_text(json.dumps(state), encoding="utf-8")
    except OSError:
        pass


def _config_for(env: Dict[str, str], extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Configuration librdkafka a partir d'un jeu de variables explicite."""
    cfg: Dict[str, Any] = {
        "bootstrap.servers": env["KAFKA_BOOTSTRAP"],
        "security.protocol": env.get("KAFKA_SECURITY_PROTOCOL", "SASL_SSL"),
        "sasl.mechanism": env.get("KAFKA_SASL_MECHANISM", "SCRAM-SHA-256"),
        "sasl.username": env["KAFKA_USERNAME"],
        "sasl.password": env["KAFKA_PASSWORD"],
        "ssl.ca.location": env["KAFKA_CA_FILE"],
        # le certificat Aiven porte le nom du SERVICE, pas celui du broker
        "ssl.endpoint.identification.algorithm": "none",
        # le DNS Aiven resout d'abord en IPv6 NAT64 : on force IPv4
        "broker.address.family": os.environ.get("KAFKA_ADDRESS_FAMILY", "v4"),
        "socket.timeout.ms": int(os.environ.get("KAFKA_SOCKET_TIMEOUT_MS", "10000")),
        "request.timeout.ms": int(os.environ.get("KAFKA_REQUEST_TIMEOUT_MS", "15000")),
    }
    if extra:
        cfg.update(extra)
    return cfg


def _probe_profile(env: Dict[str, str]) -> bool:
    """Le cluster du profil repond-il ? (metadata, timeout court)"""
    try:
        from confluent_kafka.admin import AdminClient  # type: ignore

        admin = AdminClient(_config_for(env, {"socket.timeout.ms": 6000,
                                               "request.timeout.ms": 8000,
                                               "log_level": 3}))
        admin.list_topics(timeout=8)
        return True
    except Exception:  # noqa: BLE001
        return False


def active_profile(force: bool = False) -> Tuple[str, Dict[str, str]]:
    """Retourne (nom, variables) du cluster a utiliser.

    - KAFKA_PROFILE=primary|fallback force un profil ;
    - sinon on sonde les profils (cache HEALTH_TTL_S) et on prend le 1er
      joignable ;
    - le choix est partage via un fichier d'etat commun a tous les outils.
    """
    available = profiles()
    if not available:
        raise ConfigError(
            "configuration incomplete : aucun profil Kafka exploitable "
            "(variables KAFKA_* absentes et fichier de repli illisible : "
            f"{FALLBACK_ENV_FILE})"
        )
    forced = os.environ.get("KAFKA_PROFILE")
    if forced:
        for name, env in available:
            if name == forced:
                return name, env
    state = _read_state()
    now = time.time()
    if not force and state.get("active") and now - float(state.get("at", 0)) < HEALTH_TTL_S:
        for name, env in available:
            if name == state["active"]:
                return name, env
    for name, env in available:
        if _probe_profile(env):
            if state.get("active") != name:
                eprint(f"cluster Kafka actif : {name} ({env['KAFKA_BOOTSTRAP']})")
            _write_state(name)
            return name, env
    # aucun cluster joignable : on garde le premier (l'erreur sera explicite)
    name, env = available[0]
    _write_state(name)
    return name, env


def kafka_config(extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Configuration librdkafka (§8 : sasl.mechanism au singulier, endpoint none).

    Elle part du profil ACTIF : basculement automatique vers le repli.
    """
    _name, env = active_profile()
    return _config_for(env, extra)


def topic(name: str, prefix: Optional[str] = None) -> str:
    """Nom du topic.

    Le suffixe "reports" est special : les rapports d'agents vivent dans
    <prefix>-reports, HORS de l'espace otel.* qui ne contient que la
    telemetrie (criteres §9.2).
    """
    p = prefix or os.environ.get("KAFKA_TOPIC_PREFIX", "otel")
    if name == "reports":
        return f"{p}-reports"
    return f"{p}.{name}"


def ensure_kafka_interpreter() -> None:
    """Re-execute le script avec le python du venv dedie (§0.6).

    Permet d'appeler ./seed, ./trace-dump ou ./tools/preflight directement,
    sans avoir a passer par tools/venv.sh.
    """
    try:
        import confluent_kafka  # type: ignore  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get("KAFKA_VENV_REEXEC") == "1":
        return
    venv = os.environ.get("KAFKA_VENV") or os.path.expanduser("~/.venvs/aiven-kafka")
    py = os.path.join(venv, "bin", "python")
    if os.path.exists(py):
        os.environ["KAFKA_VENV_REEXEC"] = "1"
        os.execv(py, [py, os.path.abspath(sys.argv[0])] + sys.argv[1:])


def import_kafka():
    """Importe confluent_kafka depuis le venv dedie (§0.6)."""
    ensure_kafka_interpreter()
    try:
        import confluent_kafka  # type: ignore
        return confluent_kafka
    except ImportError as exc:
        raise ConfigError(
            "confluent-kafka absent du Python systeme -> utilise le venv dedie : "
            "./tools/venv.sh exec <commande>  (ou ./tools/venv.sh install)"
        ) from exc


def suffix_for_topic(topic_name: str, prefix: Optional[str] = None) -> str:
    """« otel.traces » -> « traces », « otel-reports » -> « reports »."""
    p = prefix or os.environ.get("KAFKA_TOPIC_PREFIX", "otel")
    for sep in (".", "-"):
        if topic_name.startswith(p + sep):
            return topic_name[len(p) + 1:]
    return topic_name.rsplit(".", 1)[-1]


def admin_client(client_id: str = "aiven-kafka-demo"):
    """Client d'administration (AdminClient vit dans confluent_kafka.admin)."""
    import_kafka()
    from confluent_kafka.admin import AdminClient  # type: ignore

    return AdminClient(kafka_config({"client.id": client_id}))


# --------------------------------------------------------------------------
# producteur
# --------------------------------------------------------------------------
class Publisher:
    """Producteur avec collecte des erreurs de livraison (§8 piege 8).

    producer.flush() seul ne dit rien : sans rappel de livraison, une ACL
    refusee passe inapercue. Ici chaque livraison est verifiee.
    """

    def __init__(self, prefix: Optional[str] = None) -> None:
        self.ck = import_kafka()
        name, env = active_profile()
        self.profile = name
        self.prefix = prefix or env.get("KAFKA_TOPIC_PREFIX") or "otel"
        self.errors: List[str] = []
        self.delivered = 0
        self._lock = __import__("threading").Lock()
        self._producer = self.ck.Producer(kafka_config({
            "client.id": "aiven-kafka-demo-seed",
            "linger.ms": 5,
            "acks": "all",
        }))

    def _on_delivery(self, err, _msg) -> None:
        with self._lock:
            if err is not None:
                self.errors.append(str(err))
            else:
                self.delivered += 1

    def send(self, topic_suffix: str, key: str, payload: str) -> None:
        self.send_to(topic(topic_suffix, self.prefix), key, payload)

    def send_to(self, topic_name: str, key: str, payload: str) -> None:
        try:
            self._producer.produce(
                topic_name,
                key=key.encode("utf-8"),
                value=payload.encode("utf-8"),
                on_delivery=self._on_delivery,
            )
            self._producer.poll(0)
        except Exception as exc:  # noqa: BLE001 - message utilisateur, pas de traceback
            raise KafkaUnreachable(
                f"publication impossible sur {topic_name} : {exc}"
            ) from exc

    def flush(self, timeout: float = 30.0) -> None:
        remaining = self._producer.flush(timeout)
        if remaining:
            raise KafkaUnreachable(
                f"{remaining} message(s) non livres en {timeout:.0f}s -> "
                "verifie le reseau et les ACL Write"
            )
        if self.errors:
            raise KafkaUnreachable(
                "livraison refusee par le broker : " + "; ".join(sorted(set(self.errors))[:3])
            )


# --------------------------------------------------------------------------
# consommateur
# --------------------------------------------------------------------------
def read_messages(prefix: Optional[str] = None,
                  suffixes: Optional[List[str]] = None,
                  trace_id: Optional[str] = None,
                  group_id: Optional[str] = None,
                  idle_seconds: float = 6.0,
                  timeout_seconds: float = 45.0,
                  max_messages: int = 20000,
                  attempts: int = 3) -> Dict[str, List[dict]]:
    """Lit les topics depuis le debut et renvoie les messages par suffixe.

    trace_id : ne garder que les messages de cette trace (None = tout).
    Ne leve jamais : un topic absent ou un broker injoignable donne une
    liste vide et un diagnostic dans stderr.

    Le broker Aiven peut refuser la premiere negociation SASL (les identifiants
    SCRAM ne sont pas encore propages sur l'autre noeud du cluster) : on
    reessaie avec un nouveau consommateur plutot que de renvoyer une liste
    vide qui ferait croire a une trace absente.
    """
    result: Dict[str, List[dict]] = {}
    for attempt in range(max(1, attempts)):
        result = _read_once(prefix, suffixes, trace_id, group_id, idle_seconds,
                             timeout_seconds, max_messages)
        if any(result.values()):
            return result
        if attempt < attempts - 1:
            time.sleep(2)
    return result


def _read_once(prefix: Optional[str] = None,
               suffixes: Optional[List[str]] = None,
               trace_id: Optional[str] = None,
               group_id: Optional[str] = None,
               idle_seconds: float = 6.0,
               timeout_seconds: float = 45.0,
               max_messages: int = 20000) -> Dict[str, List[dict]]:
    """Une passe de lecture (voir read_messages pour la politique de retry)."""
    import time
    import uuid

    ck = import_kafka()
    prefix = prefix or os.environ.get("KAFKA_TOPIC_PREFIX", "otel")
    suffixes = suffixes or ["traces", "logs", "metrics"]
    out: Dict[str, List[dict]] = {s: [] for s in suffixes}
    topic_names = [topic(s, prefix) for s in suffixes]

    consumer = None
    try:
        consumer = ck.Consumer(kafka_config({
            "group.id": group_id or f"otel-watch-dump-{uuid.uuid4().hex[:8]}",
            "enable.auto.commit": "false",
            "session.timeout.ms": 10000,
        }))
        # Lecture directe des partitions (pas de groupe de consommateurs) :
        # pas de negociation de groupe, pas d'attente de rebalance, et la
        # lecture demarre toujours au debut du topic. Un topic absent est
        # simplement ignore.
        from confluent_kafka import OFFSET_BEGINNING, TopicPartition  # type: ignore

        try:
            meta = consumer.list_topics(timeout=20)
        except Exception as exc:  # noqa: BLE001
            # broker momentanement injoignable : on rend la main, read_messages
            # reessaie avec un nouveau consommateur.
            try:
                consumer.close()
            except Exception:  # noqa: BLE001
                pass
            eprint(f"lecture Kafka : metadonnees indisponibles ({exc}) -> nouvel essai")
            return out
        assignments = []
        for name in topic_names:
            tm = (getattr(meta, "topics", None) or {}).get(name)
            if not tm:
                continue
            for pid in (getattr(tm, "partitions", None) or {}):
                assignments.append(TopicPartition(name, pid, OFFSET_BEGINNING))
        consumer.assign(assignments)
    except Exception as exc:  # noqa: BLE001
        raise KafkaUnreachable(f"connexion au broker impossible : {exc}") from exc

    import json as _json

    deadline = time.time() + timeout_seconds
    started_at = time.time()
    last_message_at = None
    # La premiere reception peut tarder : il faut rejoindre le groupe de
    # consommateurs et obtenir l'affectation des partitions (quelques
    # secondes). On ne coupe pas la lecture avant le premier message.
    first_message_grace = max(float(idle_seconds), 8.0)
    try:
        while time.time() < deadline:
            total = sum(len(v) for v in out.values())
            if total >= max_messages:
                break
            msg = consumer.poll(0.5)
            if msg is None:
                if last_message_at is None:
                    if time.time() - started_at > first_message_grace:
                        break
                elif time.time() - last_message_at > idle_seconds:
                    break
                continue
            if msg.error():
                continue
            last_message_at = time.time()
            try:
                payload = _json.loads(msg.value().decode("utf-8"))
            except Exception:  # noqa: BLE001 - message illisible: on l'ignore
                continue
            if not isinstance(payload, dict):
                continue
            suffix = suffix_for_topic(msg.topic(), prefix)
            if suffix not in out:
                out[suffix] = []
            if trace_id and payload.get("TraceId") != trace_id:
                continue
            out[suffix].append(payload)
            if len(out[suffix]) > max_messages:
                break
    finally:
        try:
            consumer.close()
        except Exception:  # noqa: BLE001
            pass
    return out


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)
