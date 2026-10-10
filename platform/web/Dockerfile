# The web app and the gateway in front of core, in one image.
#   docker build -t game-item-exchange/web:dev platform/web
#   docker run -p 8081:80 -e CORE_URL=http://host.docker.internal:8080 game-item-exchange/web:dev

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
LABEL org.opencontainers.image.source=https://github.com/david-d25/game-item-exchange
# Core's base URL: a full DNS name, because nginx's resolver does not use search domains
ENV CORE_URL=http://core-api.gie.svc.cluster.local
# The entrypoint puts the nameservers from /etc/resolv.conf into NGINX_LOCAL_RESOLVERS for the template
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
# Only these two are substituted into the template; nginx variables like $uri must survive envsubst
ENV NGINX_ENVSUBST_FILTER=^(CORE_URL|NGINX_LOCAL_RESOLVERS)$
RUN rm -f /usr/share/nginx/html/*.html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html/exchange
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
