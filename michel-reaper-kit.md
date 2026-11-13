# Michel.Reaper — kit développeur

Ce projet fournit une interface web et des outils d'intégration et de déploiement sur Fly.io. Il ne contient pas l'application web métier à déployer. Le déploiement interactif est décrit à la section 6.

Les extraits de code en fin de document sont des copies informatives ; les fichiers exécutables à la racine restent la source de vérité.

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

- fly-client.js — Créer l'application, l'IP publique, la machine, attendre le démarrage et détruire.
- deploy.sh — Le même déploiement en curl, à lancer avec un jeton Fly.io.
- ttl.js — Options de TTL, compte à rebours lisible et calcul de l'expiration.
- ttl (1).js — Alias de compatibilité qui réexporte `ttl.js`.
- dockerfile.js — Les quatre modèles Node, Python, Go et site statique.
- .dockerignore.example — Modèle d'exclusions pour éviter d'intégrer des fichiers locaux ou sensibles à l'image.
- Dockerfile.node — Un modèle à copier dans un projet Node.js qui possède son propre `package.json` et une commande `npm start`.
- Dockerfile.site — Image Node.js qui sert l’interface et son API de déploiement.
- server.js — Serveur HTTP de l’interface, authentification administrateur et intégration Fly.io.
- public/ — Interface d'accueil et guide de déploiement.
- package.json — Active les modules ES et fournit les scripts de démarrage et de test.
- fly-client.test.js — Tests locaux du comportement d'erreur du client.
- site.test.js — Vérifications des ressources et repères d'accessibilité de la page.
- server.test.js — Tests du serveur, de l’authentification et du verrou de déploiement.

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


## Fichier · fly-client.js

