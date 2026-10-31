# syntax=docker/dockerfile:1
ARG VERSION=0.1.0

FROM node:26-slim AS build
WORKDIR /app
# Node 26 no longer includes Corepack. Keep this pin aligned with mise.toml.
RUN npm install --global pnpm@11.28.10
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile
ARG VERSION
# Protocol and crypto export source; Vite and tsup compile them into their consumers.
RUN npm pkg set --prefix apps/server version="$VERSION" \
    && pnpm --filter @pneumo/web --filter @pneumo/server run build \
    && pnpm --filter @pneumo/server deploy --legacy --prod /prod/server

FROM node:26-slim AS runtime
ARG VERSION
LABEL org.opencontainers.image.version="$VERSION"
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app
RUN groupadd --gid 10001 pneumo \
    && useradd --uid 10001 --gid pneumo --no-create-home --shell /usr/sbin/nologin pneumo
COPY --from=build /prod/server/node_modules ./apps/server/node_modules
COPY --from=build /prod/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER 10001:10001
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
