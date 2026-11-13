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
