## 3. Assets (inclus ici en base64 — aucune dépendance externe)

Ce prompt est **autonome** : les trois images sont fournies ci-dessous. Décode-les en fichiers PNG avant de commencer. Ne les régénère pas, ne les redimensionne pas, ne les recompresse pas : le rendu en dépend.

### `logo.png` — logo détouré, fond transparent, 929×483

```bash
base64 -d > logo.png <<'EOF'
{{LOGO_B64}}
EOF
```

### `favicon.png` — 64×64, fond blanc plein, deux parenthèses noires centrées

```bash
base64 -d > favicon.png <<'EOF'
{{FAVICON_B64}}
EOF
```

### `apple-touch-icon.png` — 180×180, même composition que le favicon

```bash
base64 -d > apple-touch-icon.png <<'EOF'
{{TOUCH_B64}}
EOF
```

Puis duplique le logo : `cp logo.png logo-detoure.png` (et `logo-red.png` = même alpha, couleur `rgb(207, 59, 52)`, si tu veux la variante rouge).

Utilisation exacte :

- `logo.png` dans le bandeau, à gauche : `height: 30px` (26 px sous 640 px), `width: auto`, `max-width: 170px`, `object-fit: contain`, `opacity: .92`.
- `favicon.png` via `<link rel="icon" href="favicon.png" type="image/png" />` ; `apple-touch-icon.png` via `<link rel="apple-touch-icon" href="apple-touch-icon.png" />`.

Si malgré tout les base64 sont inutilisables (copie tronquée), reconstruis-les ainsi :

1. Partir d'une image carrée du logo (fond blanc, trait noir).
2. Détourer par luminance : `alpha = 255 - (0.299R + 0.587G + 0.114B)`, seuil `alpha < 10 → 0`, puis forcer `R=G=B=0` ; recadrer sur la boîte englobante des pixels `alpha > 20` avec 8 px de marge.
3. Favicon : recadrer la zone des parenthèses (environ `x=646, y=26, w=281, h=413` de l'image détourée), la dessiner centrée sur un carré **blanc** avec 5 px de marge, en `HighQualityBicubic`, exporter en 64×64 et 180×180.
