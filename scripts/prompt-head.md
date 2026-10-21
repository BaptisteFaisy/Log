# Prompt — reproduire à l'identique le site « Log » (console de logs d'erreur + agents)

Tu vas construire, depuis zéro, un site statique nommé **Log**. Aucune connaissance préalable de ce projet n'est supposée : tout ce qui est nécessaire est dans ce prompt. Le résultat doit être **identique au pixel et au comportement** à la spécification ci-dessous.

## 1. Rôle et objectif

Créer une page unique (plus une page de préviews) qui :

- affiche un **terminal** de logs qui défilent en continu, très réaliste, sur fond **blanc brillant** ;
- possède un bouton **« Lancer un log d'erreur »** à droite du bandeau supérieur ;
- à chaque clic, provoque une **vraie exception JavaScript**, l'affiche comme **erreur détectée** dans le terminal (carte détaillée : message + pile d'appels) ;
- **crée automatiquement un agent** de correction, affiché dans un **second panneau à droite** du terminal, avec un symbole animé qui travaille, l'état d'avancement, et le log d'erreur qu'il traite ;
- utilise le **rouge doux** comme seul accent, jamais agressif, sur fond blanc.

Contraintes absolues :

- **Vanilla uniquement** : HTML + CSS + JS, aucun framework, aucun bundler, aucune dépendance npm, aucun build. Le site doit fonctionner en ouvrant `index.html` en `file://`.
- Polices via Google Fonts : `Inter` (400,500,600,700) et `JetBrains Mono` (400,500,600).
- Aucune couleur bleue, aucun fond sombre, aucune image de fond bitmap (les fonds sont en CSS, sauf le canvas du fond « espace »).
- Interface en **français**, ton sobre et technique, pas d'emoji.
- Respecter `prefers-reduced-motion` (toutes les animations coupées).

## 2. Arborescence à produire

```
Log/
├── index.html
├── previews.html
├── styles.css
├── app.js
├── bg.js
├── logo.png
├── logo-detoure.png
├── logo-red.png
├── favicon.png
├── apple-touch-icon.png
└── .gitignore        # contenu : .vercel
```

## 3. Assets (à récupérer tels quels, sinon le rendu ne sera pas identique)

Télécharge les images depuis le site de référence, elles sont publiques :

```bash
curl -O https://log-errors.vercel.app/logo.png
curl -O https://log-errors.vercel.app/favicon.png
curl -O https://log-errors.vercel.app/apple-touch-icon.png
cp logo.png logo-detoure.png
```

- `logo.png` : logo détouré, fond **transparent**, 929×483 px. Il est affiché à gauche du bandeau, hauteur 30 px (26 px en mobile), largeur automatique, opacité 0.92.
- `favicon.png` : 64×64, **fond blanc plein**, deux parenthèses noires centrées, marge 5 px.
- `apple-touch-icon.png` : 180×180, même composition.

Si les URL ne sont pas accessibles, reconstruire les assets ainsi :

