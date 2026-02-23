# ── Builder stage ──────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN pnpm run build

# ── Runner stage ──────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY prisma ./prisma

RUN npx prisma generate

ENV NODE_ENV=production

EXPOSE 9090

CMD ["node", "dist/server.js"]
