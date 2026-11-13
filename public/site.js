const form = document.querySelector("#deploy-form");
const fields = document.querySelector("#deploy-fields");
const serverStatus = document.querySelector("#server-status");
const deployStatus = document.querySelector("#deploy-status");
const deployResult = document.querySelector("#deploy-result");
const submitButton = document.querySelector("#deploy-submit");
const serviceLink = document.querySelector("#deploy-url");

// Google Cloud Console Elements
const kpiServicesCount = document.querySelector("#kpi-services-count");
const kpiRequestsCount = document.querySelector("#kpi-requests-count");
const emptyServicesMessage = document.querySelector("#empty-services-message");
const servicesCardsGrid = document.querySelector("#services-cards-grid");
const refreshServicesBtn = document.querySelector("#refresh-services-btn");
const metricCpuVal = document.querySelector("#metric-cpu-val");
const metricCpuBar = document.querySelector("#metric-cpu-bar");
const metricMemVal = document.querySelector("#metric-mem-val");
const metricMemBar = document.querySelector("#metric-mem-bar");
const metricReqVal = document.querySelector("#metric-req-val");
const logsSelect = document.querySelector("#logs-service-select");
const logsConsole = document.querySelector("#logs-console");
const clearLogsBtn = document.querySelector("#clear-logs-btn");
const addEnvBtn = document.querySelector("#add-env-btn");
const envVarsList = document.querySelector("#env-vars-list");

let currentLogService = "";

async function checkServer() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error("Console indisponible");

    if (fields) fields.disabled = false;
    if (serverStatus) {
      serverStatus.dataset.state = "ready";
      serverStatus.textContent = "Console Google Cloud active. Moteur autonome prêt au déploiement.";
    }

    await refreshDashboard();
  } catch {
    if (serverStatus) {
      serverStatus.dataset.state = "offline";
      serverStatus.textContent = "Console Google Cloud hors ligne. Démarrez le serveur Node local (npm start).";
    }
  }
}

async function fetchServices() {
  try {
    const response = await fetch("/api/services", { cache: "no-store" });
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

async function refreshDashboard() {
  const services = await fetchServices();

  const count = services.length;
  if (kpiServicesCount) kpiServicesCount.textContent = String(count);

  let totalRequests = 0;
  let totalCpu = 0;
  let totalMem = 0;

  services.forEach((s) => {
    totalRequests += s.requestCount || 0;
    if (s.metrics) {
      totalCpu += s.metrics.cpuPercent || 0;
      totalMem += s.metrics.memoryMb || 0;
    }
  });

  if (kpiRequestsCount) kpiRequestsCount.textContent = String(totalRequests);
  if (metricReqVal) metricReqVal.textContent = totalRequests + " req";

  const avgCpu = count > 0 ? (totalCpu / count).toFixed(1) : "0.0";
  if (metricCpuVal) metricCpuVal.textContent = avgCpu + "%";
  if (metricCpuBar) metricCpuBar.style.width = Math.min(100, Math.max(2, parseFloat(avgCpu))) + "%";

  if (metricMemVal) metricMemVal.textContent = totalMem.toFixed(0) + " Mo";
  if (metricMemBar) metricMemBar.style.width = Math.min(100, Math.max(3, (totalMem / 2048) * 100)) + "%";

  renderServicesGrid(services);
  updateLogsSelect(services);
}

function renderServicesGrid(services) {
  if (!servicesCardsGrid || !emptyServicesMessage) return;

  if (!services || services.length === 0) {
    emptyServicesMessage.hidden = false;
    servicesCardsGrid.hidden = true;
    servicesCardsGrid.innerHTML = "";
    return;
  }

  emptyServicesMessage.hidden = true;
  servicesCardsGrid.hidden = false;
  servicesCardsGrid.innerHTML = "";

  services.forEach((service) => {
    const card = document.createElement("article");
    card.className = "service-card";

    const isRunning = service.status === "RUNNING";
    const statusClass = isRunning ? "status-running" : "status-stopped";
    const statusLabel = isRunning ? "🟢 EN LIGNE" : "🔴 ARRÊTÉ";

    card.innerHTML = `
      <div class="service-card-header">
        <div>
          <h3 class="service-card-title">${escapeHtml(service.name)}</h3>
          <small class="service-revision-text">${escapeHtml(service.revision || service.name)}</small>
        </div>
        <span class="service-status-pill ${statusClass}">${statusLabel}</span>
      </div>
      <div class="service-meta-grid">
        <div class="service-meta-item"><span>Image</span><strong>${escapeHtml(service.image)}</strong></div>
        <div class="service-meta-item"><span>Région</span><strong>${escapeHtml(service.region || "europe-west9")}</strong></div>
        <div class="service-meta-item"><span>vCPU / RAM</span><strong>${service.cpus} vCPU · ${service.memoryMb} Mo</strong></div>
        <div class="service-meta-item"><span>Port interne</span><strong>${service.internalPort} (TCP)</strong></div>
        <div class="service-meta-item"><span>Exécution</span><strong style="color: ${service.isRealDocker ? '#81c995' : '#8ab4f8'};">${service.runtimeMode || (service.isRealDocker ? 'Docker Engine Réel' : 'Émulateur Cloud Run')}</strong></div>
        <div class="service-meta-item"><span>Uptime</span><strong>${service.uptimeSeconds || 0} s</strong></div>
      </div>
      <div class="service-actions-row">
        <a class="service-btn service-btn-open" href="${service.url}" target="_blank" rel="noopener noreferrer">Ouvrir le service ↗</a>
        ${
          isRunning
            ? `<button class="service-btn service-btn-stop" type="button" data-action="stop" data-name="${service.name}">Arrêter</button>`
            : `<button class="service-btn service-btn-start" type="button" data-action="start" data-name="${service.name}">Démarrer</button>`
        }
        <button class="service-btn service-btn-start" type="button" data-action="restart" data-name="${service.name}">Redémarrer ⟳</button>
        <button class="service-btn service-btn-delete" type="button" data-action="delete" data-name="${service.name}" title="Supprimer">Supprimer ✕</button>
      </div>
    `;

    servicesCardsGrid.appendChild(card);
  });
}

function updateLogsSelect(services) {
  if (!logsSelect) return;
  const previousValue = logsSelect.value;
  logsSelect.innerHTML = `<option value="">-- Tous les services Cloud Run --</option>`;
  services.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name + " (" + s.image + ")";
    logsSelect.appendChild(opt);
  });
  if (previousValue) logsSelect.value = previousValue;
  loadLogs(logsSelect.value);
}

