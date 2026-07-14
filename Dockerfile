FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
# Widget workspace package.json must be present so its build deps (html2canvas,
# vendored into widget/dist) install with the root workspace install.
COPY widget/package*.json ./widget/

RUN npm install && cd backend && npm install

COPY . .

# Public site identity (optional). Railway injects service variables into the
# build environment; defaults stay in src/constants.json for OSS clones.
#   COMPANY_WEBSITE=your.domain.com
#   COMPANY_EMAIL=support@your.domain.com
ARG COMPANY_WEBSITE
ARG COMPANY_EMAIL
ARG VITE_COMPANY_WEBSITE
ARG VITE_COMPANY_EMAIL
ARG FRONTEND_URL
ENV COMPANY_WEBSITE=$COMPANY_WEBSITE \
    COMPANY_EMAIL=$COMPANY_EMAIL \
    VITE_COMPANY_WEBSITE=$VITE_COMPANY_WEBSITE \
    VITE_COMPANY_EMAIL=$VITE_COMPANY_EMAIL \
    FRONTEND_URL=$FRONTEND_URL

RUN npm run build

FROM node:24-alpine

RUN apk add --no-cache libstdc++

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
# Widget bundle served at /widget/v<version>.js — must ship in the runtime image.
COPY --from=builder /app/widget/dist ./widget/dist
# Root package.json: server reads it at /app/package.json to derive the widget version.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/backend ./backend

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && cd backend && npm install --omit=dev \
    && apk del .build-deps

# Run as root: the Railway volume mounts at /app/backend/databases owned by
# root and masks any build-time chown, so a non-root USER cannot create the
# SQLite file. Root can write the volume; matches the known-working config.

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/api/health', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

WORKDIR /app/backend
CMD ["node", "server.ts"]
