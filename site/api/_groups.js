// GENERÉ — ne pas modifier a la main.
// Source unique : ~/aiven-kafka-demo/agents/group.json
// Regenerer : tools/sync-log-site-group.sh <dossier-du-site>
'use strict';

module.exports = {
  "version": 1,
  "description": "Groupes d'agents OpenCode. SOURCE UNIQUE de l'appartenance agent -> groupe -> cas d'usage -> machine d'origine. Lue par tools/kafka-incident-watch (qui estampille chaque rapport publie) et par la console (site/api/agents.js). La copie site/agents/group.json est regeneree par tools/sync-site-group.sh et verifiee par tools/check.sh. Ajouter un agent = une entree dans members ; ajouter un groupe = une entree dans groups. routes:true = l'agent peut recevoir un incident (il doit alors apparaitre dans routes.yaml) ; routes:false = agent lance a la main, hors flux d'incident.",
  "groups": [
    {
      "id": "debug-historique",
      "label": "Debug sur base historique",
      "use_case": "Recevoir chaque incident Kafka et produire un diagnostic appuye sur la base de bugs historiques (PG-ERREURS-A-LIRE.md), avec proposition de patch en brouillon.",
      "default": true,
      "origin": {
        "machine": "penguin",
        "machine_label": "Poste de travail (penguin)",
        "created_on": "2026-10-22",
        "created_by": "Baptiste",
        "install": "symlink ~/.config/opencode/agents/debug-historique.md -> ~/aiven-kafka-demo/agents/debug-historique.md"
      },
      "members": [
        {
          "name": "debug-historique",
          "mode": "primary",
          "role": "agent unique, tous error.type",
          "routes": true,
          "summary": "Diagnostic appuye sur l'historique des bugs, brouillon de patch dans /tmp/opencode."
        }
      ]
    },
    {
      "id": "incident-triage",
      "label": "Triage d'incident (specialistes)",
      "use_case": "Detecter un incident dans le flux Kafka, router l'erreur vers le specialiste competent, enqueter, puis consolider un rapport exploitable. Active en copiant routes.specialistes.yaml sur routes.yaml.",
      "default": false,
      "origin": {
        "machine": "penguin",
        "machine_label": "Poste de travail (penguin)",
        "created_on": "2026-10-21",
        "created_by": "Baptiste",
        "install": "symlink ~/.config/opencode/agents/<nom>.md -> ~/aiven-kafka-demo/agents/<nom>.md"
      },
      "members": [
        {
          "name": "incident-watch",
          "mode": "all",
          "role": "orchestrateur",
          "routes": true,
          "summary": "Lit routes.yaml, delegue au specialiste, consolide le rapport."
        },
        {
          "name": "kafka-diagnose",
          "mode": "subagent",
          "role": "specialiste broker",
          "routes": true,
          "summary": "Broker injoignable, ISR, partitions hors ligne, ACL, TLS."
        },
        {
          "name": "db-diagnose",
          "mode": "subagent",
          "role": "specialiste base de donnees",
          "routes": true,
          "summary": "Pool de connexions, timeout de port, SQLSTATE 42xxx, verrous."
        },
        {
          "name": "runtime-diagnose",
          "mode": "subagent",
          "role": "specialiste machine / JVM",
          "routes": true,
          "summary": "OutOfMemoryError, heap saturee, disque plein."
        },
        {
          "name": "policy-review",
          "mode": "subagent",
          "role": "specialiste politique de l'agent",
          "routes": true,
          "summary": "Boucle de retry, promesse non tenue, source perimee."
        },
        {
          "name": "cache-diagnose",
          "mode": "subagent",
          "role": "specialiste cache",
          "routes": true,
          "summary": "Tempete de cache miss, invalidation de cache."
        }
      ]
    },
    {
      "id": "poste-de-travail",
      "label": "Assistance au poste de travail",
      "use_case": "Agents lances a la main par Baptiste depuis opencode : exploration de code, relecture de diff, execution des tests, surveillance du cluster Kafka.",
      "default": false,
      "origin": {
        "machine": "penguin",
        "machine_label": "Poste de travail (penguin)",
        "created_on": "2026-10-21",
        "created_by": "Baptiste",
        "install": "fichier autonome dans ~/.config/opencode/agents/"
      },
      "members": [
        {
          "name": "code-reviewer",
          "mode": "subagent",
          "role": "relecture de diff",
          "routes": false,
          "summary": "Bugs, regressions, cas limites, tests manquants. Lecture seule."
        },
        {
          "name": "researcher",
          "mode": "subagent",
          "role": "recherche",
          "routes": false,
          "summary": "Recherche code + web, synthese sourcee. Lecture seule."
        },
        {
          "name": "test-runner",
          "mode": "subagent",
          "role": "build et tests",
          "routes": false,
          "summary": "Lance la suite de tests, tranche entre regression et test preexistant."
        },
        {
          "name": "kafka-watch",
          "mode": "subagent",
          "role": "etat du cluster",
          "routes": false,
          "summary": "Broker tombe, panne, diagnostic de disponibilite."
        }
      ]
    }
  ]
};
