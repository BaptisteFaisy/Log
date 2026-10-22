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

## Base « historique » — structure simplifiée

Base PostgreSQL `historique` du service Aiven `pg-memoire` (plan `hobbyist`).
Elle sert de **mémoire de débogage partagée** : chaque bug connu y est stocké
sous forme d'un nom + d'une résolution, pour que l'agent suivant confronté
au même bug reparte d'une piste.

### Table `historique` — 6 colonnes

| colonne | type | rôle |
|---|---|---|
| `id` | `bigserial` PK | identifiant technique |
| `nom` | `citext` UNIQUE | le nom du problème (insensible à la casse) |
| `resolution` | `text` | la résolution (append enrichissant) |
| `occurrences` | `int` | nombre de résolutions cumulées pour ce problème |
| `created_at` | `timestamptz` | horodatage de création |
| `updated_at` | `timestamptz` | horodatage de mise à jour |

3 extensions : `citext` (casse), `unaccent` (accents), `pg_trgm` (reformulation).
4 index : PK, UNIQUE `nom`, trigram sur `nom`, `updated_at DESC`.

### API — 6 fonctions SQL

| fonction | rôle |
|---|---|
| `historique_get(nom)` | lecture exacte, insensible à la casse |
| `historique_trouver(nom)` | recherche par ressemblance, la plus pertinente en 1ʳᵉ ligne |
| `historique_set(nom, résolution, écraser=false)` | création — **refuse** d'écraser une entrée existante |
| `historique_ajouter_resolution(nom, résolution)` | append atomique, `occurrences + 1` |
| `historique_liste(limite)` | listing, les plus récents d'abord |
| `historique_export_data()` | export `(nom, résolution)` — le client compose le fichier |

### Format du document

Un document = **un nom + une résolution**. L'export produit un `.md` par
document, **nom en ligne 1**, résolution en ligne 2 :

```
Mot de passe PostgreSQL Aiven masque dans l'API
Cause racine : l'API Aiven masque les mots de passe en lecture… Correctif : reset-credentials…
```

Après un *append* (Cas A), le fichier fait 4 lignes ou plus : nom, résolution
d'origine, séparateur horodaté `--- resolution complementaire <date> ---`,
puis la nouvelle résolution. La ligne 1 reste toujours le nom.

### Usage — sans SQL

Le client `scripts/historique_client.py` (projet MEMOIRE) pilote tout :

```bash
cd /home/baptistefaisy/hackathon-memory

.venv/bin/python scripts/historique_client.py trouver "nom du problème"  # étape 1
.venv/bin/python scripts/historique_client.py get     "nom du problème"
.venv/bin/python scripts/historique_client.py ajouter "nom" "résolution"  # cas A
.venv/bin/python scripts/historique_client.py set     "nom" "résolution"  # cas B
```

Prompt d'usage de l'agent de débogage :
`~/PROMPT-AGENT-DEBUG-HISTORIQUE.md`

## Infrastructure Aiven

| Service | Plan | Rôle |
|---|---|---|
| `pg-memoire` | `hobbyist` | PostgreSQL 18 — base `defaultdb` (application MEMOIRE) + base `historique` (mémoire de debug) |
| `valkey-memoire` | `hobbyist` | Valkey 7.2 — mémoire de travail court terme (TTL 86400 s) |

Host et port sont **toujours lus via l'API Aiven** (`service_uri_params`) :
ils changent à chaque recréation de service, et un host codé en dur produit
un `.env` inconnectable.

## Règles

- **Aucun secret n'est versionné.** Les jetons, mots de passe et URLs
  d'authentification sont filtrés avant chaque commit (cf. `.gitignore`).
- Les journaux sont **en lecture seule** ici : la source reste `~/logs/`.
- Poussée par SSH (`git@github.com:BaptisteFaisy/Log.git`), branche `main`.