`	ext
// Client Fly.io minimal (Machines API + GraphQL) — aucune dépendance.
// fetch est natif : copiez ce fichier dans un projet Node 20 ou dans une fonction serverless.

const MACHINES_API = "https://api.machines.dev/v1";
const GRAPHQL_API = "https://api.fly.io/graphql";

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(label + " doit être un entier positif");
  }
  return number;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value) {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function throwGraphqlErrors(data) {
  if (data && Array.isArray(data.errors) && data.errors.length) {
    const messages = data.errors.map((error) =>
      error && typeof error.message === "string" && error.message ? error.message : "Erreur GraphQL inconnue",
    );
    throw new Error("Fly.io GraphQL : " + messages.join("; "));
  }
}

export function buildServices({ internalPort, routes = [], autoscale = true, proxyProtocol = false, forceHttps = true }) {
  const defaults = [
    { public_port: 443, internal_port: internalPort, protocol: "http", tls: true },
    { public_port: 80, internal_port: internalPort, protocol: "http", tls: false },
  ];
  if (!Array.isArray(routes)) throw new TypeError("Les routes doivent être un tableau");
  const source = routes.length ? routes : defaults;

  return source.map((route) => {
    if (!isObject(route)) throw new TypeError("Chaque route doit être un objet");
    const port = Number(route.public_port);
    const internalPort = Number(route.internal_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError("Le port public doit être un entier entre 1 et 65535");
    }
    if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) {
      throw new RangeError("Le port interne doit être un entier entre 1 et 65535");
    }
    if (route.protocol !== undefined && route.protocol !== "http" && route.protocol !== "tcp") {
      throw new TypeError("Le protocole de route doit être « http » ou « tcp »");
    }
    const raw = route.protocol === "tcp";
    const tls = !raw && route.tls !== false;
    const handler = { port, handlers: raw ? [] : tls ? ["tls", "http"] : ["http"] };
    if (port === 80 && !raw && forceHttps) handler.force_https = true;

    return {
      protocol: "tcp",
      internal_port: internalPort,
      ...(proxyProtocol ? { proxy_protocol: true } : {}),
      autostart: true,
      autostop: autoscale ? "stop" : "off",
      min_machines_running: autoscale ? 0 : 1,
      ports: [handler],
    };
  });
}

export function machineConfig({ image, internalPort, memoryMb = 512, cpus = 1, env = {}, metadata = {}, autoscale = true, routes = [], forceHttps = true }) {
  if (typeof image !== "string" || !image.trim() || image.trim() !== image || /\s/.test(image)) {
    throw new TypeError("L'image Docker doit être une référence non vide sans espaces");
  }
  const normalizedCpus = positiveInteger(cpus, "Le nombre de CPU");
  const normalizedMemory = positiveInteger(memoryMb, "La mémoire");
  if (!isStringRecord(env)) throw new TypeError("Les variables d'environnement doivent être un objet de chaînes");
  if (!isStringRecord(metadata)) throw new TypeError("Les métadonnées doivent être un objet de chaînes");

  return {
    image,
    env,
    metadata,
    auto_destroy: false,
    restart: { policy: "always" },
    // fly-init : nécessaire pour exécuter des commandes dans la machine.
    init: {},
    guest: {
      // Au-delà de 2 Go ou de 2 vCPU, Fly.io impose un processeur dédié.
      cpu_kind: normalizedCpus > 2 || normalizedMemory > 2048 ? "performance" : "shared",
      cpus: normalizedCpus,
      memory_mb: normalizedMemory,
    },
    services: buildServices({ internalPort, routes, autoscale, forceHttps }),
  };
}

export function createFlyClient(token) {
  if (!token) throw new Error("Jeton Fly.io manquant");

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (parseError) {
        if (response.ok) {
          throw new Error("Réponse Fly.io invalide (JSON attendu)", { cause: parseError });
        }
        data = { message: text };
      }
    }
    if (!response.ok) {
      const error = new Error((data && (data.error || data.message)) || "Fly.io " + response.status);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const machines = (path, options) => request(MACHINES_API + path, options);

  return {
    orgSlug: async () => {
      const data = await request(GRAPHQL_API, {
        method: "POST",
        body: JSON.stringify({ query: "query { organizations { nodes { slug type } } }" }),
      });
      throwGraphqlErrors(data);
      const nodes = data && data.organizations && data.organizations.nodes;
      const organizations = Array.isArray(nodes) ? nodes.filter((node) => isObject(node)) : [];
      const personal = organizations.find((node) => node.type === "PERSONAL");
      const organization = personal || organizations[0];
      if (!organization || typeof organization.slug !== "string" || !organization.slug) {
        throw new Error("Aucune organisation Fly.io disponible pour ce jeton");
      }
      return organization.slug;
    },
    getApp: (appName) =>
      machines("/apps/" + encodeURIComponent(appName)).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      }),
    createApp: (appName, orgSlug) =>
      machines("/apps", {
        method: "POST",
        body: JSON.stringify({ app_name: appName, org_slug: orgSlug, enable_subdomains: true }),
      }),
    allocateSharedIpv4: async (appName) => {
      const data = await request(GRAPHQL_API, {
        method: "POST",
        body: JSON.stringify({
          query: "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }",
          variables: { input: { appId: appName, type: "shared_v4" } },
        }),
      });
      throwGraphqlErrors(data);
      const address = data && data.allocateIpAddress && data.allocateIpAddress.ipAddress;
      if (!address || typeof address.address !== "string" || !address.address) {
        throw new Error("Fly.io n'a pas retourné d'adresse IPv4 partagée");
      }
      return address;
    },
    createMachine: ({ appName, region, ...config }) =>
      machines("/apps/" + encodeURIComponent(appName) + "/machines", {
        method: "POST",
        body: JSON.stringify({ region, config: machineConfig(config) }),
      }),
    waitForMachine: (appName, machineId, seconds = 20) =>
      machines(
        "/apps/" + encodeURIComponent(appName) + "/machines/" + encodeURIComponent(machineId) + "/wait?state=started&timeout=" + seconds,
      ),
    destroyMachine: (appName, machineId) =>
      machines("/apps/" + encodeURIComponent(appName) + "/machines/" + encodeURIComponent(machineId) + "?force=true", {
        method: "DELETE",
      }),
    destroyApp: (appName) => machines("/apps/" + encodeURIComponent(appName), { method: "DELETE" }),
    exec: async (appName, machineId, command, timeout = 10) => {
      const data = await machines(
        "/apps/" + encodeURIComponent(appName) + "/machines/" + encodeURIComponent(machineId) + "/exec",
        { method: "POST", body: JSON.stringify({ cmd: ["/bin/sh", "-lc", command], timeout }) },
      );
      return { exitCode: data.exit_code, stdout: data.stdout, stderr: data.stderr };
    },
  };
}

// Exemple complet : application, IP publique, machine, attente du démarrage.
export async function deployImage({
  token,
  appName,
  image,
  region = "cdg",
  internalPort = 8080,
  memoryMb = 512,
  cpus = 1,
  env = {},
}) {
  if (typeof appName !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appName)) {
    throw new TypeError("Le nom d'application Fly.io est invalide");
  }
  if (typeof region !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(region)) {
    throw new TypeError("La région Fly.io est invalide");
  }
  const config = { image, internalPort, memoryMb, cpus, env };
  machineConfig(config);
  const fly = createFlyClient(token);
  const existing = await fly.getApp(appName);
  const createdApp = !existing;
  if (createdApp) await fly.createApp(appName, await fly.orgSlug());

  let machineId;
  try {
    await fly.allocateSharedIpv4(appName);
    const machine = await fly.createMachine({ appName, region, ...config });
    if (!machine || typeof machine.id !== "string" || !machine.id.trim()) {
      throw new Error("Fly.io n'a pas retourné l'identifiant de la machine créée");
    }
    machineId = machine.id;
    await fly.waitForMachine(appName, machineId, 20);
    return { appName, machineId, url: "https://" + appName + ".fly.dev" };
  } catch (error) {
    const cleanupErrors = [];
    if (machineId) {
      try {
        await fly.destroyMachine(appName, machineId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (createdApp) {
      try {
        await fly.destroyApp(appName);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Le déploiement a échoué et les ressources créées n'ont pas toutes pu être supprimées",
      );
    }
    throw error;
  }
}
`

