import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containerEngine } from "./container-engine.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(ROOT, "public");
const MAX_BODY_BYTES = 64 * 1024;
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);
const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/site.css", "site.css"],
  ["/site.js", "site.js"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  );
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Le corps de la requête doit être au format JSON.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "La requête dépasse la taille maximale autorisée.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Le corps de la requête JSON est invalide.");
  }
}

export function validateDeploymentInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Les paramètres de configuration sont invalides.");
  }

  const appName = body.appName || body.serviceName;
  const { image, region = "europe-west9", internalPort = 8080, memoryMb = 512, cpus = 1, minInstances = 0, maxInstances = 10, concurrency = 80, timeoutSeconds = 300, ingress = "all", env = {} } = body;

  if (typeof appName !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appName)) {
    throw new HttpError(400, "Le nom du service web Google Cloud doit être en minuscules (1-63 caractères, lettres, chiffres ou tirets).");
  }
  if (typeof image !== "string" || !image.trim() || /\s/.test(image)) {
    throw new HttpError(400, "La référence de l'image de conteneur est requise.");
  }
  if (typeof region !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(region)) {
    throw new HttpError(400, "La région Google Cloud est invalide.");
  }
  const port = Number(internalPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "Le port interne du conteneur doit être compris entre 1 et 65535.");
  }
  const mem = Number(memoryMb);
  if (!Number.isSafeInteger(mem) || mem < 64) {
    throw new HttpError(400, "La mémoire doit être d'au moins 64 Mo.");
  }
  const cpu = Number(cpus);
  if (Number.isNaN(cpu) || cpu <= 0) {
    throw new HttpError(400, "Le nombre de vCPU doit être supérieur à 0.");
  }

  return {
    appName,
    serviceName: appName,
    image: image.trim(),
    region,
    internalPort: port,
    memoryMb: mem,
    cpus: cpu,
    minInstances: Math.max(0, Number(minInstances) || 0),
    maxInstances: Math.max(1, Number(maxInstances) || 10),
    concurrency: Math.max(1, Number(concurrency) || 80),
    timeoutSeconds: Math.max(1, Number(timeoutSeconds) || 300),
    ingress: ingress === "internal" ? "internal" : "all",
    env: typeof env === "object" && env !== null ? env : {},
  };
}

