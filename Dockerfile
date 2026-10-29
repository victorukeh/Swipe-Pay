# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build.
#
# The runtime stage carries production dependencies, the compiled output and the
# Prisma schema -- no TypeScript, no test tooling, no source. Node 22 is pinned
# because the brief asks for an LTS runtime (local development happens on 25,
# which is not LTS).
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
WORKDIR /app
# Yarn is vendored in the repo via .yarnrc.yml's yarnPath, so there is no
# corepack or global install step -- the toolchain is whatever the repo pins.
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/releases ./.yarn/releases


# --- dependencies ----------------------------------------------------------
FROM base AS deps
# --immutable fails the build if yarn.lock would have to change, so an image can
# never be built from dependencies nobody committed.
RUN yarn install --immutable


# --- build -----------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# Generate the client before compiling: the build imports @prisma/client types.
RUN yarn prisma generate && yarn build


# --- production dependencies ----------------------------------------------
FROM base AS prod-deps
RUN yarn workspaces focus --production
# The Prisma client is generated code and lives in node_modules, so it has to be
# regenerated against the pruned tree.
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN yarn prisma generate


# --- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/.yarn/releases ./.yarn/releases
COPY --from=build /app/dist ./dist
COPY .yarnrc.yml package.json yarn.lock prisma.config.ts ./
COPY prisma ./prisma
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Run unprivileged. `node` already exists in the base image.
USER node

EXPOSE 3000

# A HEALTHCHECK rather than just a compose condition, so `docker ps` reports
# something meaningful too.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
