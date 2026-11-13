import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { Duplex } from "node:stream";
import { createDeploymentServer } from "./server.js";
import { containerEngine } from "./container-engine.js";

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

function requestServer(server, path, options = {}) {
  return new Promise((resolve, reject) => {
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
        hostname: "127.0.0.1",
        port: 8080,
        path,
        method: options.method || "GET",
        headers: options.headers || {},
        createConnection,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => buffer.toString("utf8"),
            json: () => JSON.parse(buffer.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("autonomous container engine deploys, manages, and routes web services", async () => {
  const service = await containerEngine.deployService({
    appName: "demo-nginx-api",
    image: "nginx:alpine",
    region: "europe-west1",
    internalPort: 80,
    memoryMb: 256,
    cpus: 1,
    env: { APP_ENV: "production" },
  });

  assert.equal(service.name, "demo-nginx-api");
  assert.equal(service.status, "RUNNING");
  assert.ok(service.hostPort > 9000);

  const metrics = containerEngine.getMetrics("demo-nginx-api");
  assert.equal(metrics.service, "demo-nginx-api");
  assert.equal(metrics.status, "RUNNING");
  assert.ok(metrics.memoryMb > 0);

  const logs = containerEngine.getLogs("demo-nginx-api");
  assert.ok(logs.length >= 3);
  assert.ok(logs[0].message.includes("Google Cloud Run"));

  const exec = await containerEngine.execCommand("demo-nginx-api", "uname -a");
  assert.equal(exec.exitCode, 0);
  assert.match(exec.output, /Linux/);

  // Stop & Restart
  await containerEngine.stopService("demo-nginx-api");
  assert.equal(containerEngine.getService("demo-nginx-api").status, "STOPPED");

  await containerEngine.startService("demo-nginx-api");
  assert.equal(containerEngine.getService("demo-nginx-api").status, "RUNNING");

  // Cleanup
  await containerEngine.deleteService("demo-nginx-api");
  assert.equal(containerEngine.getService("demo-nginx-api"), null);
});

test("server provides complete Google Cloud Web Services REST API and autonomous deployment", async () => {
  // Création du serveur autonome sans aucun token
  const server = createDeploymentServer();

  // 1. System API
  const sys = await requestServer(server, "/api/system");
  assert.equal(sys.status, 200);
  const sysData = sys.json();
  assert.ok(sysData.os);
  assert.ok(sysData.nodeVersion);

  // 2. Health check
  const health = await requestServer(server, "/api/health");
  assert.equal(health.status, 200);
  const healthData = health.json();
  assert.equal(healthData.ok, true);
  assert.equal(healthData.platform, "google-cloud-web-services");

  // 3. Services list initially empty
  const initial = await requestServer(server, "/api/services");
  assert.equal(initial.status, 200);
  assert.ok(Array.isArray(initial.json()));

  // 4. Autonomous deployment via /api/deploy
  const deployRes = await requestServer(server, "/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName: "mon-cloud-service",
      image: "node:20-alpine",
      region: "europe-west1",
      internalPort: 8080,
      memoryMb: 512,
      cpus: 1,
    }),
  });
  assert.equal(deployRes.status, 201);
  const deployed = deployRes.json();
  assert.equal(deployed.appName, "mon-cloud-service");
  assert.ok(deployed.machineId.startsWith("srv-"));
  assert.equal(deployed.localUrl, "/services/mon-cloud-service/");

  // 5. Verification in /api/services
  const afterDeploy = await requestServer(server, "/api/services");
  const servicesList = afterDeploy.json();
  const found = servicesList.find((s) => s.name === "mon-cloud-service");
  assert.ok(found);
  assert.equal(found.status, "RUNNING");

  // 6. Logs disponibles
  const logsRes = await requestServer(server, "/api/services/mon-cloud-service/logs");
  assert.equal(logsRes.status, 200);
  assert.ok(Array.isArray(logsRes.json()));

  // 7. Métriques disponibles
  const metricsRes = await requestServer(server, "/api/services/mon-cloud-service/metrics");
  assert.equal(metricsRes.status, 200);
  const metricsData = metricsRes.json();
  assert.equal(metricsData.service, "mon-cloud-service");
  assert.ok(metricsData.memoryMb > 0);

  // 8. Stop du service
  const stopRes = await requestServer(server, "/api/services/mon-cloud-service/stop", {
    method: "POST",
  });
  assert.equal(stopRes.status, 200);
  assert.equal(stopRes.json().status, "STOPPED");

  // 9. Restart du service
  const restartRes = await requestServer(server, "/api/services/mon-cloud-service/restart", {
    method: "POST",
  });
  assert.equal(restartRes.status, 200);
  assert.equal(restartRes.json().status, "RUNNING");

  // 10. Suppression du service
  const deleteRes = await requestServer(server, "/api/services/mon-cloud-service", {
    method: "DELETE",
  });
  assert.equal(deleteRes.status, 200);

  // 11. Service introuvable après suppression
  const notFound = await requestServer(server, "/api/services/mon-cloud-service");
  assert.equal(notFound.status, 404);
});

test("engine and server support Xray VLESS/VMess WebSocket VPN configuration", async () => {
  const service = await containerEngine.deployService({
    appName: "vpn-node-xray",
    image: "teddysun/xray:latest",
    internalPort: 8080,
    isXray: true,
  });

  assert.equal(service.name, "vpn-node-xray");
  assert.equal(service.xray.enabled, true);
  assert.equal(service.xray.protocol, "vless");
  assert.ok(service.xray.uuid.length === 36);
  assert.equal(service.xray.wsPath, "/services/vpn-node-xray/ws");

  // Nettoyage
  await containerEngine.deleteService("vpn-node-xray");
});