async function loadLogs(serviceName) {
  if (!logsConsole) return;
  try {
    const targetUrl = serviceName ? `/api/services/${serviceName}/logs` : "/api/services";
    const res = await fetch(targetUrl);
    if (!res.ok) return;
    const data = await res.json();

    let logsToDisplay = [];
    if (Array.isArray(data)) {
      if (serviceName) {
        logsToDisplay = data;
      } else {
        data.forEach((s) => {
          if (Array.isArray(s.logs)) logsToDisplay.push(...s.logs);
        });
      }
    }

    if (logsToDisplay.length === 0) {
      logsConsole.innerHTML = `
        <div class="log-row log-info">
          <span class="log-time">${new Date().toLocaleTimeString()}</span>
          <span class="log-badge log-badge-info">INFO</span>
          <span class="log-text">Aucun journal d'activité enregistré pour le moment.</span>
        </div>`;
      return;
    }

    logsToDisplay.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    logsConsole.innerHTML = logsToDisplay
      .slice(-100)
      .map((entry) => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const level = entry.level || "INFO";
        const badgeClass = level === "ERROR" ? "log-badge-error" : level === "WARN" ? "log-badge-warn" : "log-badge-info";
        return `
        <div class="log-row">
          <span class="log-time">${time}</span>
          <span class="log-badge ${badgeClass}">${level}</span>
          <span class="log-text">${escapeHtml(entry.message)}</span>
        </div>`;
      })
      .join("");

    logsConsole.scrollTop = logsConsole.scrollHeight;
  } catch {}
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Preset chips 1-click filling
document.querySelectorAll(".chip-btn").forEach((chip) => {
  chip.addEventListener("click", () => {
    const imageName = chip.getAttribute("data-image");
    const port = chip.getAttribute("data-port");
    const name = chip.getAttribute("data-name");

    const imageInput = document.querySelector("#image");
    const portInput = document.querySelector("#internal-port");
    const nameInput = document.querySelector("#app-name");

    if (imageInput) imageInput.value = imageName;
    if (portInput) portInput.value = port;
    if (nameInput) nameInput.value = name + "-" + Math.floor(Math.random() * 900 + 100);

    form.scrollIntoView({ behavior: "smooth" });
  });
});

