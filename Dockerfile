# Operio API + workers.
# Debian (not alpine): Puppeteer needs a glibc Chromium, the workers shell out
# to `pdftotext`, and the generated PDFs expect Times New Roman / Arial metrics
# (Liberation fonts are metric-compatible; fontconfig maps the names).
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
# openssl must be present when `prisma generate` runs, or Prisma picks the
# openssl-1.1 engine and the client fails to start on bookworm (OpenSSL 3).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx prisma generate && npm run build

FROM base AS production
ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium poppler-utils fontconfig fonts-liberation fonts-dejavu-core tini \
 && rm -rf /var/lib/apt/lists/*
# Map the Windows font names used by the templates onto Liberation.
COPY deploy/fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
# scripts/ + src/ stay available so seeds/import tools run in-container via `npx tsx scripts/...`
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY prisma ./prisma
COPY package.json deploy/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
CMD ["api"]
