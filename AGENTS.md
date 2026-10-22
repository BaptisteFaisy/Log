# Log — consignes agent

Avant de proposer ou d'appliquer une correction à une erreur :

1. Chercher la mémoire PostgreSQL :
   `npm run memory -- lookup --code ERR_...`
   ou `npm run memory -- lookup "message d'erreur"`.
2. Si un hit existe, lire le `.md` exporté (`docs/error-memos/<fingerprint>.md`)
   et appliquer la méthode enregistrée, en l'adaptant au contexte.
3. Après résolution, enregistrer la méthode et le run :
   `npm run memory -- record --code ERR_... --fix "..." --verification "..."`.

La base `error_resolutions` est la source de vérité ; la table `historique`
est la mémoire historique de Baptiste, consultée en secours. Ne jamais écrire
d'identifiants dans le code ou dans le dépôt : utiliser `.env.aiven.local`
(non versionné).
