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
