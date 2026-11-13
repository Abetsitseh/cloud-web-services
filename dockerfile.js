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
