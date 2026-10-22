# Guides « prochain agent » — base pg-memoire (historique)

Instantane des guides stockes en base et affiches par la colonne
« Guide (prochain agent) » de https://log-lac-five.vercel.app (Observability > Historique).

Genere le 2026-10-22 depuis /api/pg-memoire (version 18.6).
Chaque guide est la trace de ce qui a ete fait : commandes lancees, ce qui a ete
observe, cause, correctif, verification.

## historique (table `historique.historique`, colonne `resolution`)

### #1 — Mot de passe PostgreSQL Aiven masque dans l'API

```
TRACE 2026-10-22 07:43 (projet Aiven baptiste-c04f, service pg-memoire)
1) avn service get pg-memoire --json | jq .service.service_uri_params -> le champ password vaut REDACTED.
2) meme resultat sur les autres canaux : avn service user-list, puis curl -H "authorization: aivenv1 $TOKEN" https://api.aiven.io/v1/project/baptiste-c04f/service/pg-memoire -> masque aussi.
3) conclusion : ce n'est pas un probleme de droits, l'API ne rend JAMAIS un mot de passe en lecture ; insister ne sert a rien.
CAUSE : un mot de passe Aiven n'est lisible qu'a la creation du service ou apres un reset-credentials.
CORRECTIF APPLIQUE : PUT /v1/project/baptiste-c04f/service/pg-memoire/user/avnadmin avec {"operation":"reset-credentials","new_password":<valeur deja presente dans .secrets/creds.env>} ; la valeur est stockee dans hackathon-memory/.secrets/creds.env (chmod 600).
PIEGE : reset-credentials coupe les sessions en cours, et d'autres agents lisent creds.env : reaffecter la valeur existante, ne jamais en generer une nouvelle.
VERIF : psql "$DATABASE_URL" -c 'select current_user' -> avnadmin.
```

### #2 — avn service cli psql echoue avec password authentication failed

```
TRACE 2026-10-22 07:47 (service pg-memoire, base historique)
1) avn service cli pg-memoire -- psql -c 'select 1' -> FATAL: password authentication failed for user "avnadmin".
2) hypothese "mot de passe faux" ecartee : PGPASSWORD=••• psql "host=<api> port=<api> user=avnadmin dbname=historique sslmode=require" -c 'select 1' -> OK.
3) hypothese "host/port faux" ecartee : service_uri_params relus via l'API -> identiques au psql direct.
4) preuve : l'URI que le CLI transmet a psql contient *** a la place du mot de passe.
CAUSE : avn service cli masque le mot de passe dans l'URI de connexion ; psql recoit litteralement ***.
CORRECTIF : ne jamais utiliser avn service cli <service> -- psql. Connexion directe, PGPASSWORD issu de .secrets/creds.env, sslmode=require.
VERIF : psql ... -c 'select current_user' -> avnadmin. Les commandes avn qui ne passent pas par psql (database-list, user-list) fonctionnent normalement.
```

### #3 — Service Aiven recree : port PostgreSQL change

```
TRACE 2026-10-22 07:43 (apres disparition du service)
1) DATABASE_URL pointait ...k.aivencloud.com:21492 -> psql: could not translate host name / connection refused.
2) avn service list --project baptiste-c04f -> 0 service : pg-memoire n'existe plus, la base historique avec lui.
3) recreation : avn service create pg-memoire -t pg -p free-1-1gb --cloud do-lon --no-fail-if-exists, puis boucle sur service.state jusqu'a RUNNING.
4) avn service get pg-memoire --json | jq .service.service_uri_params -> host ...i.aivencloud.com, port 21492. Les suffixes .k. et .e. codes en dur dans scripts/setup_aiven.sh etaient FAUX : le .env produit etait inconnectable.
CAUSE : Aiven reaffecte host et port a chaque creation de service ; toute valeur codee en dur devient invalide.
CORRECTIF : lire host/port via l'API a chaque fois, puis reecrire UNE seule ligne (DATABASE_URL) de .env, mode 600 preserve, VALKEY_URL et les autres cles intactes.
VERIF : psql "$DATABASE_URL" -c 'select current_user' -> app.
PIEGE : avn service database-list renvoie 404 quand le service n'existe pas ; ne pas conclure "base absente" sans avoir verifie le service.
```

### #4 — Problème d'authentification PostgreSQL après recréation

