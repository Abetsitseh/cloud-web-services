# Michel.Reaper — Google Cloud Web Services & Kit de Déploiement

Ce projet fournit une console web moderne inspirée de Google Cloud Run pour déployer et piloter des services web conteneurisés Docker. Il fonctionne de manière complètement active et autonome (moteur local autonome avec reverse-proxy HTTP intégré) ou connecté au cloud Fly.io. Le déploiement interactif est décrit à la section 6.

## Sommaire

1. Déployer une image Docker
2. Durée de vie des machines (TTL)
3. Routage et mise à l'échelle
4. Accès privé au réseau Fly.io
5. Construire et publier une image
6. Interface de déploiement

## 1. Déployer une image Docker

Le client et le script shell vérifient si l'application existe, la créent si nécessaire, allouent une IPv4 partagée, créent une machine puis attendent son démarrage (20 secondes). Le script shell requiert Bash, `curl` et Node.js pour encoder et lire les réponses JSON. Les deux déploiements valident les paramètres essentiels et tentent de supprimer la machine en cas d'échec. Ils suppriment aussi l'application uniquement si elle a été créée par cette tentative; une application préexistante n'est jamais supprimée. Une IPv4 allouée à une application préexistante peut rester allouée après un échec.

## 2. Durée de vie des machines (TTL)

`ttl.js` fournit des options, un compte à rebours et des fonctions de calcul. Le déploiement ne les utilise pas et aucun planificateur ne détruit automatiquement une machine à l'échéance. Pour activer cette fonction, le projet appelant doit enregistrer l'expiration et exécuter un traitement périodique qui appelle l'API de destruction.

## 3. Routage et mise à l'échelle

Ports publics, TLS et autoscaling par machine.

1. Une route relie un port public à un port interne, en HTTP (TLS optionnel) ou en TCP brut.
2. Sans route configurée, deux routes par défaut sont créées : 443 (tls + http) et 80 (http + force_https) vers le port interne.
3. En mise à l'échelle automatique, l'autostop est « stop » et le minimum de machines à 0 : la machine s'endort sans trafic.
4. En mise à l'échelle manuelle, l'autostop est « off » et une machine reste toujours démarrée.
5. Au-delà de 2 Go de mémoire ou de 2 vCPU, la machine bascule sur un processeur dédié (cpu_kind « performance »).

## 4. Accès privé au réseau Fly.io

Joindre un service sans passer par Internet.

1. Chaque service répond aussi sur <app>.internal:<port> depuis n'importe quelle machine du même réseau privé.
2. Un tunnel WireGuard (fly wireguard create, puis wg-quick up) expose ce réseau sur votre poste.
3. L'adresse publique n'est alors jamais utilisée : le trafic reste dans le réseau interne Fly.io.
4. Pour publier un service uniquement en privé, on n'alloue pas d'IPv4 et on laisse la liste de services vide.

## 5. Construire et publier une image

Le Dockerfile généré puis l'envoi au registre.

1. Choisir un runtime : Node.js 20, Python 3.12, Go 1.22 (build multi-étapes) ou site statique servi par nginx.
2. Le générateur expose le port demandé et valide qu'il est compris entre 1 et 65535 ; pour le runtime statique, il configure aussi nginx sur ce port.
3. Le modèle Node.js utilise `npm ci` si un fichier de verrouillage existe, sinon `npm install`. Le modèle Go télécharge ses dépendances depuis `go.mod` et ne requiert pas de fichier `go.sum`.
4. Copier `.dockerignore.example` vers `.dockerignore` dans le contexte de build, puis adapter les exclusions au projet.
5. Construire pour la plateforme Fly.io : docker build --platform linux/amd64 -t <registre>/<vous>/<service>:<tag> .
6. Tester en local avec docker run --rm -p <port>:<port> <image> avant tout envoi.
7. Publier : docker login <registre>, docker push <image>, puis docker pull <image> pour vérifier la disponibilité.

## Commandes

### CLI Fly.io

```bash
# 1 · créer l'application
fly apps create dockfly-mon-service-4f3a9 --org personal

# 2 · allouer une IPv4 partagée (HTTPS)
fly ips allocate-v4 --shared -a dockfly-mon-service-4f3a9

# 3 · lancer la machine exposée sur le port 443
fly machine run ghcr.io/vous/mon-service:latest \
  --app dockfly-mon-service-4f3a9 \
  --region cdg \
  --vm-memory 512 --vm-cpus 1 \
  --port 443:8080/tcp:tls+http \
  --autostop stop --min-machines 0

# 4 · suivre l'état et les journaux
fly machine list -a dockfly-mon-service-4f3a9
fly logs -a dockfly-mon-service-4f3a9

# 5 · tout détruire
fly machine destroy <machine-id> --force -a dockfly-mon-service-4f3a9
fly apps destroy dockfly-mon-service-4f3a9
```

### API HTTP

