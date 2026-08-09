# The self-hosted image: build the site, then serve it and the API from one
# Node process (scripts/serve.ts).
#
# Two stages, because the build needs the dev dependencies (Vite, tsx, the
# generators) and the runtime does not. What ships is dist/ plus the server and
# its production dependencies.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first: this layer only rebuilds when the lockfile moves, so an
# edit to the source does not re-download the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The build runs with no database on purpose — the same path a contributor takes
# after a plain clone. It discovers no DB timelines and registers only the local
# sources rather than failing (see „Principle: no emergency or fallback data").
# A deployment's own timelines are discovered at runtime, not baked in here.
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tsx is a runtime dependency here: the server is TypeScript and is executed
# directly rather than compiled to a second build output.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY scripts ./scripts
# All of src/, not a hand-picked list. The server reaches into it for the rules
# shared with the client (item extent, phase overlap, status, the types) and,
# through the plugin registry, further than a list stays right about — the first
# attempt at naming five files died on a plugin module at startup. It is source
# text, so the cost of copying the rest is noise.
COPY src ./src
COPY supabase/migrations ./supabase/migrations
COPY docker-entrypoint.sh ./

# Bind to every interface: inside a container the only reachable address is the
# published port, and the host decides who reaches that. The server's own
# default stays 127.0.0.1 for a bare `npm start`.
ENV TIMELINES_SERVE_HOST=0.0.0.0
ENV TIMELINES_SERVE_PORT=3120
EXPOSE 3120

# Not root. The process only ever reads dist/ and talks to Postgres.
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
