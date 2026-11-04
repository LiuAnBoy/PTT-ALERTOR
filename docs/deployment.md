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
| `REDIS_DB` | No | `0` | Redis db index (0–15); used to isolate multiple services sharing one Redis instance |
| `TELEGRAM_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_BOT_USERNAME` | Yes | — | Bot username |
| `TELEGRAM_WEBHOOK_URL` | Yes | — | Public URL for webhook |
| `TELEGRAM_WEBHOOK_SECRET` | No | — | Webhook secret (`openssl rand -hex 32`; only `A-Z a-z 0-9 _ -`, at most 256 characters, otherwise startup throws). When set, updates without the matching header are rejected. The PTT mail feature stays off unless it and `PTT_ENCRYPT_KEY` are both set |
| `PTT_ENCRYPT_KEY` | No | — | Base64 of exactly 32 bytes (`openssl rand -base64 32`); encrypts stored PTT passwords with AES-256-GCM. Set but not 32 bytes → startup throws. Changing or losing it makes every stored password unreadable, so users must run `綁定PTT` again |
| `MAIL_DAILY_LIMIT` | No | `20` | Mail taps each user may claim per day (Asia/Taipei) |
| `ADMIN_TELEGRAM_ID` | No | — | Your chat ID: receives FATAL/ERROR alerts directly when `SERVICE_KEY` is unset, and as the fallback when the Service Manager send fails |
| `SERVICE_KEY` | No | — | This service's bearer key in Service Manager (a secret, never logged). When set, admin alerts go to the notify_service admin channel |
| `NOTIFY_SERVICE_URL` | No | `http://127.0.0.1:5000` | notify_service base URL |
| `NOTIFY_ADMIN_CHANNEL` | No | `system_admin` | Admin channel slug that receives the alerts |

PTT 寄信功能的部署注意事項：`add_ptt_mail` migration 只新增（`ptt_accounts`、`mail_requests` 兩張表與 `Subscription` 兩個欄位），`./deploy.sh update` 偵測到 migration 變更會自動執行；回滾時對資料庫執行同目錄的 `down.sql`，並刪除 `_prisma_migrations` 中該筆紀錄。寄信功能另需 server 能以 WebSocket 連到 `wss://ws.ptt.cc/bbs/`。流程見 [mail-flow.md](mail-flow.md)。

管理員告警的部署注意事項：設定 `SERVICE_KEY` 前，需在 Service Manager 後台為 `ptt_alertor` 啟用 `uses_notify` 與 `admin_notify_enabled`。App 容器以 `network_mode: host` 執行，從主機網路連 `http://127.0.0.1:5000`，因此依賴 notify_service 發布 `127.0.0.1:5000`（可用 `docker port notify_service` 確認）且 compose 保持 `network_mode: host`；任一項改變時告警會退回直送 `ADMIN_TELEGRAM_ID`，並需更新 `NOTIFY_SERVICE_URL`。未設定 `SERVICE_KEY` 時行為與先前相同。

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