1. Partir d'une image carrée du logo (fond blanc, trait noir).
2. Détourer par luminance : pour chaque pixel, `alpha = 255 - (0.299R + 0.587G + 0.114B)`, seuils `alpha < 10 → 0`, puis forcer `R=G=B=0` ; recadrer sur la boîte englobante des pixels `alpha > 20` avec 8 px de marge.
3. Pour le favicon : recadrer la zone des parenthèses (environ `x=646, y=26, w=281, h=413` sur l'image détourée), la dessiner centrée sur un carré blanc avec 5 px de marge, en `HighQualityBicubic`, et exporter en 64×64 et 180×180.
4. Variante rouge du logo : même alpha, couleur `rgb(207, 59, 52)`.

## 4. Design system (valeurs exactes, à ne pas arrondir)

```css
--paper:#fdfcfb; --ink:#1a1614; --ink-2:#57504c; --ink-3:#928a85;
--line:rgba(26,22,20,.09); --line-soft:rgba(26,22,20,.06);
--red:#c8382f; --red-deep:#a52a23; --red-soft:#fbe9e7; --red-line:rgba(200,56,47,.22);
--amber:#a9761f; --ok:#2f7d5f; --radius:20px;
```

- Corps : `Inter`, fond `var(--paper)`, texte `var(--ink)`, `-webkit-font-smoothing: antialiased`.
- **Bandeau** : `position: sticky; top: 0; z-index: 30`, `background: rgba(255,255,255,.34)`, `backdrop-filter: blur(26px) saturate(180%)`, bordure basse `1px solid rgba(26,22,20,.07)`, padding `11px clamp(16px,4vw,40px)`, logo à gauche, actions à droite.
- **Boutons en pilule** (style ElevenLabs) : `border-radius: 999px`, `padding: 12px 20px`, `font-size: 13.5px`, `font-weight: 500`, `letter-spacing: -0.01em`, `gap: 8px`, icône SVG 15 px.
  - Primaire : dégradé `linear-gradient(180deg,#d2463d,#bd3129)`, bordure `rgba(150,32,26,.35)`, texte blanc, ombre `0 10px 24px -12px rgba(200,56,47,.75)` + liseré interne blanc 22 % ; hover `linear-gradient(180deg,#db5147,#c63a31)`.
  - Fantôme : fond `rgba(255,255,255,.66)`, bordure `rgba(26,22,20,.1)`, texte `--ink-2` ; hover fond blanc.
  - Petit : `padding: 8px 14px; font-size: 12px`.
  - `:focus-visible` → `box-shadow: 0 0 0 3px rgba(200,56,47,.18)`.
- **Deux rectangles côte à côte** : `.workspace` en grille `minmax(0,1fr) 372px`, `gap: 16px`, largeur `min(1020px,100%)`, centré, padding `clamp(14px,2.6vw,28px) clamp(12px,3vw,24px)` ; terminal et panneau agents ont la même hauteur `min(660px, calc(100vh - 148px))`. Sous 900 px : une colonne, terminal `min(560px,62vh)`, panneau `340px`. Sous 640 px : terminal `min(520px,58vh)`, panneau `320px`, rayons 16 px.
- **Surfaces vitrées** : fond `rgba(255,255,255,.74)` (terminal) et `.62` (panneau), `backdrop-filter: blur(22px) saturate(150%)`, bordure `1px solid rgba(26,22,20,.08)`, ombres `inset 0 1px 0 rgba(255,255,255,.9), 0 1px 2px rgba(60,30,24,.04), 0 30px 70px -38px rgba(80,34,28,.42)`.

## 5. Les cinq fonds (sélecteur `?bg=`)

`bg.js` lit `?bg=` et écrit `document.body.dataset.bg` (valeurs autorisées : `gloss`, `space`, `aurora`, `topo`, `halo`). **Défaut = `halo`** (`<body data-bg="halo">`).

Le fond est un `.bg-stage` fixe (`position: fixed; inset: 0; z-index: 0; pointer-events: none`) contenant : `<canvas id="warp" data-warp></canvas>`, un `.veil` (`linear-gradient(180deg, rgba(255,255,255,.75), transparent 34%)`), et deux pseudo-éléments : `::before` (les halos, opacité 0 par défaut) et `::after` (grain SVG en `feTurbulence` baseFrequency 0.85, `mix-blend-mode: multiply`, opacité 0 par défaut).

1. **`gloss` — blanc laqué** : fond `radial-gradient(120% 80% at 50% -20%, #fff 0%, #fdfbfa 46%, #f7f2f0 100%)` ; `::before` opacité 1 avec deux halos rouges (`rgba(200,56,47,.11)` en haut à droite 38×34 % à 82/8 %, `rgba(200,56,47,.07)` en bas à gauche) + un reflet `linear-gradient(112deg, transparent 38%, rgba(255,255,255,.85) 47%, transparent 56%)` ; grain 0.14.
2. **`space` — espace déformé** : même fond clair, le canvas devient visible (`display: block`, opacité .85) et dessine une grille ondulante animée (voir `bg.js`) ; grain 0.1.
3. **`aurora` — aurore rouge** : `linear-gradient(180deg,#fffdfc,#fbf6f4 60%,#f7efed)` ; trois halos rouges/saumon flous (`filter: blur(28px)`) animés `aurora 28s ease-in-out infinite alternate` (translation + scale) ; grain 0.12.
4. **`topo` — topographie** : deux `repeating-radial-gradient` de traits rouges (pas 26 px et 22 px) masqués par `radial-gradient(90% 70% at 50% 40%, #000 20%, transparent 78%)`, animation `topo 34s linear infinite alternate` ; grain 0.1.
5. **`halo` — halo au curseur (défaut)** : fond `radial-gradient(120% 90% at 50% -10%, #fff, #fbf7f6 55%, #f6efed 100%)` ; `::before` en `inset: 0` avec `radial-gradient(460px circle at var(--mx,50%) var(--my,20%), rgba(200,56,47,.14), rgba(200,56,47,.05) 40%, transparent 70%)` ; les variables `--mx/--my` sont animées en JS (lerp 0.16, `requestAnimationFrame`, uniquement si `pointer: fine`) ; grain 0.12.

Le canvas du fond « espace » : grille de pas 52 px (34 px sous 700 px de large), lignes verticales décalées par `sin(y*0.011 + t*0.55)*gap*0.34 + sin(y*0.026 - t*0.8)*gap*0.14`, lignes horizontales par `sin(x*0.009 + t*0.45)*gap*0.3 + sin(x*0.02 + t*0.7)*gap*0.12` ; une ligne sur quatre est plus marquée (`rgba(200,56,47,.14)` vs `.065` vertical, `.12` vs `.055` horizontal) ; `devicePixelRatio` plafonné à 2 ; boucle stoppée quand l'onglet est caché.

## 6. Terminal (panneau de gauche)

- En-tête : trois pastilles (`#f0a49f`, `#f0cf9f`, `#a9d6bd`, 9 px), titre centré `log@vercel — ~/logs`, à droite `live` en petites capitales avec un point rouge pulsé (`pulse 2.6s`).
- Corps scrollable (`overscroll-behavior: contain`), scrollbar fine translucide.
- Une ligne de log = grille `92px 42px minmax(0,1fr)`, `column-gap: 10px`, `padding: 3px 14px`, `font-size: 11.5px`, `line-height: 1.5`, animation d'entrée `rowIn .18s`.
  - horodatage `HH:MM:SS.mmm` (chiffres tabulaires, `font-variant-numeric: tabular-nums`, `white-space: nowrap`, couleur `#a9a19c`, 10.5 px) ;
  - badge de niveau 3 lettres en majuscules (`dbg`, `inf`, `wrn`, `ok`, `err`), 9 px, pastille arrondie 5 px ;
  - message en `JetBrains Mono` avec `overflow-wrap: anywhere`.
  - Couleurs : `err` → badge `#a52a23` sur `#fbe9e7`, texte `#8f2f28` ; `wrn` → `#a9761f` sur `#fbf1de`, texte `#8a6318` ; `ok` → `#2f7d5f` sur `#e7f3ed`.
  - **Les colonnes sont fixes : aucun chevauchement possible entre l'horodatage, le badge et le message.**
- Pied : `N lignes · <statut> … UTF-8 · HH:MM:SS` en 9.5 px majuscules espacées.
- Mobile (≤640 px) : grille `78px 38px 1fr`, police 11 px, padding 3px 10px.

## 7. Erreur détectée (dans le terminal)

Au clic sur le bouton (ou touche `Entrée` sur `body`) :

1. une ligne `err` est ajoutée : `POST /api/checkout → 500 · <CODE>` ;
2. une des quatre fonctions suivantes est exécutée pour lever une **vraie** exception : `payload.order.items.length` sur `{orderId:null}` (`ERR_PAYLOAD_INVALID`) ; `session.refreshToken()` sur `{}` (`ERR_UNDEFINED_CALL`) ; `JSON.parse('{"user": "gaia", }')` (`ERR_PARSE_FAILED`) ; `buffer[12].toString()` sur `[1,2,3]` (`ERR_RANGE_OVERFLOW`) — en rotation ;
3. la carte d'erreur est insérée dans le flux : fond `linear-gradient(180deg, rgba(255,250,249,.95), rgba(255,245,243,.9))`, bordure `rgba(200,56,47,.22)`, rayon 16 px, marges `9px 12px 11px`, animation d'entrée + **halo rouge** `errGlow 1.6s` via `[data-fresh="true"]` (remis à `false` après 2 s) ;
4. contenu de la carte : icône `!` sur `#f8dbd7`, nom de l'erreur (`TypeError`, `SyntaxError`…), sous-titre `<CODE> · trace <6 hex>`, heure, message en mono rouge `#7a2c25`, **pile d'appels** dans un `<pre>` gris (10 px, max-height 92 px), puis **uniquement** un bouton fantôme « Copier la trace » (copie `[CODE] Name: message` + stack via `navigator.clipboard`, feedback « Copié » 1,5 s) ;
5. le statut du terminal passe à `erreur détectée` ;
6. **il n'existe aucun bouton « Créer un agent »** : l'agent est créé automatiquement **380 ms** plus tard.

Les handlers globaux `error` et `unhandledrejection` créent la même carte (codes `ERR_UNCAUGHT`, `ERR_UNHANDLED_REJECTION`).

## 8. Panneau agents (rectangle de droite)

- En-tête : titre `agents`, sous-titre mono `surveillance des erreurs`, compteur à droite `N actif(s)` (rouge quand > 0, gris sinon).
- Pied : point rouge + `veille active · N erreur(s)`.
- État vide : orbe en pointillés rouges + `aucun agent` / `en attente d'incident`.
- **Une carte par erreur**, empilées avec **la plus récente en haut**, **3 maximum** (les plus anciennes sont retirées avec leurs timers). Chaque carte contient :
  - un **symbole d'agent animé** : disque 28 px en `conic-gradient` rouge qui tourne (`orbSpin 2.2s linear infinite`), cœur clair en `::before`, point rouge lumineux en orbite en `::after`, pastille centrale qui respire (`orbBreathe 1.9s`) ;
  - le nom `agent/fix-<code>` (code en minuscules, `ERR_` retiré, `_` → `-`) ;
  - la ligne mono `<CODE> · <trace>` ;
  - une pastille d'état : `analyse` → `correctif` → `vérification` → `prêt` (rouge, puis verte `#2f7d5f` sur `#e7f3ed` à la fin) ;
  - **quatre segments de progression** : gris, puis rouge plein pour les étapes faites, et un segment animé (`barSweep 1.1s`) pour l'étape en cours ;
  - **le log d'erreur traité** : encart mono `err · <CODE> · <message>`, fond `rgba(200,56,47,.055)`, bordure `rgba(200,56,47,.14)`, texte `#8f2f28`, 2 lignes max ; à la fin il devient vert `ok · patch appliqué · tests 12/12 · <CODE>`.
- Cycle : création → ligne `inf` dans le terminal `agent/fix-<slug> créé · <CODE> · <trace>` → une étape toutes les `900 + random*700` ms → à la fin : ligne `ok` `patch appliqué · <CODE> · tests 12/12`, statut terminal `correctif prêt`, compteur `0 actif`, carte en `data-state="done"` (animations du symbole stoppées, bordure verte).

## 9. Flux continu

Un log simulé est ajouté toutes les `650–1900 ms` (plus rapide, `120–380 ms`, dans 10 % des cas) parmi : `GET/POST <route> <code> · <ms> ms`, `cache hit|miss|revalidate · key=…`, `worker ready · region=cdg1|fra1|iad1 · pid=…`, `queue consume · batch=… · lag=… ms`, `deploy ready · dpl_<9 hex>`, `slow query · … (seuil 400 ms)`, `trace <16 hex> · sampled=0.x`, `WS /socket connected · clients=…`. Routes : `/api/health`, `/api/session`, `/api/logs`, `/api/metrics`, `/api/checkout`, `/api/profile`, `/api/events`. Le flux est plafonné à 160 lignes (les plus anciennes sont supprimées) et ne force le défilement que si l'utilisateur est déjà en bas (< 80 px du bas).

Au chargement : `session attachée · tail -f /var/log/app.log` (`inf`), `handlers error et unhandledrejection actifs` (`ok`), compteur agents `0 actif`, pied `veille active · 0 erreur`. `?demo=error` déclenche une erreur après 600 ms.

## 10. Page `previews.html`

Même charte, fond `halo`, sans logique de logs :

- en-tête : logo 26 px, `fonds & états`, bouton « Retour au site » ;
- titre `Cinq fonds, deux moments.` + paragraphe ;
- grille de 5 cartes cliquables (vignette 186 px reproduisant chaque fond + mini-terminal + numéro `01`–`05` + nom + badge `défaut` sur `Halo au curseur`), liens vers `index.html?bg=<clé>` ;
- section « Quand une erreur est détectée — terminal + agent » : deux maquettes statiques côte à côte (terminal + panneau agents) montrant l'état **erreur détectée / agent en analyse** puis **correctif prêt / 0 actif** ;
- encadré final rappelant `index.html?demo=error` et le fond par défaut.

## 11. Livraison

```bash
git init -b main
git add -A
git commit -m "Site Log: terminal de logs, erreurs detectees, agents de correction"
gh repo create <compte>/Log --public --source . --remote origin --push
npx vercel@latest deploy --prod --yes --name log-errors
```

## 12. Critères d'acceptation (à vérifier avant de répondre)

1. `index.html` ouvert en local : logs qui défilent, bandeau blanc translucide, halo rouge qui suit le curseur.
2. Clic sur « Lancer un log d'erreur » : ligne `err`, carte détaillée avec pile d'appels et **halo rouge**, statut `erreur détectée`, puis **agent créé sans aucune action** dans le panneau de droite.
3. L'agent progresse seul (`analyse` → `correctif` → `vérification` → `prêt`), ses 4 segments se remplissent, et le terminal finit par afficher `patch appliqué · … · tests 12/12`.
4. Aucun bouton « Créer un agent », aucune notion d'épinglage, aucune couleur bleue, aucun fond sombre.
5. Horodatages jamais chevauchés par le badge ni par le message, à toutes les largeurs.
6. Favicon : deux parenthèses noires centrées sur carré blanc.
7. `?bg=gloss|space|aurora|topo|halo` change le fond ; `halo` par défaut ; `?demo=error` fonctionne.
8. `node --check app.js` et `node --check bg.js` passent.
