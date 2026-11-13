import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Vérifie si le démon Docker est actif et répond sur la machine
 */
export async function checkDockerDaemon() {
  try {
    await execFileAsync("docker", ["ps"], { timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Réserve un port disponible sur 127.0.0.1
 */
function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

class ServiceInstance {
  constructor({
    appName,
    image,
    region = "europe-west9",
    internalPort = 8080,
    memoryMb = 512,
    cpus = 1,
    minInstances = 0,
    maxInstances = 10,
    concurrency = 80,
    timeoutSeconds = 300,
    ingress = "all",
    env = {},
    isXray = false,
    uuid = null,
    wsPath = null,
  }) {
    this.id = "srv-" + randomBytes(6).toString("hex");
    this.name = appName;
    this.revision = `${appName}-00001-gcp`;
    this.image = image;
    this.region = region;
    this.internalPort = Number(internalPort) || 8080;
    this.memoryMb = Number(memoryMb) || 512;
    this.cpus = Number(cpus) || 1;
    this.minInstances = Number(minInstances) || 0;
    this.maxInstances = Number(maxInstances) || 10;
    this.concurrency = Number(concurrency) || 80;
    this.timeoutSeconds = Number(timeoutSeconds) || 300;
    this.ingress = ingress;

    const isXrayService = Boolean(
      isXray ||
      (typeof image === "string" && (image.includes("xray") || image.includes("v2ray")))
    );
    const xrayUuid = (typeof uuid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid))
      ? uuid
      : randomUUID();
    const xrayWsPath = typeof wsPath === "string" && wsPath.trim()
      ? (wsPath.startsWith("/") ? wsPath.trim() : "/" + wsPath.trim())
      : `/services/${appName}/ws`;

    this.xray = {
      enabled: isXrayService,
      uuid: xrayUuid,
      wsPath: xrayWsPath,
      protocol: "vless",
      transport: "ws",
    };

    this.env = {
      ...env,
      PORT: String(this.internalPort),
      HOST: "0.0.0.0",
      ...(isXrayService ? { UUID: xrayUuid, WSPATH: xrayWsPath, PROTOCOL: "vless" } : {}),
    };
    this.hostPort = 0;
    this.status = "STARTING";
    this.createdAt = new Date().toISOString();
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.requestCount = 0;
    this.errorCount = 0;
    this.logs = [];
    this.server = null;

    // Détection Docker réel
    this.isRealDocker = false;
    this.dockerContainerName = "gcp-" + appName.replace(/[^a-z0-9_-]/gi, "-");
    this.dockerContainerId = null;

    this.addLog("INFO", `[Google Cloud Run] Initialisation du service web ${this.name} (${this.revision})`);
    this.addLog("INFO", `Région Cloud Run : ${this.region}`);
    this.addLog("INFO", `Image de conteneur : ${this.image}`);
    this.addLog("INFO", `Ressources allouées : ${this.cpus} vCPU · ${this.memoryMb} Mo RAM`);
    this.addLog("INFO", `Configuration : Concurrence ${this.concurrency} req/instance · Timeout ${this.timeoutSeconds}s · Instances ${this.minInstances}-${this.maxInstances}`);
    this.addLog("INFO", `Entrée réseau (Ingress) : ${this.ingress === "all" ? "Public (tout le trafic)" : "Interne uniquement"}`);
  }

  addLog(level, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
  }

  async start() {
    const dockerAvailable = await checkDockerDaemon();

    if (dockerAvailable) {
      try {
        await this.startRealDocker();
        return this;
      } catch (err) {
        this.addLog("WARN", `[Docker Réel] Échec du lancement conteneur réel (${err.message}) - Bascule sur l'émulateur autonome.`);
      }
    } else {
      this.addLog("INFO", `[Moteur Autonome] Docker Desktop non détecté - Mode émulateur Cloud Run actif.`);
    }

    return this.startEmulator();
  }

  async startRealDocker() {
    this.hostPort = await getAvailablePort();
    this.isRealDocker = true;

    // Nettoie tout conteneur résiduel portant le même nom
    try {
      await execFileAsync("docker", ["rm", "-f", this.dockerContainerName], { timeout: 5000 });
    } catch {
      // Ignoré s'il n'existe pas
    }

    const args = [
      "run",
      "-d",
      "--name",
      this.dockerContainerName,
      "-p",
      `127.0.0.1:${this.hostPort}:${this.internalPort}`,
    ];

    if (this.memoryMb && this.memoryMb >= 64) {
      args.push(`--memory=${this.memoryMb}m`);
    }

    if (this.cpus && this.cpus > 0) {
      args.push(`--cpus=${this.cpus}`);
    }

    for (const [k, v] of Object.entries(this.env)) {
      args.push("-e", `${k}=${v}`);
    }

    args.push(this.image);

    this.addLog("INFO", `[Docker Réel] Exécution : docker ${args.join(" ")}`);
    const { stdout } = await execFileAsync("docker", args, { timeout: 30000 });
    this.dockerContainerId = stdout.trim();

    this.status = "RUNNING";
    this.startedAt = Date.now();
    this.stoppedAt = null;

    this.addLog("INFO", `[Docker Réel] Conteneur actif avec succès (ID: ${this.dockerContainerId.slice(0, 12)})`);
    this.addLog("INFO", `[Docker Réel] Port hôte mappé : 127.0.0.1:${this.hostPort} -> ${this.internalPort}/tcp`);
    this.addLog("INFO", `Routage actif : 100% du trafic HTTP acheminé vers ${this.name}`);
  }

  startEmulator() {
    if (this.server) return Promise.resolve(this);
    this.isRealDocker = false;

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.requestCount++;
        const startTime = Date.now();
        this.addLog("INFO", `${req.method} ${req.url} - ${req.socket.remoteAddress || "127.0.0.1"}`);

        // Health check endpoint
        if (req.url === "/health" || req.url === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "healthy", service: this.name, revision: this.revision, uptime: this.getUptime() }));
          return;
        }

        // Environment endpoint
        if (req.url === "/_env") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ service: this.name, revision: this.revision, env: this.env }));
          return;
        }

        // Metrics endpoint
        if (req.url === "/_metrics") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.getMetrics()));
          return;
        }

        // Application welcome page styled as Google Cloud Run service
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Powered-By": "Google Cloud Run (Web Services)",
          "X-Cloud-Revision": this.revision,
          "X-Cloud-Service": this.name,
        });

        const isNginx = this.image.includes("nginx");
        const isPython = this.image.includes("python");
        const isNode = this.image.includes("node");
        const isHello = this.image.includes("hello-app");

        const runtimeTitle = isNginx
          ? "Nginx Web Server"
          : isPython
          ? "Python Microservice"
          : isNode
          ? "Node.js Application"
          : isHello
          ? "Google Cloud Sample Hello App"
          : "Conteneur Docker Cloud Run";

        res.end(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${this.name} — Google Cloud Run</title>
  <style>
    :root { color-scheme: dark; font-family: 'Google Sans', Roboto, -apple-system, system-ui, sans-serif; }
    body { margin: 0; background: #131418; color: #e8eaed; padding: 2rem; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
    .card { background: #1e1f24; border: 1px solid #2e3138; border-radius: 12px; padding: 2.2rem; max-width: 680px; width: 100%; box-shadow: 0 12px 36px rgba(0,0,0,0.4); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; border-bottom: 1px solid #2e3138; padding-bottom: 1.2rem; }
    .title-group { display: flex; align-items: center; gap: 12px; }
    .gcp-icon { width: 32px; height: 32px; flex-shrink: 0; }
    .title { font-size: 1.4rem; font-weight: 700; color: #fff; margin: 0; }
    .revision-tag { font-size: 0.75rem; color: #8ab4f8; font-family: monospace; display: block; margin-top: 3px; }
    .badge-status { font-size: 0.75rem; padding: 5px 12px; border-radius: 20px; font-weight: 600; text-transform: uppercase; background: rgba(52, 168, 83, 0.15); color: #81c995; border: 1px solid rgba(52, 168, 83, 0.3); display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #34a853; box-shadow: 0 0 8px #34a853; }
    .lead { font-size: 0.95rem; color: #bdc1c6; line-height: 1.5; margin: 0 0 1.5rem 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 1.5rem 0; }
    .item { background: #17181c; padding: 0.85rem 1rem; border-radius: 8px; border: 1px solid #282a30; }
    .item span { display: block; font-size: 0.72rem; color: #9aa0a6; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
    .item strong { font-size: 0.92rem; color: #fff; word-break: break-all; }
    .footer { margin-top: 1.8rem; padding-top: 1.2rem; border-top: 1px solid #2e3138; font-size: 0.8rem; color: #9aa0a6; display: flex; justify-content: space-between; align-items: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="title-group">
        <svg class="gcp-icon" viewBox="0 0 24 24" fill="none">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" fill="#4285F4"/>
        </svg>
        <div>
          <h1 class="title">${this.name}</h1>
          <span class="revision-tag">Révision : ${this.revision}</span>
        </div>
      </div>
      <span class="badge-status"><span class="dot"></span> En Ligne · 100% Trafic</span>
    </div>

    <p class="lead">Ce service web conteneurisé s'exécute activement sur votre console Google Cloud Web Service autonome, sans aucune dépendance externe ni facturation.</p>

    <div class="grid">
      <div class="item"><span>Type de runtime</span><strong>${runtimeTitle}</strong></div>
      <div class="item"><span>Image du conteneur</span><strong>${this.image}</strong></div>
      <div class="item"><span>Région Google Cloud</span><strong>${this.region}</strong></div>
      <div class="item"><span>Port interne</span><strong>${this.internalPort} (TCP)</strong></div>
      <div class="item"><span>Allocation vCPU / RAM</span><strong>${this.cpus} vCPU · ${this.memoryMb} Mo</strong></div>
      <div class="item"><span>Dimensionnement (Autoscaling)</span><strong>${this.minInstances} min · ${this.maxInstances} max instances</strong></div>
      <div class="item"><span>Concurrence max</span><strong>${this.concurrency} requêtes / instance</strong></div>
      <div class="item"><span>Délai d'expiration (Timeout)</span><strong>${this.timeoutSeconds} secondes</strong></div>
    </div>

    <div class="footer">
      <span>Google Cloud Web Services · Prêt pour la production</span>
      <span>Traité en ${Date.now() - startTime} ms</span>
    </div>
  </div>
</body>
</html>`);
      });

      this.server.on("error", (err) => {
        this.status = "ERROR";
        this.addLog("ERROR", `Échec du démarrage de l'écouteur : ${err.message}`);
        reject(err);
      });

      this.server.listen(0, "127.0.0.1", () => {
        this.hostPort = this.server.address().port;
        this.status = "RUNNING";
        this.startedAt = Date.now();
        this.stoppedAt = null;
        this.addLog("INFO", `Révision active sur le port hôte ${this.hostPort}`);
        this.addLog("INFO", `Routage actif : 100% du trafic HTTP acheminé vers ${this.name}`);
        resolve(this);
      });
    });
  }

  async stop() {
    this.addLog("WARN", `Mise à l'échelle vers zéro (Scale-to-zero) du conteneur ${this.name}`);
    if (this.isRealDocker) {
      try {
        await execFileAsync("docker", ["stop", this.dockerContainerName], { timeout: 10000 });
      } catch (err) {
        this.addLog("WARN", `Docker stop warning: ${err.message}`);
      }
      this.status = "STOPPED";
      this.stoppedAt = Date.now();
      this.addLog("INFO", `Conteneur Docker arrêté proprement`);
      return;
    }

    return new Promise((resolve) => {
      if (!this.server) {
        this.status = "STOPPED";
        return resolve();
      }
      this.server.close(() => {
        this.server = null;
        this.status = "STOPPED";
        this.stoppedAt = Date.now();
        this.addLog("INFO", `Instance stoppée proprement (0 instance active)`);
        resolve();
      });
    });
  }

  getUptime() {
    if (this.status !== "RUNNING" || !this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  getMetrics() {
    const isRunning = this.status === "RUNNING";
    const uptime = this.getUptime();
    const baseCpu = isRunning ? Math.min(100, Math.max(0.5, ((this.requestCount * 1.5) % 35) + (Math.sin(uptime / 10) * 5 + 8))) : 0;
    const baseMemMb = isRunning ? Math.min(this.memoryMb, Math.max(32, 48 + ((this.requestCount * 3) % 120))) : 0;

    return {
      service: this.name,
      revision: this.revision,
      status: this.status,
      runtimeMode: this.isRealDocker ? "Docker Engine Réel" : "Émulateur Autonome Cloud Run",
      uptimeSeconds: uptime,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      cpuPercent: Number(baseCpu.toFixed(1)),
      memoryMb: Number(baseMemMb.toFixed(1)),
      memoryLimitMb: this.memoryMb,
      memoryPercent: Number(((baseMemMb / this.memoryMb) * 100).toFixed(1)),
      hostPort: this.hostPort,
      internalPort: this.internalPort,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      appName: this.name,
      revision: this.revision,
      image: this.image,
      region: this.region,
      internalPort: this.internalPort,
      hostPort: this.hostPort,
      url: `/services/${this.name}/`,
      status: this.status,
      isRealDocker: this.isRealDocker,
      runtimeMode: this.isRealDocker ? "Docker Engine Réel" : "Émulateur Autonome Cloud Run",
      isXray: this.xray.enabled,
      xray: this.xray,
      memoryMb: this.memoryMb,
      cpus: this.cpus,
      minInstances: this.minInstances,
      maxInstances: this.maxInstances,
      concurrency: this.concurrency,
      timeoutSeconds: this.timeoutSeconds,
      ingress: this.ingress,
      env: this.env,
      createdAt: this.createdAt,
      uptimeSeconds: this.getUptime(),
      requestCount: this.requestCount,
      metrics: this.getMetrics(),
    };
  }
}

export class ContainerEngine {
  constructor() {
    this.services = new Map();
    this.systemInfo = {
      platform: "Google Cloud Web Services",
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      nodeVersion: process.version,
      cpus: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    };
  }

  listServices() {
    return Array.from(this.services.values()).map((svc) => svc.toJSON());
  }

  getService(nameOrId) {
    if (this.services.has(nameOrId)) return this.services.get(nameOrId);
    for (const svc of this.services.values()) {
      if (svc.name === nameOrId || svc.id === nameOrId) return svc;
    }
    return null;
  }

  async deployService(params) {
    const { appName, image, region, internalPort, memoryMb, cpus, minInstances, maxInstances, concurrency, timeoutSeconds, ingress, env, isXray, uuid, wsPath } = params;

    let service = this.getService(appName);
    if (service) {
      service.addLog("INFO", `Déploiement d'une nouvelle révision Google Cloud Run pour ${appName}`);
      service.image = image;
      service.region = region || service.region;
      service.internalPort = Number(internalPort) || service.internalPort;
      service.memoryMb = Number(memoryMb) || service.memoryMb;
      service.cpus = Number(cpus) || service.cpus;
      service.minInstances = minInstances !== undefined ? Number(minInstances) : service.minInstances;
      service.maxInstances = maxInstances !== undefined ? Number(maxInstances) : service.maxInstances;
      service.concurrency = concurrency !== undefined ? Number(concurrency) : service.concurrency;
      service.timeoutSeconds = timeoutSeconds !== undefined ? Number(timeoutSeconds) : service.timeoutSeconds;
      service.ingress = ingress || service.ingress;
      if (isXray || (image && (image.includes("xray") || image.includes("v2ray")))) {
        service.xray.enabled = true;
        if (uuid) service.xray.uuid = uuid;
        if (wsPath) service.xray.wsPath = wsPath;
      }
      service.env = { ...service.env, ...env };
      service.revision = `${appName}-0000${Math.floor(Math.random() * 89 + 10)}-gcp`;

      if (service.status !== "RUNNING") {
        await service.start();
      }
      return service;
    }

    service = new ServiceInstance(params);
    this.services.set(service.name, service);
    await service.start();
    return service;
  }

  async stopService(nameOrId) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    await service.stop();
    return service.toJSON();
  }

  async startService(nameOrId) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    if (service.isRealDocker) {
      try {
        await execFileAsync("docker", ["start", service.dockerContainerName], { timeout: 10000 });
        service.status = "RUNNING";
        service.startedAt = Date.now();
        service.stoppedAt = null;
        service.addLog("INFO", `Conteneur Docker redémarré avec succès`);
        return service.toJSON();
      } catch (err) {
        service.addLog("WARN", `Erreur redémarrage docker: ${err.message}`);
      }
    }
    await service.start();
    return service.toJSON();
  }

  async restartService(nameOrId) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    if (service.isRealDocker) {
      try {
        await execFileAsync("docker", ["restart", service.dockerContainerName], { timeout: 15000 });
        service.status = "RUNNING";
        service.startedAt = Date.now();
        service.addLog("INFO", `Redémarrage du conteneur Docker effectué`);
        return service.toJSON();
      } catch (err) {
        service.addLog("WARN", `Erreur restart docker: ${err.message}`);
      }
    }
    await service.stop();
    await service.start();
    service.addLog("INFO", `Redémarrage de l'instance Cloud Run effectué`);
    return service.toJSON();
  }

  async deleteService(nameOrId) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    if (service.isRealDocker) {
      try {
        await execFileAsync("docker", ["rm", "-f", service.dockerContainerName], { timeout: 10000 });
      } catch {
        // Ignorer
      }
    }
    await service.stop();
    this.services.delete(service.name);
    return { success: true, id: service.id, name: service.name };
  }

  getLogs(nameOrId) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    return service.logs;
  }

  getMetrics(nameOrId) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    return service.getMetrics();
  }

  async execCommand(nameOrId, command) {
    const service = this.getService(nameOrId);
    if (!service) throw new Error(`Service "${nameOrId}" introuvable.`);
    service.addLog("INFO", `$ ${command}`);
    const cmd = command.trim();

    if (service.isRealDocker) {
      try {
        const { stdout, stderr } = await execFileAsync(
          "docker",
          ["exec", service.dockerContainerName, "sh", "-c", cmd],
          { timeout: 10000 }
        );
        return { exitCode: 0, output: stdout || stderr || "OK" };
      } catch (err) {
        return { exitCode: err.code || 1, output: err.stderr || err.message };
      }
    }

    let output = "";
    if (cmd === "env") {
      output = Object.entries(service.env).map(([k, v]) => `${k}=${v}`).join("\n");
    } else if (cmd === "uname -a") {
      output = `Linux ${service.name} 6.6.0-cloud #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`;
    } else if (cmd === "uptime") {
      output = `up ${service.getUptime()} seconds, load average: 0.12, 0.08, 0.05`;
    } else if (cmd === "ps aux" || cmd === "ps") {
      output = `USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\nroot         1  0.1  0.4 112450 32400 ?        Ss   05:00   0:01 node server.js\nroot        14  0.0  0.1   8900  4200 ?        S    05:01   0:00 /bin/sh`;
    } else if (cmd === "df -h") {
      output = `Filesystem      Size  Used Avail Use% Mounted on\noverlay          40G  2.8G   38G   7% /\ntmpfs            64M     0   64M   0% /dev\nshm              64M     0   64M   0% /dev/shm`;
    } else {
      output = `[gcp-exec:${service.name}] Commande exécutée avec succès.\nSortie standard :\n${cmd}: OK`;
    }

    return { exitCode: 0, output };
  }
}

export const containerEngine = new ContainerEngine();