```
TRACE 2026-10-22 07:43-07:47 (juste apres avn service create)
1) psql avec le couple avnadmin / PGADMIN de .secrets/creds.env -> password authentication failed.
2) avn service user-list pg-memoire -> avnadmin et app presents : le role existe, ce n'est donc pas un probleme d'utilisateur manquant.
3) CAUSE : la recreation du service a regenere les mots de passe par defaut ; creds.env contient les valeurs de l'ANCIEN service.
4) CORRECTIF APPLIQUE : PUT .../user/avnadmin puis .../user/app avec {"operation":"reset-credentials","new_password":<valeur de creds.env>} — on reaffecte, on ne genere pas.
5) puis GRANT a app, sinon "permission denied for schema public" : GRANT ALL ON SCHEMA public TO app; GRANT ALL ON ALL TABLES IN SCHEMA public TO app;
VERIF : psql en tant que app -> select current_user = app, et lecture des 5 documents de historique.
PIEGE : reset-credentials invalide les sessions en cours ; prevenir avant d'agir.
```

### #22 — Test — timeout de connexion PostgreSQL

```
TRACE 2026-10-22 07:53 (base historique, plan hobbyist : 25 connexions)
1) symptome : timeout de connexion cote application ; dans otel.logs : too many connections for role "sonde".
2) tools/pg-diag "SELECT state,count(*) FROM pg_stat_activity GROUP BY 1" -> beaucoup de sessions 'idle in transaction'.
3) SHOW max_connections -> 25 ; le code applicatif ouvrait une connexion par requete.
4) cause 1 : connexions jamais rendues au pool (pas de finally) ; cause 2 : plafond de 25 connexions sur le plan hobbyist.
5) RESOLUTION COMPLEMENTAIRE 07:53 : bloc finally autour de chaque usage de connexion (augmenter max_connections ne suffisait pas).
CORRECTIF : rendre la connexion dans un finally / try-with-resources, pool partage au lieu d'une connexion par requete, PgBouncer si besoin ; augmenter max_connections en dernier recours.
VERIF : apres 100 requetes, SELECT count(*) FROM pg_stat_activity WHERE datname='historique' reste stable et sous max_connections - 5 ; plus de "too many connections".
PIEGE : "current transaction is aborted" = erreur avalee sans ROLLBACK, meme cause.
```

## mémos (`historique.error_resolutions`)

### ERR_UI_BRAND_UNSTYLED · empreinte 004aea24350886

```
Cause : TRACE 2026-10-22 11:24 (site log-lac-five, trace 004aea24350886)
1) signalement : le logo "log()" de l'en-tete s'affiche en texte brut au-dela de 640 px de large.
2) grep -n "brand-word|brand-call" styles.css -> les regles .brand-word / .brand-call etaient DANS @media (max-width:640px).
3) lecture : au-dessus de 640 px le media query ne s'applique pas -> ni Space Mono, ni 26 px, ni couleur rouge sur "()".
4) controle avant correctif : getComputedStyle(.brand-word) a 1440 px -> police par defaut, taille heritee.
CAUSE : la mise en forme du logo etait enfermee dans un media query mobile ; aucun style de base n'existait hors du media query.
Correctif : 1) sortir .brand-word et .brand-call du @media (max-width:640px) : bloc de base au niveau global (Space Mono, 26 px, 700, letter-spacing -0.07em pour .brand-word ; color var(--red) pour .brand-call).
2) ne laisser dans le media query que la reduction mobile : .brand-word { font-size: 22px }.
3) aucun autre selecteur touche : pas de reformatage, pas de renommage, pas de nettoyage opportuniste.
RESULTAT : logo style a toutes les largeurs, toujours reduit a 22 px sous 640 px.
Fichiers : styles.css
Vérification : 1) styles.css : .brand-word est defini HORS media query (grep -n -A6 "^\.brand-word" styles.css -> ~ligne 1008, avant le @media 640 de la ligne ~1767).
2) Chrome headless, fenetre 1440 px : getComputedStyle(.brand-word) -> 26px / 700 / Space Mono.
3) fenetre 375 px : getComputedStyle(.brand-word) -> 22px (override mobile toujours actif).
4) .brand-call : color rgb(255,46,147) = var(--red) aux deux largeurs.
ETAT VERIFIE le 2026-10-22 13:40 sur la prod : les 4 points sont conformes.
```