## Fichier · deploy.sh

`	ext
#!/usr/bin/env bash
# Déploiement minimal d'une image Docker sur Fly.io (Machines API).
set -euo pipefail

for command_name in curl node; do
  if ! command -v "$command_name" > /dev/null 2>&1; then
    echo "✗ commande requise introuvable : $command_name" >&2
    exit 1
  fi
done

FLY_TOKEN="${FLY_TOKEN:?Définissez FLY_TOKEN dans votre environnement}"
APP="${APP:-dockfly-mon-service-4f3a9}"
IMAGE="${IMAGE:-ghcr.io/vous/mon-service:latest}"
REGION="${REGION:-cdg}"
PORT="${PORT:-8080}"
MEMORY="${MEMORY:-512}"
CPUS="${CPUS:-1}"

API="https://api.machines.dev/v1"
GRAPHQL="https://api.fly.io/graphql"
auth=(-H "Authorization: Bearer $FLY_TOKEN" -H "Content-Type: application/json")

APP_CREATED=0
MACHINE_ID=""

cleanup() {
  local status=$?
  local cleanup_failed=0
  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if [ -n "$MACHINE_ID" ]; then
    echo "→ suppression de la machine créée $MACHINE_ID" >&2
    if ! curl -fsS -X DELETE "$API/apps/$APP/machines/$MACHINE_ID?force=true" "${auth[@]}" > /dev/null; then
      echo "✗ impossible de supprimer la machine $MACHINE_ID" >&2
      cleanup_failed=1
    fi
  fi

  if [ "$APP_CREATED" -eq 1 ]; then
    echo "→ suppression de l'application créée $APP" >&2
    if ! curl -fsS -X DELETE "$API/apps/$APP" "${auth[@]}" > /dev/null; then
      echo "✗ impossible de supprimer l'application $APP" >&2
      cleanup_failed=1
    fi
  fi

  if [ "$cleanup_failed" -eq 1 ]; then
    echo "✗ le nettoyage des ressources a échoué" >&2
  fi
  return "$status"
}
trap cleanup EXIT

machine_payload=$(node -e '
const [app, image, region, portValue, memoryValue, cpuValue] = process.argv.slice(1);
function fail(message) {
  console.error("✗ " + message);
  process.exit(1);
}
function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value)) fail(label + " doit être un entier positif");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(label + " dépasse la limite autorisée");
  return number;
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) fail("nom d’application invalide");
if (!region || !/^[a-z0-9][a-z0-9-]*$/.test(region)) fail("région invalide");
if (!image || image.trim() !== image || /\s/.test(image)) fail("référence d’image vide ou invalide");
const port = positiveInteger(portValue, "PORT");
if (port > 65535) fail("PORT doit être inférieur ou égal à 65535");
const memory = positiveInteger(memoryValue, "MEMORY");
const cpus = positiveInteger(cpuValue, "CPUS");
const cpuKind = cpus > 2 || memory > 2048 ? "performance" : "shared";
process.stdout.write(JSON.stringify({
  region,
  config: {
    image,
    auto_destroy: false,
    restart: { policy: "always" },
    init: {},
    guest: { cpu_kind: cpuKind, cpus, memory_mb: memory },
    services: [{
      protocol: "tcp",
      internal_port: port,
      autostart: true,
      autostop: "stop",
      min_machines_running: 0,
      ports: [
        { port: 443, handlers: ["tls", "http"] },
        { port: 80, handlers: ["http"], force_https: true }
      ]
    }]
  }
}));
' "$APP" "$IMAGE" "$REGION" "$PORT" "$MEMORY" "$CPUS")

echo "→ vérification de l'application $APP"
app_status=$(curl -sS -o /dev/null -w '%{http_code}' "$API/apps/$APP" "${auth[@]}")
if [ "$app_status" = "404" ]; then
  organizations=$(curl -fsS "$GRAPHQL" "${auth[@]}" \
    -d '{"query":"query { organizations { nodes { slug type } } }"}')
  org=$(node -e '
const data = JSON.parse(process.argv[1]);
if (Array.isArray(data.errors) && data.errors.length) {
  console.error("✗ Fly.io GraphQL : " + data.errors.map((error) => error?.message || "erreur inconnue").join("; "));
  process.exit(1);
}
const nodes = data.organizations?.nodes;
const organization = Array.isArray(nodes)
  ? nodes.find((node) => node && node.type === "PERSONAL") || nodes[0]
  : null;
if (!organization || typeof organization.slug !== "string" || !organization.slug) {
  console.error("✗ aucune organisation Fly.io trouvée pour ce jeton");
  process.exit(1);
}
process.stdout.write(organization.slug);
' "$organizations")
  app_payload=$(node -e '
process.stdout.write(JSON.stringify({
  app_name: process.argv[1],
  org_slug: process.argv[2],
  enable_subdomains: true
}));
' "$APP" "$org")
  curl -fsS "$API/apps" "${auth[@]}" -d "$app_payload" > /dev/null
  APP_CREATED=1
  echo "✓ application créée"
elif [ "$app_status" = "200" ]; then
  echo "✓ application réutilisée"
else
  echo "✗ vérification de l'application refusée (HTTP $app_status)" >&2
  exit 1
fi

echo "→ allocation de l'IPv4 partagée"
allocation_payload=$(node -e '
process.stdout.write(JSON.stringify({
  query: "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address } } }",
  variables: { input: { appId: process.argv[1], type: "shared_v4" } }
}));
' "$APP")
allocation=$(curl -fsS "$GRAPHQL" "${auth[@]}" -d "$allocation_payload")
node -e '
const data = JSON.parse(process.argv[1]);
if (Array.isArray(data.errors) && data.errors.length) {
  console.error("✗ Fly.io GraphQL : " + data.errors.map((error) => error?.message || "erreur inconnue").join("; "));
  process.exit(1);
}
if (!data.allocateIpAddress?.ipAddress?.address) {
  console.error("✗ Fly.io n’a pas retourné d’adresse IPv4 partagée");
  process.exit(1);
}
' "$allocation"

echo "→ création de la machine $IMAGE"
machine_response=$(curl -fsS "$API/apps/$APP/machines" "${auth[@]}" -d "$machine_payload")
MACHINE_ID=$(node -e '
const data = JSON.parse(process.argv[1]);
if (typeof data.id !== "string" || !/^[A-Za-z0-9-]+$/.test(data.id)) {
  console.error("✗ Fly.io n’a pas retourné d’identifiant de machine valide");
  process.exit(1);
}
process.stdout.write(data.id);
' "$machine_response")
echo "✓ machine $MACHINE_ID"

echo "→ attente du démarrage"
curl -fsS "$API/apps/$APP/machines/$MACHINE_ID/wait?state=started&timeout=20" "${auth[@]}" > /dev/null
MACHINE_ID=""
APP_CREATED=0
echo "● https://$APP.fly.dev"
`

