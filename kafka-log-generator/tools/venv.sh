#!/usr/bin/env bash
# tools/venv.sh — venv dedie du client Kafka (§0.6 : jamais le Python systeme).
#
#   ./tools/venv.sh install          cree/installe le venv si besoin
#   ./tools/venv.sh exec <cmd...>    execute une commande avec le venv actif
#   ./tools/venv.sh python <script>  execute un script avec le python du venv
#   ./tools/venv.sh path             affiche le chemin du python du venv
set -euo pipefail

VENV="${KAFKA_VENV:-$HOME/.venvs/aiven-kafka}"
REQUIREMENTS="confluent-kafka>=2.3,<3"

have_dep() {
  [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import confluent_kafka" >/dev/null 2>&1
}

install() {
  if ! have_dep; then
    echo "==> creation du venv : $VENV"
    mkdir -p "$(dirname "$VENV")"
    python3 -m venv "$VENV"
    "$VENV/bin/python" -m pip install --quiet --upgrade pip
    echo "==> installation de $REQUIREMENTS"
    "$VENV/bin/python" -m pip install --quiet "$REQUIREMENTS"
  else
    echo "==> venv deja pret : $VENV"
  fi
  "$VENV/bin/python" -c "import confluent_kafka; print('confluent-kafka', confluent_kafka.version())"
}

case "${1:-exec}" in
  install)
    install
    ;;
  path)
    install >/dev/null
    echo "$VENV/bin/python"
    ;;
  python)
    shift
    install >/dev/null
    exec "$VENV/bin/python" "$@"
    ;;
  exec)
    shift
    install >/dev/null
    PATH="$VENV/bin:$PATH" exec "$@"
    ;;
  *)
    echo "usage : $0 {install|exec|python|path} ..." >&2
    exit 1
    ;;
esac