### ERR_DISK_FULL · empreinte 11be9e0fe720e7

```
Cause : TRACE 2026-10-22 09:12 (trace e5a9b1c3, error.type=disk_full)
1) tools/debug-bundle e5a9b1c3 -> java.io.IOException: No space left on device: write /var/lib/app/telemetry-buffer failed ; file.path = /var/lib/app/telemetry-buffer.
2) trace-dump e5a9b1c3 --detectors -> system.disk.usage = 100 %, system.disk.free = 0 ; retry_spiral / silent_failure / stale_source = ok.
3) jvm.* absents de la trace -> hypothese OOM ecartee faute de preuve.
4) la trace a bien ete consommee depuis otel.traces -> le broker Kafka n'est pas en cause.
CAUSE : le volume du tampon de telemetrie est sature (ecriture sans rotation ni retention) ; l'echec d'ecriture est le symptome, pas la cause.
Correctif : 1) debloquer sur l'hote fautif, pas sur le broker : df -h /var/lib/app/telemetry-buffer ; du -sh /var/lib/app/telemetry-buffer, puis purge des fichiers anciens (find ... -mtime +1 -delete).
2) traiter la cause : borner le tampon (rotation size-based ~5 GiB, max 5 fichiers) + backpressure explicite au seuil haut.
3) si le volume est structurellement trop petit : volume dedie a /var/lib/app/telemetry-buffer plutot que /var partage.
4) alerter a system.disk.usage > 85 % et free < 5 GiB, donc avant 100 %.
A NE PAS FAIRE : redemarrer Kafka, toucher au broker, ouvrir un ticket reseau.
Fichiers : /var/lib/app/telemetry-buffer,tools/debug-bundle,agents/runtime-diagnose.md
Vérification : 1) df -h sur le volume -> usage < 85 %, system.disk.free de nouveau au-dessus du seuil.
2) rejeu : app.errors{error.type=disk_full} retombe a 0.
3) SELECT count(*) FROM logs WHERE code='ERR_DISK_FULL' ne bouge plus.
4) debug-bundle sur la trace suivante -> les 3 detecteurs restent ok.
```

### ERR_OOM_HEAP · empreinte 0d8832e7af57d2

```
Cause : TRACE 2026-10-22 09:11 (trace dbe4d91a, error.type=oom)
1) tools/debug-bundle dbe4d91a -> java.lang.OutOfMemoryError: Java heap space ; spans jvm.heap (Error) et agent.run (Error, tool_calls=1).
2) trace-dump dbe4d91a --detectors -> jvm.memory.used = 2 147 483 648 B = jvm.memory.limit (2 GiB), headroom nul ; jvm.gc.pause 1600 ms "end of major GC".
3) free -m sur le poste -> 5742/6546 Mo utilises, 0 swap ; le java local est le broker Kafka en -Xmx640M, PAS la JVM incrimee (2 GiB) : ne pas confondre les deux.
4) disque : aucune metrique, / local a 14 % -> hors cause.
CAUSE : heap sature (fuite ou pic) au plafond de 2 GiB ; le GC majeur est inefficace, ce n'est pas un GC mal regle.
Correctif : 1) retablir le service : relever la limite -Xmx2g -> -Xmx4g (ou jvm.memory.limit cote deployeur).
2) capturer la fuite AVANT redemarrage, sinon l'incident se reproduit : -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/var/log/agent/ puis jcmd <pid> GC.heap_dump /tmp/agent.hprof ; analyser avec Eclipse MAT (histogramme des classes dominantes).
3) NE PAS toucher au GC : -XX:MaxGCPauseMillis ou changer de collecteur ne corrige pas used == limit.
4) disque : rien a faire, ce n'est pas le facteur.
Fichiers : /tmp/agent.hprof,tools/debug-bundle,agents/runtime-diagnose.md
Vérification : 1) apres redemarrage : jvm.memory.used nettement sous jvm.memory.limit (headroom > 25 %).
2) jvm.gc.pause du GC majeur < 500 ms.
3) aucune nouvelle trace error.type=oom dans otel.logs pendant la charge de controle.
4) le .hprof est present et analysable (MAT/jhat) : la cause est documentee, pas seulement contournee.
```

### ERR_KAFKA_UNREACHABLE · empreinte 18ed18556ac80c

