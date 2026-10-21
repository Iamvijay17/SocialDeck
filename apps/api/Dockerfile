# Build context: repository root (see docker-compose.yml)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
COPY packages/platform-core/package.json packages/platform-core/
COPY packages/server-core/package.json packages/server-core/
COPY packages/adapters/bluesky/package.json packages/adapters/bluesky/
COPY packages/adapters/mastodon/package.json packages/adapters/mastodon/
COPY packages/adapters/instagram/package.json packages/adapters/instagram/
COPY packages/adapters/facebook/package.json packages/adapters/facebook/
COPY packages/adapters/threads/package.json packages/adapters/threads/
COPY packages/adapters/x/package.json packages/adapters/x/
# Production dependencies of the API workspace only (no dev tools, no web build chain).
RUN npm ci --omit=dev --workspace=@osh/api --include-workspace-root=false --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/api apps/api
COPY packages packages
RUN mkdir -p /data/media && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
