import assert from "node:assert/strict";
import http from "node:http";
import { Duplex } from "node:stream";
import { createDeploymentServer, startServer, validateDeploymentInput } from "./server.js";
import { test } from "node:test";

const DEPLOYMENT = {
  appName: "web-service",
  image: "ghcr.io/team/web:latest",
  region: "europe-west9",
  internalPort: 8080,
  memoryMb: 512,
  cpus: 1,
};

const activeServers = new Map();

class InMemSocket extends Duplex {
  constructor(peer) {
    super();
    this.peer = peer;
    this.remoteAddress = "127.0.0.1";
  }
  _write(chunk, encoding, callback) {
    this.peer.push(chunk);
    callback();
  }
  _read() {}
}

function inMemoryFetch(server, urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const createConnection = (opt, cb) => {
      const client = new InMemSocket();
      const srv = new InMemSocket(client);
      client.peer = srv;
      server.emit("connection", srv);
      cb(null, client);
      return client;
    };

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: options.headers || {},
        createConnection,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(key, item);
            } else if (value !== undefined) {
              headers.set(key, value);
            }
          }
          resolve(
            new Response(buffer, {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function testFetch(url, options) {
  try {
    return await originalFetch(url, options);
  } catch (error) {
    if (error?.cause?.code === "EACCES") {
      const origin = new URL(url).origin;
      const server = activeServers.get(origin);
      if (server) return inMemoryFetch(server, url, options);
    }
    throw error;
  }
};

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  activeServers.set(origin, server);
  t.after(() => {
    activeServers.delete(origin);
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return origin;
}

async function postDeployment(origin, body = DEPLOYMENT) {
  return fetch(origin + "/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

test("deployment server validates deployment input parameters", () => {
  // Nom invalide
  assert.throws(
    () => validateDeploymentInput({ appName: "My_Service!", image: "nginx" }),
    /nom du service/,
  );
  // Image manquante
  assert.throws(
    () => validateDeploymentInput({ appName: "my-service" }),
    /image de conteneur/,
  );
  // Port invalide
  assert.throws(
    () => validateDeploymentInput({ appName: "my-service", image: "nginx", internalPort: 70000 }),
    /port interne/,
  );
  // Mémoire insuffisante
  assert.throws(
    () => validateDeploymentInput({ appName: "my-service", image: "nginx", memoryMb: 10 }),
    /mémoire/i,
  );
});

test("deployment server serves the console and health endpoint without credentials", async (t) => {
  const server = createDeploymentServer();
  const origin = await listen(t, server);

  // La page principale est accessible sans authentification
  const page = await fetch(origin + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);

  // Health check renvoie platform Google Cloud
  const health = await fetch(origin + "/api/health");
  assert.equal(health.status, 200);
  const healthData = await health.json();
  assert.equal(healthData.ok, true);
  assert.equal(healthData.platform, "google-cloud-web-services");
  assert.ok(typeof healthData.servicesCount === "number");
});

test("deployment endpoint deploys and returns Cloud Run style response", async (t) => {
  let receivedDeployment;
  const server = createDeploymentServer({
    deploy: async (deployment) => {
      receivedDeployment = deployment;
      return {
        appName: deployment.appName,
        machineId: "srv-machine-123",
        url: "/services/web-service/",
        localUrl: "/services/web-service/",
        revision: "web-service-00001-abc",
        status: "RUNNING",
      };
    },
  });
  const origin = await listen(t, server);

  const response = await postDeployment(origin);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.appName, "web-service");
  assert.equal(result.machineId, "srv-machine-123");
  // Le token Fly.io ne doit PAS être exposé dans la réponse
  assert.ok(!result.token);
  // Les paramètres du déploiement sont bien transmis à la fonction deploy
  assert.equal(receivedDeployment.appName, "web-service");
  assert.equal(receivedDeployment.image, "ghcr.io/team/web:latest");
});

test("deployment endpoint rejects invalid payloads with 400", async (t) => {
  const server = createDeploymentServer({
    deploy: async () => ({ appName: "x", machineId: "y", url: "/" }),
  });
  const origin = await listen(t, server);

  const invalid = await postDeployment(origin, { ...DEPLOYMENT, internalPort: 70000 });
  assert.equal(invalid.status, 400);

  const noImage = await postDeployment(origin, { appName: "valid-name" });
  assert.equal(noImage.status, 400);
});

test("deployment endpoint rejects simultaneous deployments with 409", async (t) => {
  let beginDeployment;
  let finishDeployment;
  const begun = new Promise((resolve) => {
    beginDeployment = resolve;
  });
  const pending = new Promise((resolve) => {
    finishDeployment = resolve;
  });
  const server = createDeploymentServer({
    deploy: async () => {
      beginDeployment();
      return pending;
    },
  });
  const origin = await listen(t, server);

  const first = postDeployment(origin);
  await begun;
  const second = await postDeployment(origin);
  assert.equal(second.status, 409);

  finishDeployment({
    appName: "web-service",
    machineId: "machine-123",
    url: "/services/web-service/",
  });
  assert.equal((await first).status, 201);
});

test("startServer starts without any environment variables", () => {
  // startServer() ne doit pas lever d'exception sans FLY_TOKEN ni DEPLOY_ACCESS_TOKEN
  const server = startServer({ PORT: "0" });
  server.close();
});
