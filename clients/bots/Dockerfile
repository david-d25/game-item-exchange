# Trading bots that keep the demo market alive.
#   docker build -t game-item-exchange/bots:dev clients/bots
#   docker run -e CORE_URL=http://host.docker.internal:8080 -e INTERNAL_TOKEN=... game-item-exchange/bots:dev

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
LABEL org.opencontainers.image.source=https://github.com/david-d25/game-item-exchange
ENV NODE_ENV=production
WORKDIR /app
# No runtime dependencies: the compiled code and package.json, which marks dist/*.js as ES modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
# The unprivileged user that comes with the node images
USER node
# Node runs as PID 1 and handles SIGTERM itself: it cancels the bots' open orders and exits within ~5 s
CMD ["node", "--max-old-space-size=48", "dist/main.js"]
