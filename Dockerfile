# syntax=docker/dockerfile:1

# Base image pinned by digest (node 22.23.3, alpine). To update:
#   docker buildx imagetools inspect node:22-alpine   # copy the new Digest
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# ---- Build: React frontend (dist/) and TypeScript server (build/) ----
# Output is plain JavaScript, so this stage runs natively on the build machine.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

# ---- Runtime: API server + static UI ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3030 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
# Instances added in the settings UI are saved here; mount a volume to keep them.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3030)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
