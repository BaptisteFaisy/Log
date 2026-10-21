## 14. Pièges connus (rencontrés lors de la construction réelle)

- Vercel refuse un nom de projet avec des majuscules : utiliser `log-errors` (le repo peut s'appeler `Log`).
- `vercel deploy` peut échouer sur « You need to add a Login Connection to your GitHub account first » : le déploiement fonctionne quand même, mais la publication automatique sur `git push` doit être activée dans le dashboard (`vercel git connect`).
- Ne pas confondre les deux logos : le bandeau utilise `logo.png` (détouré, transparent) ; le favicon est une composition séparée sur fond **blanc**.
- Les colonnes du terminal doivent rester en `grid-template-columns: 92px 42px minmax(0,1fr)` : c'est ce qui empêche les chiffres de l'horodatage d'être recouverts.
- `hidden` sur un élément qui a `display: grid` en CSS ne suffit pas : ajouter `.agents-empty[hidden] { display: none; }`.
- Le canvas du fond ne doit animer que lorsque le fond `space` est actif, et se mettre en pause quand l'onglet est caché.
- Sur Windows/PowerShell, lire et écrire les fichiers en **UTF-8** pour ne pas corrompre les accents (`é`, `·`, `→`).

Quand tu as terminé, affiche l'arborescence finale, le résultat de `node --check` sur les deux fichiers JS, et l'URL de déploiement.
