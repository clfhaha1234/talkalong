# talkalong /tutor — production container for a PERSISTENT Node host
# (Render / Railway / Fly / any VM). This image now includes BOTH projects:
#   - repo root: Remotion illustration-to-video renderer (npm + React 18)
#   - agora-voice-demo/: Next tutor app (pnpm + React 19)
#
# Render builds this Dockerfile with dockerContext=./ from the repo root. At
# runtime `next start` runs from /app/agora-voice-demo, and video-gen resolves
# the Remotion parent project at /app.
#
# The host injects $PORT; `next start` binds it automatically (0.0.0.0).

FROM node:22-slim

# Runtime libs required by Chromium/Remotion on Debian slim. Remotion provides
# the browser binary; these are the shared libraries it needs to launch.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnss3 \
  libpango-1.0-0 \
  libx11-6 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Install the root Remotion renderer dependencies first. package-lock.json pins
# Remotion/Chromium-related transitive deps and keeps Docker layer caching tight.
COPY package.json package-lock.json ./
RUN npm ci

# Install Next app deps second. package.json pins pnpm 9 via "packageManager"
# (corepack honors it), which runs native postinstall scripts without pnpm 10+'s
# approval gate.
WORKDIR /app/agora-voice-demo
COPY agora-voice-demo/package.json agora-voice-demo/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build.
WORKDIR /app
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

WORKDIR /app/agora-voice-demo
RUN pnpm build

ENV NODE_ENV=production
# Default for local `docker run`; hosts override with their own $PORT.
ENV PORT=3000
EXPOSE 3000

CMD ["pnpm", "start"]
