# talkalong /tutor — production container for a PERSISTENT Node host
# (Render / Railway / Fly / any VM). This is the right target: the app is a
# stateful, long-running orchestrator (a single narration session can run for
# minutes, holds an in-memory session registry, and writes generated images to
# public/lesson-cache at runtime) — none of which fit Vercel serverless.
#
# Scope = the Next app only (this directory). Video rendering (Remotion, which
# lives in the repo ROOT and needs Chromium) is intentionally NOT included — the
# UI falls back to the still illustration, which is what most scenes show. See
# DEPLOY.md for the full-video upgrade path.
#
# The host injects $PORT; `next start` binds it automatically (0.0.0.0).

FROM node:22-slim
RUN corepack enable
WORKDIR /app

# Install deps first (cached unless the lockfile changes). package.json pins
# pnpm 9 via "packageManager" (corepack honors it), which runs native postinstall
# scripts without pnpm 10+'s approval gate.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build.
COPY . .

# NEXT_PUBLIC_* env vars are INLINED into the bundle at BUILD time (webpack
# DefinePlugin) — they are NOT read at runtime. So the Agora App ID the browser
# needs must be present during `pnpm build`, or the client bakes an empty string
# and /tutor renders "NEXT_PUBLIC_AGORA_APP_ID is not set". Render (and most PaaS)
# pass the service's env vars to the Docker build as build args; declare them
# here so the build picks them up. The server-only secrets (certificate,
# GOOGLE_API_KEY) are read at runtime in API routes and need NOT be build args.
ARG NEXT_PUBLIC_AGORA_APP_ID
ARG NEXT_PUBLIC_AGENT_UID
ENV NEXT_PUBLIC_AGORA_APP_ID=${NEXT_PUBLIC_AGORA_APP_ID}
ENV NEXT_PUBLIC_AGENT_UID=${NEXT_PUBLIC_AGENT_UID}

RUN pnpm build

ENV NODE_ENV=production
# Default for local `docker run`; hosts override with their own $PORT.
ENV PORT=3000
EXPOSE 3000

CMD ["pnpm", "start"]