// Add environment variable row
if (addEnvBtn && envVarsList) {
  addEnvBtn.addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "env-var-row";
    row.innerHTML = `
      <input type="text" placeholder="NOM" class="env-key" autocomplete="off">
      <span>=</span>
      <input type="text" placeholder="VALEUR" class="env-val" autocomplete="off">
      <button class="remove-env-btn" type="button" title="Supprimer">✕</button>
    `;
    row.querySelector(".remove-env-btn").addEventListener("click", () => row.remove());
    envVarsList.appendChild(row);
  });
}

// Collect environment variables
function collectEnvVars() {
  const env = {};
  if (!envVarsList) return env;
  const rows = envVarsList.querySelectorAll(".env-var-row");
  rows.forEach((row) => {
    const key = row.querySelector(".env-key")?.value?.trim();
    const val = row.querySelector(".env-val")?.value?.trim();
    if (key) env[key] = val || "";
  });
  return env;
}

// Services actions handler (delegation)
if (servicesCardsGrid) {
  servicesCardsGrid.addEventListener("click", async (e) => {
    const button = e.target.closest("button[data-action]");
    if (!button) return;

    const action = button.getAttribute("data-action");
    const name = button.getAttribute("data-name");
    button.disabled = true;

    try {
      if (action === "delete") {
        if (!confirm(`Supprimer définitivement le service "${name}" ?`)) {
          button.disabled = false;
          return;
        }
        await fetch(`/api/services/${name}`, { method: "DELETE" });
      } else {
        await fetch(`/api/services/${name}/${action}`, { method: "POST" });
      }
      await refreshDashboard();
    } catch (err) {
      alert("Erreur lors de l'opération : " + err.message);
    } finally {
      button.disabled = false;
    }
  });
}

if (refreshServicesBtn) {
  refreshServicesBtn.addEventListener("click", refreshDashboard);
}

if (logsSelect) {
  logsSelect.addEventListener("change", () => {
    currentLogService = logsSelect.value;
    loadLogs(currentLogService);
  });
}

if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", () => {
    if (logsConsole) logsConsole.innerHTML = "";
  });
}

// Form submission handler (Google Cloud Run Deployment)
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  deployResult.hidden = true;
  deployStatus.dataset.state = "";
  deployStatus.textContent = "Déploiement Cloud Run en cours. Instanciation du conteneur…";
  submitButton.disabled = true;

  const appName = form.elements.namedItem("appName")?.value?.trim();
  const image = form.elements.namedItem("image")?.value?.trim();
  const region = form.elements.namedItem("region")?.value || "europe-west9";
  const internalPort = Number(form.elements.namedItem("internalPort")?.value || 8080);
  const memoryMb = Number(form.elements.namedItem("memoryMb")?.value || 512);
  const cpus = Number(form.elements.namedItem("cpus")?.value || 1);
  const minInstances = Number(form.elements.namedItem("minInstances")?.value || 0);
  const maxInstances = Number(form.elements.namedItem("maxInstances")?.value || 10);
  const concurrency = Number(form.elements.namedItem("concurrency")?.value || 80);
  const timeoutSeconds = Number(form.elements.namedItem("timeoutSeconds")?.value || 300);
  const ingress = form.elements.namedItem("ingress")?.value || "all";
  const env = collectEnvVars();

  const body = {
    appName,
    image,
    region,
    internalPort,
    memoryMb,
    cpus,
    minInstances,
    maxInstances,
    concurrency,
    timeoutSeconds,
    ingress,
    env,
  };

  try {
    const response = await fetch("/api/deploy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Le déploiement Cloud Run a échoué.");

    const destinationUrl = result.url || `/services/${result.appName}/`;
    serviceLink.href = destinationUrl;
    serviceLink.textContent = "Ouvrir le service : " + destinationUrl + " ↗";

    const machineEl = document.querySelector("#machine-id");
    if (machineEl) machineEl.textContent = result.revision || result.machineId;

    deployResult.hidden = false;
    deployStatus.dataset.state = "success";
    deployStatus.textContent = "Service web Google Cloud Run prêt et actif (100% du trafic orienté).";

    await refreshDashboard();
  } catch (error) {
    deployStatus.dataset.state = "error";
    deployStatus.textContent = error.message || "Impossible de terminer le déploiement du conteneur.";
  } finally {
    submitButton.disabled = false;
  }
});

checkServer();

// Background refresh every 4 seconds
setInterval(() => {
  refreshDashboard();
  if (currentLogService || logsSelect?.value) {
    loadLogs(currentLogService || logsSelect?.value);
  }
}, 4000);
