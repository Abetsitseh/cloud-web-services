# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080

COPY --chown=node:node package.json server.js fly-client.js container-engine.js ./
COPY --chown=node:node public/ ./public/

USER node
EXPOSE 8080
CMD ["node", "server.js"]
