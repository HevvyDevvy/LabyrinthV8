# LabyrinthV8 API server — multi-stage build.
#
# Stage 1 needs the whole pnpm workspace (the frontend, api-zod, db, etc.)
# because api-server depends on workspace packages and esbuild bundles them
# in. Stage 2 only ships the single bundled dist/index.mjs esbuild produces
# — no node_modules, no source, no other workspace packages — so the final
# image stays small.

FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

# Copy the whole monorepo. .dockerignore keeps node_modules/dist/.git out.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/artifacts/api-server/dist ./dist

# Where scan/audit/keystore state is written. Mount a persistent volume here
# in production — see render.yaml — or state resets whenever the container
# restarts or redeploys.
ENV LABYRINTH_DATA_DIR=/app/data
RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