```
Cause : TRACE 2026-10-22 09:12 (trace e33bccd0, error.type=kafka_unreachable)
1) tools/debug-bundle e33bccd0 -> Kafka Broker Unreachable: broker not reachable (ERR__TRANSPORT) ; topic de destination agent-events.
2) trace-dump e33bccd0 --detectors -> retry_spiral ok : echec net, l'agent ne martele pas.
3) kafka-health --deep -> cluster SAIN (brokers joignables) mais le topic attendu est ABSENT de list_topics.
4) lecture : ERR__TRANSPORT est le code que le producteur remonte quand l'ACL Write est refusee (producer.flush() masque l'erreur ACL reelle) ; le topic apparait "introuvable" et non "interdit".
CAUSE : ACL manquante sur agent-events (Describe + Write, pattern LITERAL) ; ce n'est ni une panne broker, ni un probleme TLS/DNS.
Correctif : 1) avn service topic-list agent-kafka --project baptiste-c04f : discrimine "topic inexistant" et "ACL refusee".
2) poser l'ACL Describe + Write sur agent-events en pattern LITERAL pour l'utilisateur du producteur.
3) corriger provision.sh pour que le prefixe ACL couvre la destination applicative, sinon le scenario revient au prochain reprovisionnement.
4) durcir le producteur : mapper ERR__TRANSPORT + topic absent de list_topics vers TOPIC_AUTHORIZATION_FAILED dans tools/kafkalib.py.
A NE PAS FAIRE : redemarrer le broker, ouvrir un ticket reseau, modifier TLS.
Fichiers : provision.sh,tools/kafkalib.py,agents/kafka-diagnose.md
Vérification : 1) kafka-health --deep -> agent-events present dans list_topics.
2) rejeu du scenario d'emission -> aucun ERR__TRANSPORT, les messages arrivent (kafka_offset avance).
3) SELECT count(*) FROM logs WHERE code='ERR_KAFKA_UNREACHABLE' ne bouge plus.
4) apres reprovisionnement complet, la meme emission passe : la correction de provision.sh est bien effective.
```

### ERR_PG_TIMEOUT_5432 · empreinte 0032754cfaa96c

```
Cause : TRACE 2026-10-22 07:57 (trace 679f3cf1, error.type=db_connection_timeout)
1) tools/debug-bundle 679f3cf1 -> Connection timeout on port 5432 ; hote vise postgres-db.internal, pool HikariPool-1.
2) trace-dump 679f3cf1 --detectors -> aucun compteur serveur, aucune metrique de pool : la trace ne prouve pas la cause.
3) getent hosts postgres-db.internal depuis le poste -> echec, mais le poste n'est PAS sur le reseau de l'agent : ce n'est pas une preuve de DNS casse.
4) discriminé sans succes : connectique (DNS / port / service) contre saturation du pool -> il manque un releve operateur.
CAUSE (par ordre de probabilite, a confirmer) : filtrage reseau sur 5432, DNS interne lent, ou max_connections atteint cote serveur.
Correctif : 1) depuis l'hote applicatif, pas depuis le poste : getent hosts postgres-db.internal puis nc -vz -w 5 postgres-db.internal 5432 (ou pg_isready -h ... -p 5432 -t 5).
2) cote serveur : SELECT state,count(*) FROM pg_stat_activity GROUP BY 1 ; SELECT count(*) used, current_setting('max_connections')::int max FROM pg_stat_activity.
3) cote pool : /actuator/metrics/hikaricp.connections.{active,idle,max,pending} ou JMX ActiveConnections / ThreadsAwaitingConnection.
4) lecture : ThreadsAwaitingConnection > 0 avec Idle = 0 et Active = Max -> fuite de connexion (correctif applicatif) ; nc en echec avec pool sain -> connectique ; idle in transaction anciens -> fuite confirmee en base.
5) ne porter connectTimeout a 10 s et 2 retries qu'APRES avoir identifie la cause : un timeout plus long masque le probleme.
Fichiers : agents/db-diagnose.md,tools/pg-diag,tools/debug-bundle
Vérification : 1) nc -zv <hote>:5432 OK depuis chaque hote applicatif.
2) 100 connexions froides < 10 s, aucune SQLTransientConnectionException.
3) SELECT count(*) FROM pg_stat_activity reste sous max_connections - 5.
4) nouvelle trace db_connection_timeout absente de otel.logs ; debug-bundle -> detecteurs ok.
Si le point 1 echoue encore, la cause est reseau : aucun correctif applicatif ne la masquera.
```

