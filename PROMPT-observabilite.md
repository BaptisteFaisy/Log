# Prompt — Observabilité des résolutions d'erreurs (site log-errors)

Tu travailles dans `C:\Users\gaiam\Downloads\Log`, site statique vanilla (HTML/CSS/JS, aucun build, aucun framework) déployé sur Vercel sous `https://log-errors.vercel.app/`. Fichiers : `index.html`, `app.js`, `styles.css`, `bg.js`, `previews.html`. La console simule des logs d'erreur et des agents qui les résolvent (voir `createAgent` et `finish` dans `app.js`).

## Objectif

Ajouter une instrumentation et un tableau de bord « Observabilité » qui mesurent et affichent, par log d'erreur et globalement :

1. **Temps de résolution avant/après** (médiane et moyenne, en ms et en s).
2. **Tokens consommés pour la résolution avant/après** (par log d'erreur).
3. **Total de tokens consommés pour résoudre les problèmes** (cumul, avec répartition cold/warm).
4. **Durée de chaque tâche** du pipeline de résolution (décomposition par étape), car les métriques ci-dessus en dépendent.

### Définition de « avant » et « après » (à respecter strictement)

- **avant / cold** = première résolution réussie d'un log d'erreur donné (aucun mémo disponible).
- **après / warm** = le même log d'erreur se représente et un agent précédent a laissé un mémo `.md` ; l'agent courant le lit avant de commencer, ce qui doit réduire temps et tokens.
- **warm dégradé** = récurrence sans mémo exploitable (absent, illisible, obsolète). À compter et afficher séparément, **exclu** des moyennes warm.
- L'identité d'un log d'erreur est un `fingerprint` stable, pas le message brut : `sha256(code + "|" + message_normalisé + "|" + première_frame_de_stack_utile)`. Normaliser le message (IDs, nombres, timestamps, chemins absolus remplacés par des placeholders) pour que deux occurrences du même bug partagent le fingerprint.
- Un « run » = une tentative de résolution, de la réception du log à la fin (résolue, échouée ou abandonnée). Un run échoué n'entre pas dans les moyennes de temps/tokens mais compte dans le taux d'échec.

## Contrat de mémo `.md`

Chaque résolution réussie cold écrit un mémo réutilisable :

```
docs/error-memos/<fingerprint>.md
---
fingerprint: <sha256>
code: ERR_...
cause: ...
fix: ...
files: [ ... ]
verification: ...
tokens_used: 12345
duration_ms: 4567
agent: agent/fix-...
updated_at: 2026-10-22T10:00:00.000Z
runs: 1
---
<explication courte, pièges, commandes de vérification>
```

Un agent warm **doit** charger ce mémo avant toute analyse ; s'il ne le trouve pas, le run est `warm_degraded`, pas `cold`. Le mémo est mis à jour (compteur `runs`, `updated_at`) après chaque warm réussi.

## Instrumentation à ajouter

Créer un module `metrics.js` (vanilla, IIFE ou objet global `window.LogMetrics`, aucune dépendance) exposant :

- `startRun({ code, fingerprint, message, stack })` → `run_id`, `started_at`, `mode` attendu.
- `startStep(runId, name)` / `endStep(runId, name)` pour les étapes : `receive`, `fingerprint`, `memo_lookup`, `reproduce`, `diagnose`, `patch`, `verify`, `write_memo`.
- `addTokens(runId, { input, output, cache_read, cache_write, estimated })`.
- `endRun(runId, { status: "resolved" | "failed" | "abandoned" })`.
- `getSnapshot()` → agrégats prêts à afficher.
- `exportJSON()` / `exportCSV()` / `reset()`.

Règles de mesure :

- Durées en `performance.now()` (monotone) ; horodatages en ISO 8601 pour l'affichage et l'export.
- Les tokens proviennent du runtime de l'agent (`usage.input_tokens + usage.output_tokens`). `cache_read` / `cache_write` sont stockés à part et **jamais** additionnés deux fois au total. Si la valeur réelle est indisponible, marquer `estimated: true` et préfixer l'affichage par `≈` ; ne jamais inventer silencieusement.
- `duration_ms` d'un run = fin − début. Stocker aussi `agent_ms` = somme des étapes actives, pour distinguer attente et travail réel.
- Persistance : `localStorage` clé `log.observability.v1`, plafond 500 runs (FIFO), fusion par `run_id` à la lecture (support multi-onglets via l'événement `storage`). Aucune donnée personnelle, aucun contenu de stack complet en storage (fingerprint + code + message tronqué à 160 caractères).

## Schéma de données (à respecter)

```json
{
  "version": 1,
  "runs": [
    {
      "run_id": "run_01J...",
      "fingerprint": "9f2c...",
      "code": "ERR_PAYLOAD_INVALID",
      "mode": "cold | warm | warm_degraded",
      "status": "resolved | failed | abandoned",
      "started_at": "2026-10-22T10:00:00.000Z",
      "ended_at": "2026-10-22T10:00:04.567Z",
      "duration_ms": 4567,
      "agent_ms": 3900,
      "steps": [{ "name": "memo_lookup", "duration_ms": 12 }],
      "tokens": { "input": 12000, "output": 1800, "cache_read": 0, "cache_write": 0, "estimated": false },
      "tokens_total": 13800,
      "memo": { "hit": true, "path": "docs/error-memos/9f2c....md", "stale": false },
      "agent": "agent/fix-payload-invalid",
      "attempt": 2
    }
  ],
  "memos": { "9f2c...": { "path": "...", "updated_at": "...", "runs": 3 } }
}
```

## Agrégats à calculer

Par fingerprint (une ligne du tableau) :

- `n_cold`, `n_warm`, `n_warm_degraded`, `n_failed`.
- `median_duration_cold`, `median_duration_warm` (médiane = métrique principale, moyenne en secondaire), `delta_time_pct = (cold − warm) / cold`.
- `median_tokens_cold`, `median_tokens_warm`, `delta_tokens_pct`.
- `tokens_total` (somme de tous les runs de ce fingerprint).
- `last_seen_at`.

Global :

- `tokens_total_all` = Σ `tokens_total` de tous les runs (c'est le « nombre de tokens utilisés pour résoudre les problèmes »).
- `tokens_total_cold`, `tokens_total_warm`.
- `tokens_economises` = Σ(warm : tokens d'un run cold médian du même fingerprint − tokens réels du run warm), plancher à 0.
- `memo_hit_rate` = `n_warm / (n_warm + n_warm_degraded + n_cold_recurrences)`, où `n_cold_recurrences` = runs cold sur un fingerprint déjà vu (anomalie à signaler).
- `time_saved_total_ms` = Σ(warm : durée cold médiane − durée réelle), plancher à 0.

Afficher « — » si l'échantillon est vide, jamais `0` ni `NaN`. Si `n < 3` sur un mode, afficher la valeur avec la mention « échantillon faible ».

## Interface (dans le style existant, en français)

Ajouter une section `<section id="observabilite" class="observability">` sous `main.workspace` (pleine largeur, même fond papier, mêmes variables CSS `--paper`, `--ink`, `--red`, `--line`, `--radius`, polices Inter + JetBrains Mono). Un bouton « Observabilité » dans `.topbar-actions` ancre vers la section. Aucune nouvelle librairie, aucun build.

Contenu :

1. **Bandeau KPI** (cartes) : Temps médian avant / après + gain % ; Tokens médians avant / après + gain % ; Tokens totaux consommés ; Taux de mémoïsation ; Résolutions (cold/warm/échecs).
2. **Tableau par log d'erreur** : `code`, badge mode, `n cold` / `n warm`, `temps cold`, `temps warm`, `Δ temps`, `tokens cold`, `tokens warm`, `Δ tokens`, `tokens total`, `dernière occurrence`. Tri par tokens totaux décroissants, en-têtes cliquables.
3. **Détail d'un run** (ligne dépliable) : barre empilée des étapes (`receive → … → write_memo`), `duration_ms`, `agent_ms`, tokens input/output, mémo chargé (chemin), statut.
4. **Actions** : « Exporter JSON », « Exporter CSV », « Réinitialiser les métriques » (confirmation).
5. **Légende explicite** : « avant = 1re résolution (aucun mémo) » / « après = récurrence avec mémo .md ».

Accessibilité : tableaux avec `<caption>` et `scope`, focus visible, contrastes AA, responsive (le tableau devient des cartes sous 720 px), `aria-live="polite"` sur les KPI mis à jour.

## Mode démo (obligatoire, car le site est une simulation)

Instrumenter le flux existant `createAgent` → `finish` dans `app.js` :

- Au lancement : `startRun`, mode déterminé par l'existence d'un mémo pour le fingerprint.
- Les 4 étapes actuelles (`analyse`, `correctif`, `vérification`, `prêt`) deviennent des steps chronométrées ; conserver les timings visuels actuels.
- À `finish` : `endRun(resolved)`, tokens simulés plausibles et **déterministes par fingerprint** (PRNG seedé) : cold ≈ 18k–42k input + 2k–6k output ; warm ≈ 2k–6k input + 400–1.2k output. Écrire/mettre à jour le mémo après un cold réussi ; les occurrences suivantes du même scénario sont warm.
- Ajouter un badge `cold` / `warm · memo` sur la carte agent.
- Le bouton « Lancer un log d'erreur » doit alterner les scénarios comme aujourd'hui ; lancer 4 fois le même scénario doit produire 1 cold + 3 warm.
- Prévoir `?demo=warm` pour précharger 1 cold + 2 warm et rendre le tableau lisible immédiatement.

## Phase 2 (optionnelle, à spécifier mais pas à implémenter sans accord)

Ingestion réelle : `POST /api/runs` (Vercel Function) acceptant le même schéma, validation stricte, stockage KV/Postgres, agrégation côté serveur, et bascule du front sur `GET /api/metrics` si `window.LOG_METRICS_API` est défini. Le mode localStorage reste le fallback par défaut.

## Critères d'acceptation

- 4 clics sur le même scénario : 1 run cold, 3 warm ; le tableau affiche les deux colonnes et un gain positif en temps et en tokens.
- Rechargement de la page : les métriques persistent ; aucun doublon de `run_id`.
- Un run échoué n'apparaît pas dans les médianes mais est compté dans les échecs.
- Mémo supprimé puis même erreur : le run est `warm_degraded`, visible séparément, pas compté en cold ni en warm.
- Export JSON conforme au schéma, export CSV avec une ligne par run, reset vidant storage + UI.
- Aucune erreur console, aucun appel réseau nouveau en mode démo, fonctionne en statique sur Vercel, responsive 360 px → 1440 px.
- Vérifier manuellement dans le navigateur (pas de framework de test) et documenter les commandes d'ouverture dans le README si tu en ajoutes un. Ne pas commit sans demande explicite.

## Hors périmètre

Facturation réelle, multi-utilisateurs, authentification, migration de la simulation vers un vrai runner d'agents, refonte visuelle du site.
