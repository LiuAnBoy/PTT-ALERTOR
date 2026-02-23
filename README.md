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

## Prerequisites

| Tool | Version | 安裝方式 |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | 22+ | `brew install node` / [官方下載](https://nodejs.org/) |
| [pnpm](https://pnpm.io/) | 9+ | `corepack enable && corepack prepare pnpm@latest --activate` |
| [Docker](https://www.docker.com/) | 24+ | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Telegram Bot Token | — | 從 [@BotFather](https://t.me/BotFather) 取得（見下方說明） |

### 建立 Telegram Bot

1. 在 Telegram 搜尋 [@BotFather](https://t.me/BotFather) 並開始對話
2. 輸入 `/newbot`，依照指示設定 Bot 名稱和 username
3. BotFather 會回覆一組 **Bot Token**（格式如 `123456:ABC-DEF...`），記下備用
4. （選用）輸入 `/setcommands` 設定 Bot 指令選單

## Quick Start（首次部署）

### 方法一：deploy.sh（推薦）

```bash
# 1. Clone & install
git clone <repo-url>
cd crawler_service
pnpm install

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env，填入 TELEGRAM_TOKEN（必填）

# 3. 一鍵初始化（啟動 Docker → 建立 DB → 執行 migration）
./deploy.sh init

# 4. 啟動開發伺服器
pnpm server
```

### 方法二：手動步驟

```bash
# 1. Clone & install
git clone <repo-url>
cd crawler_service
pnpm install

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env，填入 TELEGRAM_TOKEN（必填）

# 3. 啟動 PostgreSQL + Redis
pnpm docker:up

# 4. 等待服務就緒後，執行 DB migration
npx prisma migrate dev
npx prisma generate

# 5. 啟動開發伺服器
pnpm server
```

### 驗證服務是否正常

```bash
# Health check
curl http://localhost:8000/health
# 預期回應：{"status":"ok"}

# 到 Telegram 跟你的 Bot 對話，輸入 /start 註冊帳號
# 輸入「新增 Gossiping 問卦」測試訂閱功能
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
| `NODE_ENV` | No | `production` | 設為 `development` 啟用 debug log |
| `PORT` | No | `8000` | HTTP server port |
| **PostgreSQL** ||||
| `POSTGRES_USER` | Yes | — | DB 使用者 |
| `POSTGRES_PASSWORD` | Yes | — | DB 密碼 |
| `POSTGRES_HOST` | Yes | — | DB host（Docker 內用 `postgres`） |
| `POSTGRES_PORT` | No | `5432` | DB port |
| `POSTGRES_DATABASE` | Yes | — | DB 名稱 |
| **Redis** ||||
| `REDIS_HOST` | Yes | — | Redis host（Docker 內用 `redis`） |
| `REDIS_PORT` | No | `6379` | Redis port |
| **Telegram** ||||
| `TELEGRAM_TOKEN` | Yes | — | Bot token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `TELEGRAM_BOT_USERNAME` | Yes | — | Bot username |
| `TELEGRAM_WEBHOOK_URL` | Yes | — | Public URL，Telegram 會將 update POST 到此 |
| `ADMIN_TELEGRAM_ID` | No | — | 填入你的 chat ID 即可接收 FATAL/ERROR 告警 |

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

### Production（首次部署）

```bash
# 1. 準備環境變數
cp .env.example .env
vim .env
```

Production `.env` 必須設定：

```bash
NODE_ENV=production
TELEGRAM_TOKEN=<your-bot-token>
TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhook   # 公開 URL
TELEGRAM_WEBHOOK_SECRET=<random-secret>                 # webhook 驗證
POSTGRES_PASSWORD=<strong-password>                     # 強密碼
```

```bash
# 2. 一鍵啟動（app + PostgreSQL + Redis）
docker compose up -d

# 3. 確認所有服務正常
docker compose ps

# 4. 查看 app logs 確認啟動成功
docker compose logs -f server
# 預期看到：Server listening on port 8000
```

> `docker-compose.yml` 包含 health check，app 會等 PostgreSQL 和 Redis 都 ready 才啟動。

### Production（後續更新）

```bash
# 自動 git pull → 檢查 migration → rebuild → restart
./deploy.sh update
```

### deploy.sh

| 指令 | 說明 |
|------|------|
| `./deploy.sh init` | 首次設定：啟動 dev Docker → 建立 DB → 執行 migration |
| `./deploy.sh migrate` | 手動執行 Prisma migration |
| `./deploy.sh update` | git pull → 自動檢查 migration 變更 → rebuild → restart |
| `./deploy.sh stop` | 停止所有 Docker 服務 |
| `./deploy.sh status` | 查看服務狀態 |

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
│   ├── broadcast/      # Multi-platform command & notification layer
│   │   ├── commandHandler.ts   # Shared command logic (platform-agnostic)
│   │   ├── registry.ts         # Platform adapter registry
│   │   ├── types.ts            # CommandContext, PlatformAdapter, etc.
│   │   └── channels/
│   │       └── telegram.ts     # Telegram: receive + send + formatting
│   ├── subscription/   # Keyword matching, regex cache
│   ├── notification/   # Push notification worker & service
│   └── user/           # User/channel/subscription repos, sync, error logging
├── middlewares/         # Express error handler
├── types/              # Shared type definitions
├── app.ts              # Express app
└── server.ts           # Bootstrap entry point
```

### Adding a New Platform

To add a new messaging platform (e.g., Discord, LINE):

1. Add the platform to the `Platform` enum in `prisma/schema.prisma`
2. Create `src/modules/broadcast/channels/<platform>.ts` implementing `PlatformAdapter`
3. The file should handle: bot setup, receiving messages → `CommandContext`, and sending via platform API
4. Import the file in `server.ts` (side-effect import triggers auto-registration)
5. No changes needed to `commandHandler.ts`, `notifierService.ts`, or `registry.ts`

## License

ISC
