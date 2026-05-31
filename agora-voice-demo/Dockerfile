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

# Install deps first (cached unless the lockfile changes).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build.
COPY . .
RUN pnpm build

ENV NODE_ENV=production
# Default for local `docker run`; hosts override with their own $PORT.
ENV PORT=3000
EXPOSE 3000

CMD ["pnpm", "start"]