export function createDeploymentServer({
  engine = containerEngine,
  deploy,
} = {}) {
  let deploymentInProgress = false;

  async function handleRequest(request, response) {
    setSecurityHeaders(response);
    const url = new URL(request.url || "/", "http://localhost");

    // Endpoint de vérification de l'état du serveur
    if (url.pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        sendJson(response, 405, { error: "Méthode non autorisée." });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        platform: "google-cloud-web-services",
        servicesCount: engine.listServices().length,
      });
      return;
    }

    // Informations système hôte
    if (url.pathname === "/api/system") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Méthode non autorisée." });
        return;
      }
      sendJson(response, 200, {
        ...engine.systemInfo,
        uptime: Math.round(process.uptime()),
        memoryUsage: process.memoryUsage(),
        servicesRunning: engine.listServices().filter((s) => s.status === "RUNNING").length,
      });
      return;
    }

    // Gestion de la liste des services : GET et POST
    if (url.pathname === "/api/services") {
      if (request.method === "GET") {
        sendJson(response, 200, engine.listServices());
        return;
      }
      if (request.method === "POST") {
        const input = validateDeploymentInput(await readJsonBody(request));
        const service = await engine.deployService(input);
        sendJson(response, 201, service.toJSON());
        return;
      }
      response.setHeader("Allow", "GET, POST");
      sendJson(response, 405, { error: "Méthode non autorisée." });
      return;
    }

    // Actions granulaires sur un service
    const serviceMatch = url.pathname.match(/^\/api\/services\/([a-z0-9][a-z0-9-]{0,62})(?:\/(start|stop|restart|logs|metrics|exec))?$/);
    if (serviceMatch) {
      const [, serviceName, action] = serviceMatch;
      const service = engine.getService(serviceName);

      if (!action) {
        if (request.method === "GET") {
          if (!service) {
            sendJson(response, 404, { error: `Service "${serviceName}" introuvable.` });
            return;
          }
          sendJson(response, 200, service.toJSON());
          return;
        }
        if (request.method === "DELETE") {
          if (!service) {
            sendJson(response, 404, { error: `Service "${serviceName}" introuvable.` });
            return;
          }
          const result = await engine.deleteService(serviceName);
          sendJson(response, 200, result);
          return;
        }
        response.setHeader("Allow", "GET, DELETE");
        sendJson(response, 405, { error: "Méthode non autorisée." });
        return;
      }

      if (action === "logs") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendJson(response, 405, { error: "Méthode non autorisée." });
          return;
        }
        if (!service) {
          sendJson(response, 404, { error: `Service "${serviceName}" introuvable.` });
          return;
        }
        sendJson(response, 200, engine.getLogs(serviceName));
        return;
      }

      if (action === "metrics") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          sendJson(response, 405, { error: "Méthode non autorisée." });
          return;
        }
        if (!service) {
          sendJson(response, 404, { error: `Service "${serviceName}" introuvable.` });
          return;
        }
        sendJson(response, 200, engine.getMetrics(serviceName));
        return;
      }

      if (action === "start" || action === "stop" || action === "restart") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "Méthode non autorisée." });
          return;
        }
        if (!service) {
          sendJson(response, 404, { error: `Service "${serviceName}" introuvable.` });
          return;
        }
        const updated = action === "start"
          ? await engine.startService(serviceName)
          : action === "stop"
          ? await engine.stopService(serviceName)
          : await engine.restartService(serviceName);
        sendJson(response, 200, updated);
        return;
      }

      if (action === "exec") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "Méthode non autorisée." });
          return;
        }
        if (!service) {
          sendJson(response, 404, { error: `Service "${serviceName}" introuvable.` });
          return;
        }
        const body = await readJsonBody(request);
        const command = body?.command || "uname -a";
        const result = await engine.execCommand(serviceName, command);
        sendJson(response, 200, result);
        return;
      }
    }

    // Proxy inverse vers un conteneur web actif : /services/:name et /services/:name/*
    const proxyMatch = url.pathname.match(/^\/services\/([a-z0-9][a-z0-9-]{0,62})(\/.*)?$/);
    if (proxyMatch) {
      const [, serviceName, rawSubPath] = proxyMatch;
      const subPath = (rawSubPath || "/") + (url.search || "");
      const service = engine.getService(serviceName);

      if (!service) {
        sendJson(response, 404, { error: `Service conteneur "${serviceName}" introuvable.` });
        return;
      }

      if (service.status !== "RUNNING") {
        sendJson(response, 503, {
          error: `Le service "${serviceName}" est arrêté (0 instance active). Démarrez-le depuis la console Google Cloud.`,
        });
        return;
      }

      const proxyReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: service.hostPort,
          path: subPath,
          method: request.method,
          headers: {
            ...request.headers,
            host: `127.0.0.1:${service.hostPort}`,
            "x-forwarded-for": request.socket.remoteAddress || "127.0.0.1",
            "x-forwarded-proto": "http",
            "x-forwarded-prefix": `/services/${serviceName}`,
          },
        },
        (proxyRes) => {
          response.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(response);
        },
      );

      proxyReq.on("error", (err) => {
        if (!response.headersSent) {
          sendJson(response, 502, { error: "Échec de connexion au conteneur cible.", details: err.message });
        }
      });

      request.pipe(proxyReq);
      return;
    }

    // Endpoint de déploiement Cloud Run
    if (url.pathname === "/api/deploy") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "Méthode non autorisée." });
        return;
      }
      const input = validateDeploymentInput(await readJsonBody(request));
      if (deploymentInProgress) {
        sendJson(response, 409, { error: "Un déploiement est déjà en cours." });
        return;
      }

      deploymentInProgress = true;
      try {
        let result;
        if (typeof deploy === "function") {
          result = await deploy(input);
        } else {
          const service = await engine.deployService(input);
          result = {
            appName: service.name,
            serviceName: service.name,
            revision: service.revision,
            machineId: service.id,
            url: `/services/${service.name}/`,
            localUrl: `/services/${service.name}/`,
            directUrl: `http://127.0.0.1:${service.hostPort}`,
            status: service.status,
          };
        }
        sendJson(response, 201, result);
      } catch (error) {
        console.error("Échec du déploiement :", error.message);
        sendJson(response, 502, { error: error.message || "Le déploiement a échoué." });
      } finally {
        deploymentInProgress = false;
      }
      return;
    }

    // Distribution des fichiers statiques de l'interface
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { error: "Méthode non autorisée." });
      return;
    }

    const filename = PUBLIC_FILES.get(url.pathname);
    if (!filename) {
      sendJson(response, 404, { error: "Ressource introuvable." });
      return;
    }

    try {
      const file = await readFile(resolve(PUBLIC_DIR, filename));
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": file.length,
        "Content-Type": CONTENT_TYPES.get(extname(filename)),
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(file);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        sendJson(response, 404, { error: "Ressource introuvable." });
        return;
      }
      throw error;
    }
  }

  return createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error("Erreur serveur :", error.message);
      sendJson(response, 500, { error: "Erreur interne du serveur." });
    });
  });
}

export function startServer(environment = process.env) {
  const port = Number(environment.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("PORT doit être un entier entre 0 et 65535.");
  }

  const host = environment.HOST || "0.0.0.0";
  const server = createDeploymentServer();
  server.listen(port, host, () => {
    console.log("Console Google Cloud Web Services active sur http://" + host + ":" + port);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
