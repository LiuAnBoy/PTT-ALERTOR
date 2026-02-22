# PTT Alertor — Crawler Service

定時爬取 [PTT](https://www.ptt.cc) 看板文章，比對使用者訂閱的關鍵字，透過 Telegram Bot 即時推播通知。

## Features

- **定時爬取** — 每分鐘抓取所有訂閱看板的最新文章
- **關鍵字比對** — 支援純文字（不分大小寫）和正則表達式
- **即時推播** — 透過 Telegram Bot 推送通知，速率限制 30 msg/s
- **多關鍵字訂閱** — 用 `&` 一次新增多個關鍵字
- **自動清理** — 過期文章和 log 自動清除
- **錯誤告警** — FATAL/ERROR 自動推送給 admin

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 + TypeScript |
| Web Framework | Express 5 |
| Database | PostgreSQL 17 (Prisma ORM v7) |
| Cache & Queue | Redis 7 (ioredis) + BullMQ |
| Bot | Telegram (grammy) |
| HTML Parsing | cheerio |
| Testing | Jest 30 + ts-jest |
| Containerization | Docker (multi-stage build) |

## Quick Start

```bash
# 1. Clone & install
git clone <repo-url>
cd crawler_service
pnpm install

# 2. Setup environment
cp .env.example .env
# Edit .env: fill in TELEGRAM_TOKEN (required)

# 3. Start infrastructure
pnpm docker:up

# 4. Database setup
npx prisma migrate dev
npx prisma generate

# 5. Start development server
pnpm server
```

Or use the deploy script:

```bash
./deploy.sh init    # First-time setup (Docker + DB + migrations)
pnpm server         # Start dev server
```

## Usage (Telegram Bot)

| Command | Description | Example |
|---------|-------------|---------|
| `/start` | 註冊帳號 | `/start` |
| 新增 | 新增訂閱 | `新增 Gossiping 問卦` |
| 刪除 | 刪除訂閱 | `刪除 Gossiping 問卦` |
| 清單 | 查看訂閱 | `清單` |
| 幫助 | 使用說明 | `幫助` |

### Advanced

```
# 多關鍵字（& 分隔）
新增 Gossiping 問卦&爆卦&閒聊

# 正則表達式（regexp: 前綴）
新增 Stock regexp:台積電.*\d+
新增 NBA regexp:^(LBJ|Curry)
```

## Architecture

```
Scheduler (1 min)
  └── dispatchWorker: 讀取訂閱看板 → 派發 crawler jobs
        └── crawlerWorker: 爬取 HTML → 過濾新文章 → 儲存 DB/Redis
              └── matcherWorker: 比對關鍵字 → 找出匹配
                    └── notifierWorker: Telegram 推播（30 msg/s rate limit）
```

```
[PostgreSQL] ◄──── source of truth (users, subscriptions, articles)
     │
     │ startup sync
     ▼
  [Redis] ◄──── read cache (subscriptions) + article ZSET + BullMQ queues
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm server` | Dev server (nodemon + tsx, hot reload) |
| `pnpm build` | TypeScript compile |
| `pnpm start` | Production start |
| `pnpm test:unit` | Unit tests (~101 cases) |
| `pnpm test:integration` | Integration tests (requires DB/Redis) |
| `pnpm test:cov` | Coverage report |
| `pnpm lint` | ESLint |
| `pnpm lint:fix` | ESLint auto-fix |
| `pnpm format` | Prettier |
| `pnpm docker:up` | Start dev PostgreSQL + Redis |
| `pnpm docker:down` | Stop dev infrastructure |

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | 系統架構、模組結構、設計決策 |
| [Crawling Flow](docs/crawling-flow.md) | 爬蟲流程、HTML 解析規則、文章快取 |
| [Matching Flow](docs/matching-flow.md) | 關鍵字比對演算法、Redis 資料結構 |
| [Notification Flow](docs/notification-flow.md) | 推播流程、速率限制、錯誤處理 |
| [Subscription Sync](docs/subscription-sync.md) | DB ↔ Redis 同步機制、cascading cleanup |
| [Bot Commands](docs/bot-commands.md) | Telegram Bot 指令一覽、routing 邏輯 |
| [Maintenance](docs/maintenance.md) | 清理策略、文章生命週期、錯誤告警機制 |
| [Testing](docs/testing.md) | 測試策略、mock 架構、test commands |
| [Deployment](docs/deployment.md) | Docker 部署、環境變數、啟動/關機流程 |

## Environment Variables

複製 [`.env.example`](.env.example) 後填入對應值：

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **Server** ||||
| `NODE_ENV` | No | `development` | `production` 使用 JSON log 格式 |
| `PORT` | No | `8000` | HTTP server port |
| **PostgreSQL** ||||
| `POSTGRES_USER` | Yes | `admin` | DB 使用者 |
| `POSTGRES_PASSWORD` | Yes | — | DB 密碼 |
| `POSTGRES_HOST` | Yes | `localhost` | DB host（Docker 內用 `postgres`） |
| `POSTGRES_PORT` | No | `5432` | DB port |
| `POSTGRES_DATABASE` | Yes | `ptt-alert` | DB 名稱 |
| `DATABASE_URL` | No | auto | 覆蓋完整連線字串 |
| **Redis** ||||
| `REDIS_HOST` | Yes | `localhost` | Redis host（Docker 內用 `redis`） |
| `REDIS_PORT` | No | `6379` | Redis port |
| **Telegram** ||||
| `TELEGRAM_TOKEN` | Yes | — | Bot token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `TELEGRAM_BOT_USERNAME` | No | — | Bot username |
| `TELEGRAM_WEBHOOK_URL` | Production | — | Public URL，Telegram 會將 update POST 到此 |
| `TELEGRAM_WEBHOOK_SECRET` | No | — | Webhook 驗證用 secret |
| `ADMIN_TELEGRAM_ID` | No | — | Admin chat ID，接收 FATAL/ERROR 告警 |

## Deployment

### Development

```bash
# 啟動 PostgreSQL + Redis (Docker)
pnpm docker:up

# Database migration
npx prisma migrate dev
npx prisma generate

# Dev server (hot reload)
pnpm server
```

### Production (Docker Compose)

```bash
# 設定環境變數
cp .env.example .env
vim .env  # 填入 production 值

# 一鍵啟動（app + PostgreSQL + Redis）
docker compose up -d

# 查看狀態
docker compose ps

# 查看 logs
docker compose logs -f app
```

`docker-compose.yml` 包含 health check，app 會等 PostgreSQL 和 Redis 都 ready 才啟動。

### deploy.sh

```bash
./deploy.sh init      # 首次設定：啟動 Docker → 建立 DB → 執行 migration
./deploy.sh migrate   # 執行 Prisma migration
./deploy.sh update    # git pull → 自動檢查 migration → rebuild → restart
./deploy.sh stop      # 停止所有服務
./deploy.sh status    # 查看服務狀態
```

### Startup Sequence

```
1. 印出設定（mask 敏感值）
2. 連接 PostgreSQL
3. 連接 Redis（flushall 清除舊資料）
4. 同步訂閱資料 DB → Redis
5. 啟動 BullMQ scheduler（crawl 1m / update 15m / cleanup 1h）
6. 註冊 Telegram webhook
7. 啟動 HTTP server
```

### Graceful Shutdown

收到 `SIGTERM` / `SIGINT` 後依序關閉：

```
Bot webhook → Workers → Scheduler → HTTP server → Redis → PostgreSQL
```

10 秒 timeout 後強制退出。

> 詳細部署文件請參考 [docs/deployment.md](docs/deployment.md)

## Project Structure

```
src/
├── core/               # Config, logger, prisma, redis, queue, maintenance
├── modules/
│   ├── board/          # Crawling, parsing, caching, article repository
│   ├── subscription/   # Keyword matching, regex cache
│   ├── notification/   # Telegram push notifications
│   └── user/           # Bot handlers, user/channel/subscription repos, sync
├── middlewares/         # Express error handler
├── types/              # Shared type definitions
├── app.ts              # Express app
└── server.ts           # Bootstrap entry point
```

## License

ISC
