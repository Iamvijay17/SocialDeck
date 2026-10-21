# Build context: repository root (see docker-compose.yml)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=@osh/web --include-workspace-root=false --ignore-scripts
COPY apps/web apps/web
RUN npm run build -w @osh/web

FROM nginxinc/nginx-unprivileged:1.27-alpine
# openssl is only used by the first-start script that creates a self-signed certificate for https://localhost.
USER root
RUN apk add --no-cache openssl && mkdir -p /certs && chown 101:101 /certs
USER 101
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/web/docker-entrypoint.d/40-selfsigned-cert.sh /docker-entrypoint.d/40-selfsigned-cert.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
