# syntax=docker/dockerfile:1

# ---------- dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- runtime ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3021 \
    HOSTNAME=0.0.0.0 \
    TRUST_PROXY=true

WORKDIR /app

# The service never writes to disk, so it runs without root privileges.
RUN addgroup -S app && adduser -S -G app app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY server ./server
COPY public ./public

USER app
EXPOSE 3021

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3021)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
