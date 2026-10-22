# Nettoyage niveau 1 — gardiens côté VM

Date : 2026-10-21 12:13–12:16
Portée : **VM uniquement**. Le téléphone n'a pas été modifié (pas d'APK désinstallé,
pas de paquet désactivé, pas de service d'accessibilité coupé côté tel).

## Ce qui a été arrêté et désactivé

### Unités utilisateur (~/.config/systemd/user/)
| Unité | État avant | État après |
|---|---|---|
| scope-watch.service | active/enabled | inactive/disabled |
| phone-watch.service | active/enabled | inactive/disabled |
| zeroclaw.service | active/enabled | inactive/disabled |

### Unités système (/etc/systemd/system/)
| Unité | État avant | État après |
|---|---|---|
| scope-watch.service | enabled | disabled |
| decision-router.service | active/enabled | inactive/disabled |
| phone-watch.service | disabled | disabled |
| phone-auto.timer | disabled | disabled |
| phone-scripts.service | disabled | disabled |
| phone-api.service | disabled | disabled |

### Script neutralisé
- `~/bin/phone-autorestore` → renommé `~/bin/phone-autorestore.disabled`
  (c'était le script qui réactivait les gardiens ET faisait `pm enable` des
  4 paquets du téléphone — TeamViewer x3 + free VPN)

## Vérification
- Aucun processus résiduel (decision-router, phone-watch, scope-watch, zeroclaw)
- Aucun respawn après 45 s (les unités avaient `Restart=always`)
- Ports 8799 (routeur) et 8787 (API) : plus rien en écoute

## Restauration
```bash
~/logs/cleanup-20261021-131324/restore.sh
```

## Reste à faire côté téléphone (bloqué : ADB injoignable)
`adb devices` → aucun appareil. Scan des ports ADB (5555 + 37000-44000) sur
`10.120.101.165`, `10.188.216.105` et `100.79.244.93` → seul le port 8790
(miroir) répond. Le débogage sans fil est éteint / le port a changé.

À faire quand ADB revient :
- [ ] `pm uninstall com.baptiste.screenscope` (+ désactiver son AccessibilityService)
- [ ] `pm disable-user com.teamviewer.quicksupport.addon.universal`
- [ ] `pm disable-user com.teamviewer.host.market`
- [ ] `pm disable-user com.teamviewer.teamviewer.market.mobile`
- [ ] `pm disable-user com.free.vpn.super.hotspot.open`
- [ ] auditer `com.codexswitch.terminal.debug` (scripts ?) et `com.termux` (cron Termux)

⚠️ Tant que `scope-watch` est arrêté, rien ne réinstalle l'APK. Le reactive
par contre dès que le téléphone est de nouveau joignable en ADB.
