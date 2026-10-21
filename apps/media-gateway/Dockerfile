# Build context: repository root. The gateway has no dependencies besides the tiny @osh/shared package.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY apps/media-gateway/package.json apps/media-gateway/package.json
COPY apps/media-gateway/src apps/media-gateway/src
COPY packages/shared packages/shared
# Resolve "@osh/shared" without installing anything: a symlink is all the workspace needs here.
RUN mkdir -p node_modules/@osh && ln -s /app/packages/shared node_modules/@osh/shared
USER node
WORKDIR /app/apps/media-gateway
ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=4100 MEDIA_DIR=/data/media
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
