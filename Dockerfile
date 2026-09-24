FROM node:24-bookworm-slim AS frontend

WORKDIR /app
COPY package.json package-lock.json ./
COPY widget/package.json ./widget/
RUN npm ci --ignore-scripts
COPY . .
RUN if find /app \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' -print -quit | grep -q .; then \
      echo 'FATAL: .env file present in Docker build context — aborting'; \
      find /app \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' -print; \
      exit 1; \
    fi

# Public site identity and optional analytics. Railway injects these into the
# build. Defaults stay in src/constants.json for OSS clones.
ARG COMPANY_WEBSITE
ARG COMPANY_EMAIL
ARG VITE_COMPANY_WEBSITE
ARG VITE_COMPANY_EMAIL
ARG FRONTEND_URL
ARG VITE_ANALYTICS_SRC
ARG VITE_ANALYTICS_ID
ARG VITE_ANALYTICS_DOMAINS
ENV COMPANY_WEBSITE=$COMPANY_WEBSITE \
    COMPANY_EMAIL=$COMPANY_EMAIL \
    VITE_COMPANY_WEBSITE=$VITE_COMPANY_WEBSITE \
    VITE_COMPANY_EMAIL=$VITE_COMPANY_EMAIL \
    FRONTEND_URL=$FRONTEND_URL \
    VITE_ANALYTICS_SRC=$VITE_ANALYTICS_SRC \
    VITE_ANALYTICS_ID=$VITE_ANALYTICS_ID \
    VITE_ANALYTICS_DOMAINS=$VITE_ANALYTICS_DOMAINS

RUN npm run build

FROM rust:bookworm AS backend

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsqlite3-dev libcurl4-openssl-dev pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY backend/rust-toolchain.toml backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsqlite3-0 libcurl4 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=frontend /app/dist ./dist
COPY --from=frontend /app/widget/dist ./widget/dist
COPY --from=frontend /app/package.json ./package.json
COPY --from=backend /build/target/release/skateboard-backend /usr/local/bin/skateboard-backend
COPY backend/config.json ./backend/config.json

# Run as root: the Railway volume mounts at /app/backend/databases owned by
# root and masks any build-time chown, so a non-root user cannot create the
# SQLite file.
RUN mkdir -p /app/backend/databases

ENV NODE_ENV=production
ENV SKATEBOARD_BACKEND_DIR=/app/backend
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health >/dev/null || exit 1

CMD ["skateboard-backend"]