## Fichier · ttl.js

`	ext
// Durée de vie des machines : conversion, compte à rebours et expiration.

export const TTL_OPTIONS = [
  { value: 0, label: "Illimitée" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 heure" },
  { value: 180, label: "3 heures" },
  { value: 360, label: "6 heures" },
  { value: 720, label: "12 heures" },
  { value: 1440, label: "24 heures" },
  { value: 10080, label: "7 jours" },
];

function nonNegativeMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("La durée doit être un nombre entier positif ou nul");
  }
  return value;
}

export function ttlLabel(minutes) {
  if (minutes === null || minutes === undefined || minutes === "") return "Illimitée";
  const value = nonNegativeMinutes(minutes);
  if (!value) return "Illimitée";
  const option = TTL_OPTIONS.find((item) => item.value === value);
  if (option) return option.label;
  if (value % 1440 === 0) return value / 1440 + " j";
  if (value % 60 === 0) return value / 60 + " h";
  return value + " min";
}

// « 2 j 3 h », « 3 h 12 min », « 4 min 20 s ».
export function formatRemaining(ms) {
  if (ms === null || ms === undefined) return null;
  const remaining = Number(ms);
  if (!Number.isFinite(remaining)) throw new RangeError("La durée restante doit être un nombre fini");
  if (remaining <= 0) return "expirée";
  const total = Math.floor(remaining / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return days + " j " + hours + " h";
  if (hours) return hours + " h " + String(minutes).padStart(2, "0") + " min";
  if (minutes) return minutes + " min " + String(seconds).padStart(2, "0") + " s";
  return seconds + " s";
}

// Date d'expiration d'une machine au moment du déploiement (null si illimitée).
export function expiresAtFrom(ttlMinutes) {
  if (ttlMinutes === null || ttlMinutes === undefined || ttlMinutes === "") return null;
  const minutes = nonNegativeMinutes(ttlMinutes);
  if (!minutes) return null;
  const timestamp = Date.now() + minutes * 60000;
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) {
    throw new RangeError("La durée dépasse la plage de dates prise en charge");
  }
  return new Date(timestamp).toISOString();
}

export function isExpired(expiresAt) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return false;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) throw new RangeError("La date d'expiration est invalide");
  return timestamp <= Date.now();
}
`