### ERR_PAYLOAD_INVALID · empreinte log_mvj9itan_72u7b2

```
Cause : TRACE 2026-10-22 08:11 (5 logs, service agent-demo, route /api/checkout)
1) SELECT payload FROM logs WHERE code='ERR_PAYLOAD_INVALID' -> {"route":"/api/checkout","region":"cdg1"} : aucun champ order.
2) message applicatif -> Cannot read properties of null (reading 'order') : lecture de payload.order sans garde.
3) lecture : ce n'est pas un probleme d'infrastructure, le log est bien arrive par otel.logs (kafka_offset avance) ; il manque seulement la validation d'entree.
CAUSE : payload.order absent (null) et dereference directement par le handler /api/checkout ; aucune validation avant lecture.
Correctif : 1) valider le payload avant lecture : si !payload || !payload.order -> repondre 400 invalid_payload avec un message explicite, sans derefencer order.
2) journaliser en warn avec la route et la cle manquante, pas en err : ce n'est pas une panne.
3) tests de non-regression : POST /api/checkout avec {} puis avec {"order":null} -> 400, jamais 500 ni TypeError.
4) ne pas mettre de valeur par defaut silencieuse : une commande sans order ne doit pas etre traitee.
Fichiers : app.js
Vérification : 1) POST /api/checkout avec un payload vide -> 400 invalid_payload, plus de TypeError.
2) POST /api/checkout avec un payload valide -> 200, commande traitee.
3) SELECT count(*) FROM logs WHERE code='ERR_PAYLOAD_INVALID' ne bouge plus apres le correctif.
4) suite de tests du site : 12/12 verts.
```

### ERR_DB_POOL_EXHAUSTED · empreinte 114474dc77b282

```
Cause : TRACE 2026-10-22 09:11 (trace d7cce6a5, error.type=db_pool_exhausted)
1) tools/debug-bundle d7cce6a5 -> error.type=db_pool_exhausted, pool=HikariPool-1, outil en echec tool.check_reservation.
2) trace-dump d7cce6a5 --detectors -> pool.active=20, idle=0, max=20, db.client.connection.timeouts=4 ; retry_spiral [PROBLEME] (4 appels a 380 ms), silent_failure ok.
3) lecture : les 4 echecs sont des timeouts d'ACQUISITION, la requete SQL n'est jamais emise ; 4 x 380 ms ~ 1520 ms = 95 % du span racine (1600 ms).
4) fuite contre charge : active = max = 20 avec idle = 0 en permanence est la signature d'une fuite ; une simple charge laisserait transiter des idle.
CAUSE : connexions jamais rendues au pool (session ouverte sans close) -> pool 20/20 sature ; la spirale de retry est la consequence, pas la cause.
Correctif : 1) localiser la session non rendue : SELECT pid,state,now()-state_change age,left(query,80) FROM pg_stat_activity WHERE datname='historique' ORDER BY age DESC LIMIT 20 ; les "idle in transaction" les plus anciens designent le code fautif.
2) correctif applicatif : try-with-resources / @Transactional autour de chaque usage de connexion ; relacher les sessions bloquees avec SELECT pg_terminate_backend(pid).
3) ne PAS augmenter maximumPoolSize avant d'avoir ferme la fuite : cela masque le bug.
4) lever la contradiction du message : HikariPool$PoolInitializationException = echec de creation (connectique / credentials), pas saturation -> lire le log complet de HikariPool-1 ("Exception during pool initialization" contre "Connection is not available").
Fichiers : agents/db-diagnose.md,tools/pg-diag,tools/debug-bundle
Vérification : 1) tools/pg-diag "SELECT state,count(*) FROM pg_stat_activity WHERE datname='historique' GROUP BY 1" -> plus d'idle in transaction qui vieillit.
2) charge 50 req/s pendant 5 min : pool.active < pool.max, idle > 0, pending = 0.
3) curl /actuator/metrics/hikaricp.connections.pending -> 0.
4) aucune nouvelle trace db_pool_exhausted dans otel.logs ; debug-bundle sur la trace suivante -> retry_spiral ok.
```