```bash
# créer l'application
curl -sS https://api.machines.dev/v1/apps \
  -H "Authorization: Bearer $FLY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app_name":"dockfly-mon-service-4f3a9","org_slug":"personal","enable_subdomains":true}'

# créer la machine
curl -sS https://api.machines.dev/v1/apps/dockfly-mon-service-4f3a9/machines \
  -H "Authorization: Bearer $FLY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"region":"cdg","config":{"image":"ghcr.io/vous/mon-service:latest","guest":{"cpu_kind":"shared","cpus":1,"memory_mb":512},"services":[{"protocol":"tcp","internal_port":8080,"autostart":true,"autostop":"stop","min_machines_running":0,"ports":[{"port":443,"handlers":["tls","http"]}]}]}}'

# attendre le démarrage
curl -sS "https://api.machines.dev/v1/apps/dockfly-mon-service-4f3a9/machines/<machine-id>/wait?state=started&timeout=20" \
  -H "Authorization: Bearer $FLY_TOKEN"

# détruire la machine
curl -sS -X DELETE "https://api.machines.dev/v1/apps/dockfly-mon-service-4f3a9/machines/<machine-id>?force=true" \
  -H "Authorization: Bearer $FLY_TOKEN"
```

### Image Docker

```bash
docker build --platform linux/amd64 -t ghcr.io/vous/mon-service:latest .
docker run --rm -p 8080:8080 ghcr.io/vous/mon-service:latest

docker login ghcr.io
docker push ghcr.io/vous/mon-service:latest
docker pull ghcr.io/vous/mon-service:latest
```

## Fichiers fournis

- container-engine.js — Moteur autonome de conteneurs Docker (déploiement, cycle de vie, proxy inverse, métriques et logs).
- fly-client.js — Créer l'application, l'IP publique, la machine, attendre le démarrage et détruire.
- deploy.sh — Le même déploiement en curl, à lancer avec un jeton Fly.io.
- ttl.js — Options de TTL, compte à rebours lisible et calcul de l'expiration.
- ttl (1).js — Alias de compatibilité qui réexporte `ttl.js`.
- dockerfile.js — Les quatre modèles Node, Python, Go et site statique.
- .dockerignore.example — Modèle d'exclusions pour éviter d'intégrer des fichiers locaux ou sensibles à l'image.
- Dockerfile.node — Un modèle à copier dans un projet Node.js qui possède son propre `package.json` et une commande `npm start`.
- Dockerfile.site — Image Node.js qui sert l’interface et son API de déploiement.
- server.js — Serveur HTTP de l’interface, console Google Cloud Web Services, proxy inverse et API de conteneurs.
- public/ — Interface d'accueil et console de gestion de conteneurs Google Cloud Run.
- package.json — Active les modules ES et fournit les scripts de démarrage et de test.
- fly-client.test.js — Tests locaux du comportement d'erreur du client.
- site.test.js — Vérifications des ressources et repères d'accessibilité de la page.
- server.test.js — Tests du serveur, de l’authentification et du verrou de déploiement.
- cloud-services.test.js — Tests du moteur autonome de conteneurs, cycle de vie et proxy inverse.

Pour déployer, fournissez un jeton Fly.io via `FLY_TOKEN`. Le `Dockerfile.node` est un modèle, pas une image exécutable de ce dépôt.

## 6. Interface de déploiement

L’interface française se trouve dans `public/`. Elle permet de déployer une image déjà publiée sur Fly.io. Elle doit être servie par `server.js` : ouvrir le fichier HTML directement ne permet pas de déployer.

Le serveur Node.js 20 exige `FLY_TOKEN` à l’exécution. `DEPLOY_ACCESS_TOKEN` est également requis si le serveur accepte des connexions réseau :

- `FLY_TOKEN` : jeton Fly.io utilisé uniquement par le serveur.
- `DEPLOY_ACCESS_TOKEN` : secret d’accès distinct, d’au moins 32 caractères, saisi dans le formulaire. Obligatoire lorsque le serveur est accessible sur le réseau.

En local, avec l’adresse par défaut `127.0.0.1`, l’interface peut fonctionner sans `DEPLOY_ACCESS_TOKEN`. Sans cette clé, le serveur refuse de démarrer sur une adresse réseau comme `0.0.0.0`. Ne placez jamais les secrets dans les fichiers du projet, l’image Docker ou le code navigateur. Pour un serveur réseau, utilisez une clé aléatoire robuste et HTTPS, et limitez les personnes qui peuvent l’utiliser.

Pour lancer localement, définissez `FLY_TOKEN` dans l’environnement puis exécutez `npm start`. Le serveur écoute par défaut sur `127.0.0.1:8080`; `/api/health` vérifie le serveur et `/api/deploy` réalise le déploiement. L’image doit exister dans un registre accessible à Fly.io.

Pour la servir dans un conteneur :

```bash
docker build -f Dockerfile.site -t michel-reaper-site:latest .
docker run --rm -p 8080:8080 \
  -e FLY_TOKEN \
  -e DEPLOY_ACCESS_TOKEN \
  michel-reaper-site:latest
```

Fournissez les variables au conteneur depuis un gestionnaire de secrets ou un environnement sécurisé. Le port 8080 ne fournit pas TLS par lui-même; configurez HTTPS au niveau du proxy ou de la plateforme d’hébergement.
