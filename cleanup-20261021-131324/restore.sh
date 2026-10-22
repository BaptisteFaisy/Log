#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore.sh — remet exactement l'etat d'avant le nettoyage du 2026-10-21 13:13.
#
#   ./restore.sh          # reactive tout (gardiens VM + phone-autorestore)
#
# Le telephone n'etait PAS hors ADB a ce moment-la : l'etat du telephone
# (ScreenScope, TeamViewer, VPN) n'a PAS ete touche par ce nettoyage.
# Pour le telephone, voir les notes de la section "reste a faire" du rapport.
# ---------------------------------------------------------------------------
set -uo pipefail

echo "== 1. phone-autorestore =="
if [ -f /home/baptistefaisy/bin/phone-autorestore.disabled ]; then
  mv /home/baptistefaisy/bin/phone-autorestore.disabled \
     /home/baptistefaisy/bin/phone-autorestore
  echo "   restaure"
else
  echo "   rien a faire"
fi

echo "== 2. unites systeme =="
sudo systemctl enable scope-watch.service decision-router.service 2>&1 | sed 's/^/   /'
sudo systemctl start decision-router.service 2>&1 | sed 's/^/   /'

echo "== 3. unites utilisateur =="
systemctl --user enable scope-watch.service phone-watch.service zeroclaw.service 2>&1 | sed 's/^/   /'
systemctl --user start scope-watch.service phone-watch.service zeroclaw.service 2>&1 | sed 's/^/   /'

echo
echo "Etat final :"
for u in scope-watch.service decision-router.service phone-watch.service phone-auto.timer phone-scripts.service phone-api.service; do
  echo "  systeme $u enabled=$(systemctl is-enabled $u 2>&1) active=$(systemctl is-active $u 2>&1)"
done
for u in scope-watch.service phone-watch.service zeroclaw.service; do
  echo "  user    $u enabled=$(systemctl --user is-enabled $u 2>&1) active=$(systemctl --user is-active $u 2>&1)"
done
