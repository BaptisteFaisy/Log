# Consignes agent

Avant de proposer ou d'appliquer une correction à une erreur :

1. Chercher la mémoire PostgreSQL :
   `npm run memory -- lookup --code ERR_...`
   ou `npm run memory -- lookup "message d'erreur"`.
2. Si un hit existe, appliquer la méthode de résolution lue dans la table
   `error_resolutions` (pas de fichier `.md`).
3. Après résolution, enregistrer la méthode et le run :
   `npm run memory -- record --code ERR_... --fix "..." --verification "..."`.

Règles :

- La table `error_resolutions` est la source de vérité des méthodes.
- La table `historique` est la mémoire historique de Baptiste, consultée en secours.
- Les logs affichés sur le site viennent du topic Kafka `otel.logs` via `logs` :
  ne jamais créer de flux parallèle ou de logs factices côté front.
- Aucun identifiant dans le code ou le dépôt : utiliser `.env.aiven.local`
  (non versionné) ou les variables d'environnement Vercel.

## Publication du site (obligatoire)

Toute mise à jour du site https://log-lac-five.vercel.app suit ce chemin unique :

1. **Vercel** : déployer depuis ce dossier avec `npx vercel --prod`, projet
   `log` (`.vercel/project.json` → `prj_kNIldg2h6v3Q0VjdJGQizMkMGrwU`).
   Ne jamais relier ce dossier à un autre projet (ex. `log-errors`).
2. **GitHub** : committer puis pousser sur `BaptisteFaisy/Log` (remote
   `baptiste`, branche `main`), jamais sur un dépôt parallèle.
3. **Compatibilité** : avant de pousser, `git fetch baptiste` puis vérifier que
   la branche distante est un ancêtre de HEAD
   (`git merge-base --is-ancestor baptiste/main HEAD`). Si ce n'est pas le cas,
   intégrer `baptiste/main` (merge/rebase) et résoudre les conflits en
   conservant le travail distant. Jamais de `--force`.
