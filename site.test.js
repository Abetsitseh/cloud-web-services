import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const page = new URL("./public/index.html", import.meta.url);
const stylesheet = new URL("./public/site.css", import.meta.url);
const dockerfile = new URL("./Dockerfile.site", import.meta.url);

test("landing page declares French language and Google Cloud Web Service form without admin key or billing", async () => {
  const html = await readFile(page, "utf8");

  assert.match(html, /<html lang="fr">/);
  assert.match(html, /<a class="skip-link" href="#contenu">/);
  assert.match(html, /<main id="contenu">/);
  assert.match(html, /<nav class="main-nav" aria-label="Navigation principale">/);
  assert.match(html, /<ol class="flow-list">/);
  assert.match(html, /<form id="deploy-form">/);
  assert.match(html, /<label for="image">URL de l'image de conteneur<\/label>/);
  assert.match(html, /<label for="region">Région Google Cloud/);
  assert.match(html, /<label for="cpus">Allocation processeur \(vCPU\)<\/label>/);
  assert.match(html, /<label for="memory-mb">Mémoire vive \(RAM\)<\/label>/);
  assert.match(html, /<label for="concurrency">Concurrence max/);
  assert.match(html, /id="server-status" role="status"/);

  // Vérifie l'absence totale de commande administrateur, de clé d'accès et de facturation
  assert.doesNotMatch(html, /access-token|Clé d’accès administrateur|carte bancaire|facturation payante|carte de crédit/);
  // Vérifie l'absence de mentions Fly.io
  assert.doesNotMatch(html, /Fly\.io|fly\.dev|Fly Machines|FLY_TOKEN/);
});

test("landing page assets and container target exist", async () => {
  const [html, css, docker] = await Promise.all([
    readFile(page, "utf8"),
    readFile(stylesheet, "utf8"),
    readFile(dockerfile, "utf8"),
  ]);

  assert.match(html, /href="\.\/site\.css"/);
  assert.match(html, /src="\.\/site\.js"/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.flow-card/);
  assert.match(css, /\.workflow-panel/);
  assert.match(docker, /FROM node:20-alpine/);
  assert.match(docker, /COPY .*public\/ \.\/public\//);
  assert.match(docker, /CMD \["node", "server\.js"\]/);
});

test("deployment page calls its Google Cloud API without requiring admin credentials or external tokens", async () => {
  const script = await readFile(new URL("./public/site.js", import.meta.url), "utf8");

  assert.match(script, /fetch\("\/api\/health"/);
  assert.match(script, /fetch\("\/api\/deploy"/);
  assert.doesNotMatch(script, /accessToken|Authorization: "Bearer|FLY_TOKEN|localStorage|sessionStorage/);
});
