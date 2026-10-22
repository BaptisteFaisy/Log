# env.example.sh — copier en env.sh (chmod 600) et remplir.
# Format lisible par bash (`set -a; . env.sh; set +a`) ET par systemd (EnvironmentFile=).
# NE JAMAIS COMMITER env.sh : il contient le mot de passe SASL.

# Identifiants du service Aiven Kafka (console Aiven > Users > avnadmin / user dedie)
KAFKA_SERVICE="mon-service-kafka"
KAFKA_BOOTSTRAP="mon-service-kafka-xxxx.aivencloud.com:21505"
KAFKA_SECURITY_PROTOCOL="SASL_SSL"
KAFKA_SASL_MECHANISM="SCRAM-SHA-256"
KAFKA_USERNAME="mon-user"
KAFKA_PASSWORD="mot-de-passe-a-changer"

# Chemin du certificat CA Aiven (console Aiven > Overview > CA Certificate)
KAFKA_CA_FILE="$HOME/.config/kafka/ca.pem"

# Prefixe des topics : otel -> otel.traces, otel.logs, otel.metrics
KAFKA_TOPIC_PREFIX="otel"

# Optionnel : venv dedie (defaut ~/.venvs/aiven-kafka)
# KAFKA_VENV="$HOME/.venvs/aiven-kafka"
