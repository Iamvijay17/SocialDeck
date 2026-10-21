# Build context: repository root (see docker-compose.yml)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/worker/package.json apps/worker/
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
RUN npm ci --omit=dev --workspace=@osh/worker --include-workspace-root=false --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/worker apps/worker
COPY packages packages
RUN mkdir -p /data/media && chown -R node:node /data
USER node
WORKDIR /app/apps/worker
# The scheduler touches this file every 10 s while the worker loop is alive.
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const s=require('fs').statSync('/tmp/worker-heartbeat');process.exit(Date.now()-s.mtimeMs<60000?0:1)"
CMD ["node", "src/worker.js"]