## Fichier · dockerfile.js

`	ext
// Générateur de Dockerfile par runtime — même logique que la page « Créer une image Docker ».

export function buildDockerfile({ runtime = "node", port, command }) {
  const exposed = port === undefined || port === null || port === "" ? 8080 : Number(port);
  if (!Number.isInteger(exposed) || exposed < 1 || exposed > 65535) {
    throw new RangeError("Le port doit être un entier entre 1 et 65535");
  }
  const start = (command || "").trim();

  if (runtime === "python") {
    return [
      "# syntax=docker/dockerfile:1",
      "FROM python:3.12-slim",
      "",
      "WORKDIR /app",
      "ENV PYTHONUNBUFFERED=1",
      "",
      "COPY requirements.txt ./",
      "RUN pip install --no-cache-dir -r requirements.txt",
      "",
      "COPY . .",
      "",
      "EXPOSE " + exposed,
      start ? 'CMD ["sh", "-c", ' + JSON.stringify(start) + "]" : 'CMD ["python", "main.py"]',
    ].join("\n");
  }

  if (runtime === "go") {
    return [
      "# syntax=docker/dockerfile:1",
      "FROM golang:1.22-alpine AS build",
      "WORKDIR /src",
      "",
      "COPY go.mod ./",
      "RUN go mod download",
      "",
      "COPY . .",
      "RUN CGO_ENABLED=0 go build -o /server .",
      "",
      "FROM alpine:3.20",
      "WORKDIR /app",
      "COPY --from=build /server /app/server",
      "",
      "EXPOSE " + exposed,
      'CMD ["/app/server"]',
    ].join("\n");
  }

  if (runtime === "static") {
    return [
      "# syntax=docker/dockerfile:1",
      "FROM nginx:1.27-alpine",
      "",
      "COPY . /usr/share/nginx/html",
      "RUN sed -i 's/listen 80;/listen " + exposed + ";/; s/listen \\[::\\]:80;/listen [::]:" + exposed + ";/' /etc/nginx/conf.d/default.conf",
      "",
      "EXPOSE " + exposed,
      'CMD ["nginx", "-g", "daemon off;"]',
    ].join("\n");
  }

  if (runtime !== "node") {
    throw new TypeError("Le runtime doit être « node », « python », « go » ou « static »");
  }

  return [
    "# syntax=docker/dockerfile:1",
    "FROM node:20-alpine",
    "",
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "",
    "COPY package*.json ./",
    "RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi",
    "",
    "COPY . .",
    "",
    "EXPOSE " + exposed,
    start ? 'CMD ["sh", "-c", ' + JSON.stringify(start) + "]" : 'CMD ["npm", "start"]',
  ].join("\n");
}
`

## Fichier · Dockerfile.node

`	ext
# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

EXPOSE 8080
CMD ["npm", "start"]
`
