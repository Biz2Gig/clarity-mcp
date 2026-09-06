# syntax=docker/dockerfile:1

# ---- deps: full install (dev deps are required to build) --------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: generate client, build the app, then prune to prod deps --------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

# ---- runtime: slim image with ffmpeg, prod deps only ----------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    STORAGE_DIR=/data/storage \
    PORT=3000

# ffmpeg + ffprobe for video validation / audio + keyframe extraction.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/app ./app
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data/storage && chown -R node:node /app /data
USER node

EXPOSE 3000

# Web server (default). The worker service overrides this with `docker-worker`.
CMD ["npm", "run", "docker-start"]
