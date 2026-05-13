# Deployment

## Overview

支援 Docker Compose 部署和手動部署兩種方式。

## Docker Compose (Production)

### 服務組成

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `app` | 自建 (multi-stage) | 8000 | Node.js 應用 |
| `postgres` | postgres:17-alpine | 5432 | 資料庫 |
| `redis` | redis:7-alpine | 6379 | 快取 + 佇列 |

### 啟動

```bash
# 設定環境變數
cp .env.example .env
# 編輯 .env 填入 TELEGRAM_TOKEN 等必要值

# 啟動全部服務
docker compose up -d
```

### Health Check

PostgreSQL 和 Redis 都有 health check，app 會等待兩者都 healthy 才啟動：

```yaml
postgres:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
    interval: 5s

redis:
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
```

App 自身提供 health endpoint:
```
GET /health → { "status": "ok" }
```

## Dockerfile

Multi-stage build:

```
Stage 1: builder
  ├── pnpm install (all deps)
  ├── prisma generate
  └── tsc build

Stage 2: runner
  ├── pnpm install --prod (production deps only)
  ├── COPY dist/ from builder
  ├── COPY .prisma from builder
  └── CMD ["node", "dist/server.js"]
```

Base image: `node:22-alpine`

## deploy.sh

提供常用部署操作的 CLI：

```bash
./deploy.sh init      # 首次設定（docker-compose.dev.yml + 建立 DB + migrate）
./deploy.sh migrate   # 執行 Prisma migration
./deploy.sh update    # git pull + 檢查 migration + rebuild + restart
./deploy.sh stop      # 停止所有服務
./deploy.sh status    # 查看服務狀態
```

### init 流程

```
1. docker compose -f docker-compose.dev.yml up -d
2. sleep 5 (等待服務啟動)
3. CREATE DATABASE IF NOT EXISTS
4. prisma migrate deploy
```

### update 流程

```
1. git pull
2. 檢查是否有 migration 變更 (git diff prisma/migrations/)
   → 有 → prisma migrate deploy
3. docker compose up -d --build --remove-orphans
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `production` | Set to `development` for debug log |
| `PORT` | No | `8000` | HTTP server port |
| `POSTGRES_USER` | Yes | — | DB user |
| `POSTGRES_PASSWORD` | Yes | — | DB password |
| `POSTGRES_HOST` | Yes | — | DB host (docker: `postgres`) |
| `POSTGRES_PORT` | No | `5432` | DB port |
| `POSTGRES_DATABASE` | Yes | — | DB name |
| `REDIS_HOST` | Yes | — | Redis host (docker: `redis`) |
| `REDIS_PORT` | No | `6379` | Redis port |
| `TELEGRAM_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_BOT_USERNAME` | Yes | — | Bot username |
| `TELEGRAM_WEBHOOK_URL` | Yes | — | Public URL for webhook |
| `ADMIN_TELEGRAM_ID` | No | — | Fill in your chat ID to receive FATAL/ERROR alerts |

## Graceful Shutdown

收到 `SIGTERM` 或 `SIGINT` 時：

```
1. stopBot()            ← 移除 webhook
2. close all workers    ← 等待進行中的 job 完成
3. stopScheduler()      ← 關閉 queue
4. server.close()       ← 停止接收新請求
5. redis.quit()
6. prisma.$disconnect()
7. process.exit(0)
```

10 秒 timeout → force `process.exit(1)`。

## Startup Sequence

```
1. StartupLogger.log()     ← 印出設定（mask 敏感值）
2. connectDatabase()        ← Prisma $connect
3. connectRedis()           ← ioredis connect + flushdb（只清本服務 db，預設 db0）
4. syncSubscriptions()      ← DB → Redis full sync
5. startScheduler()         ← BullMQ repeatable jobs
6. startBot()               ← Telegram webhook registration
7. app.listen(PORT)         ← HTTP server
```
