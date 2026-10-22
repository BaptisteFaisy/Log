# Log — journaux du poste

Dépôt de sauvegarde des journaux produits par les agents sur ce poste
(projet MEMOIRE et agents parallèles).

## Contenu

| Source | Description |
|---|---|
| `historique-pg.log` | Base « historique » PostgreSQL/Aiven : provisionnement, schéma, API SQL, vérifications |
| `kafka-health.log` | Santé du cluster Kafka local + services Aiven |
| `decision-router.log` | Routage des décisions / incidents |
| `api-audit.log` | Journal d'audit des appels API |
| `scope-watch.log`, `phone-*.log` | Surveillance de périmètre, agents téléphone |
| `incidents/` | Prompts d'investigation d'incident |
| `cleanup-*/`, `pre-kill-*/` | Captures d'état avant nettoyage / arrêt de process |

## Règles

- **Aucun secret n'est versionné.** Les jetons, mots de passe et URLs
  d'authentification sont filtrés avant chaque commit (cf. `.gitignore`).
- Les journaux sont **en lecture seule** ici : la source reste `~/logs/`.
- Poussée par SSH (`git@github.com:BaptisteFaisy/Log.git`), branche `main`.
