import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createFlyClient, deployImage, machineConfig } from "./fly-client.js";
import { buildDockerfile } from "./dockerfile.js";
import * as ttl from "./ttl.js";
import * as ttlAlias from "./ttl (1).js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("getApp treats only 404 as an absent app", async () => {
  globalThis.fetch = async () => response(404, { error: "not found" });
  assert.equal(await createFlyClient("token").getApp("missing-app"), null);

  globalThis.fetch = async () => response(404, "application not found");
  assert.equal(await createFlyClient("token").getApp("missing-app"), null);

  globalThis.fetch = async () => response(401, "unauthorized");
  await assert.rejects(
    createFlyClient("token").getApp("app"),
    (error) => error.status === 401 && error.message === "unauthorized",
  );
});

test("waitForMachine propagates API errors", async () => {
  globalThis.fetch = async () => response(503, { error: "unavailable" });
  await assert.rejects(
    createFlyClient("token").waitForMachine("app", "machine"),
    (error) => error.status === 503,
  );
});

test("orgSlug reports malformed GraphQL responses clearly", async () => {
  globalThis.fetch = async () => response(200, { errors: [null] });
  await assert.rejects(
    createFlyClient("token").orgSlug(),
    /Fly.io GraphQL : Erreur GraphQL inconnue/,
  );

  globalThis.fetch = async () => response(200, { organizations: { nodes: "invalid" } });
  await assert.rejects(
    createFlyClient("token").orgSlug(),
    /Aucune organisation Fly.io disponible/,
  );
});

test("deployImage does not report success when the machine fails to start", async () => {
  const replies = [
    response(404, { error: "not found" }),
    response(200, { organizations: { nodes: [{ slug: "personal", type: "PERSONAL" }] } }),
    response(201, { app_name: "app" }),
    response(200, { allocateIpAddress: { ipAddress: { address: "203.0.113.1", type: "shared_v4" } } }),
    response(201, { id: "machine-1" }),
    response(503, { error: "machine did not start" }),
    response(204, null),
    response(204, null),
  ];
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    return replies.shift();
  };

  await assert.rejects(
    deployImage({ token: "token", appName: "app", image: "example/image:latest" }),
    (error) => error.status === 503,
  );
  assert.equal(replies.length, 0);
  assert.match(requestedUrls[6], /machines\/machine-1\?force=true$/);
  assert.match(requestedUrls[7], /\/apps\/app$/);
});

test("deployImage removes a newly created app when a later step fails", async () => {
  const replies = [
    response(404, { error: "not found" }),
    response(200, { organizations: { nodes: [{ slug: "personal", type: "PERSONAL" }] } }),
    response(201, { app_name: "app" }),
    response(503, { error: "allocation failed" }),
    response(204, null),
  ];
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    return replies.shift();
  };

  await assert.rejects(
    deployImage({ token: "token", appName: "app", image: "example/image:latest" }),
    (error) => error.status === 503,
  );
  assert.equal(replies.length, 0);
  assert.match(requestedUrls[4], /\/apps\/app$/);
});

test("deployImage preserves an existing app when machine startup fails", async () => {
  const replies = [
    response(200, { app_name: "app" }),
    response(200, { allocateIpAddress: { ipAddress: { address: "203.0.113.1" } } }),
    response(201, { id: "machine-1" }),
    response(503, { error: "machine did not start" }),
    response(204, null),
  ];
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(url);
    return replies.shift();
  };

  await assert.rejects(
    deployImage({ token: "token", appName: "app", image: "example/image:latest" }),
    (error) => error.status === 503,
  );
  assert.equal(replies.length, 0);
  assert.equal(requestedUrls.length, 5);
  assert.match(requestedUrls[4], /machines\/machine-1\?force=true$/);
});

test("deployImage validates machine configuration before making API requests", async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return response(200, {});
  };

  await assert.rejects(
    deployImage({ token: "token", appName: "app", image: "example/image:latest", memoryMb: 0 }),
    /mémoire doit être un entier positif/,
  );
  assert.equal(requestCount, 0);
});

test("machineConfig rejects invalid guest and environment values", () => {
  assert.throws(
    () => machineConfig({ image: "example/image:latest", internalPort: 8080, cpus: 1.5 }),
    /nombre de CPU doit être un entier positif/,
  );
  assert.throws(
    () => machineConfig({ image: "example/image:latest", internalPort: 8080, env: { PORT: 8080 } }),
    /variables d'environnement doivent être un objet de chaînes/,
  );
});

test("machineConfig honors the forceHttps option", () => {
  const httpRoute = machineConfig({
    image: "example/image:latest",
    internalPort: 8080,
    forceHttps: false,
  }).services.find((service) => service.ports[0].port === 80);

  assert.equal(httpRoute.ports[0].force_https, undefined);
});

test("static Dockerfile serves on the requested port", () => {
  const dockerfile = buildDockerfile({ runtime: "static", port: 8080 });

  assert.match(dockerfile, /listen 8080;/);
  assert.match(dockerfile, /listen \[::\]:8080;/);
  assert.match(dockerfile, /EXPOSE 8080/);
});

test("Dockerfile generator rejects invalid ports", () => {
  assert.throws(
    () => buildDockerfile({ runtime: "static", port: 65536 }),
    /port doit être un entier entre 1 et 65535/,
  );
});

test("Dockerfile generator rejects unknown runtimes", () => {
  assert.throws(
    () => buildDockerfile({ runtime: "pytthon", port: 8080 }),
    /runtime doit être « node », « python », « go » ou « static »/,
  );
});

test("Dockerfile generator uses lockfiles and supports Go modules without go.sum", () => {
  const nodeDockerfile = buildDockerfile({ runtime: "node" });
  const goDockerfile = buildDockerfile({ runtime: "go" });

  assert.match(nodeDockerfile, /npm ci --omit=dev/);
  assert.match(nodeDockerfile, /npm install --omit=dev/);
  assert.match(goDockerfile, /COPY go\.mod \.\/\nRUN go mod download/);
  assert.doesNotMatch(goDockerfile, /COPY go\.mod go\.sum/);
});

test("invalid custom routes do not silently fall back to public defaults", () => {
  assert.throws(
    () =>
      machineConfig({
        image: "example/image:latest",
        internalPort: 8080,
        routes: [{ public_port: 0, internal_port: 8080 }],
      }),
    /port public doit être un entier entre 1 et 65535/,
  );
});

test("duplicate TTL module re-exports the canonical module", () => {
  assert.deepEqual(ttlAlias, ttl);
});

test("TTL helpers reject invalid durations and expiry dates", () => {
  assert.throws(() => ttl.ttlLabel("invalid"), /durée doit être un nombre entier/);
  assert.throws(() => ttl.expiresAtFrom(-1), /durée doit être un nombre entier/);
  assert.throws(() => ttl.expiresAtFrom(Number.MAX_SAFE_INTEGER), /dépasse la plage de dates/);
  assert.throws(() => ttl.formatRemaining(Number.NaN), /durée restante doit être un nombre fini/);
  assert.throws(() => ttl.isExpired("not-a-date"), /date d'expiration est invalide/);
});
