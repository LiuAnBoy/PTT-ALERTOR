# PTT Alertor — Crawler Service

定時爬取 [PTT](https://www.ptt.cc) 看板文章，比對使用者訂閱的關鍵字，透過 Telegram Bot 即時推播通知。

## Features

- **定時爬取** — 每分鐘抓取所有訂閱看板的最新文章
- **關鍵字比對** — 所有關鍵字統一以正則表達式匹配（不分大小寫），無效 regex 自動視為純文字
- **即時推播** — 透過 Telegram Bot 推送通知，速率限制 30 msg/s
- **AND 複合關鍵字** — 用 `&` 串接，標題需同時命中所有子關鍵字才推播
- **看板熱門關鍵字** — `熱門 [看板]` 查詢該看板被訂閱的關鍵字排行
- **自動清理** — 過期文章和 log 自動清除
- **錯誤告警** — FATAL/ERROR 自動推送給 admin，可透過 `/errors` 查看

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

# 3. 執行 DB migration
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
| 熱門 | 看板熱門關鍵字 | `熱門 Gamesale` |
| 幫助 | 使用說明 | `幫助` |
| `/errors` | 查看最近錯誤（Admin） | `/errors` |

### Advanced

```
# AND（標題需同時含「售」與「ps5」，視為單一訂閱）
新增 Gamesale 售&ps5

# 正則表達式（直接使用，無需前綴）
新增 Stock 台積電.*\d+
新增 NBA ^(LBJ|Curry)

# OR 用 regex 的 |
新增 Gossiping 問卦|爆卦

# 無效 regex 自動視為純文字匹配
新增 Soft_Job C++
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

## 腳本 (Scripts)

| 指令 | 說明 |
|---------|-------------|
| `pnpm server` | 開發伺服器 (nodemon + tsx, 熱重載) |
| `pnpm build` | TypeScript 編譯 |
| `pnpm start` | 生產環境啟動 |
| `pnpm test:unit` | 單元測試 (117 個案例) |
| `pnpm test:integration` | 整合測試 (需 DB/Redis) |
| `pnpm test:cov` | 測試覆蓋率報告 |
| `pnpm lint` | ESLint 檢查 |
| `pnpm lint:fix` | ESLint 自動修復 |
| `pnpm format` | Prettier 格式化 |

## 文件 (Documentation)

| 文件 | 說明 |
|----------|-------------|
| [架構設計 (Architecture)](docs/architecture.md) | 系統架構、模組結構、設計決策 |
| [爬取流程 (Crawling Flow)](docs/crawling-flow.md) | 爬蟲流程、HTML 解析規則、文章快取 |
| [比對流程 (Matching Flow)](docs/matching-flow.md) | 關鍵字比對演算法、Redis 資料結構 |
| [通知流程 (Notification Flow)](docs/notification-flow.md) | 推播流程、速率限制、錯誤處理 |
| [訂閱同步 (Subscription Sync)](docs/subscription-sync.md) | DB ↔ Redis 同步機制、連鎖清理 (cascading cleanup) |
| [機器人指令 (Bot Commands)](docs/bot-commands.md) | Telegram Bot 指令一覽、路由邏輯 |
| [維護與清理 (Maintenance)](docs/maintenance.md) | 清理策略、文章生命週期、錯誤告警機制 |
| [測試策略 (Testing)](docs/testing.md) | 測試策略、Mock 架構、測試指令 |
| [部署指南 (Deployment)](docs/deployment.md) | Docker 部署、環境變數、啟動/關機流程 |

## Developer Guide

本專案採用模組化架構，易於擴充：

- **新增平台 (Platform)**: 實作 `PlatformAdapter` 介面，參考 [docs/bot-commands.md](docs/bot-commands.md#adding-a-new-platform)。
- **新增指令 (Command)**: 修改 `commandHandler.ts` 與平台 adapter，參考 [docs/bot-commands.md](docs/bot-commands.md#adding-a-new-command)。
- **調整爬蟲邏輯**: 參考 [docs/crawling-flow.md](docs/crawling-flow.md)。

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
| `LOG_LEVEL` | No | `debug`/`info` | Log 等級（dev 預設 debug，prod 預設 info） |
| `ALLOWED_ORIGINS` | No | — | CORS 允許的 origin，逗號分隔（未設定則關閉 CORS） |
| **PostgreSQL** ||||
| `POSTGRES_USER` | Yes | — | DB 使用者 |
| `POSTGRES_PASSWORD` | Yes | — | DB 密碼 |
| `POSTGRES_HOST` | Yes | — | DB host（Docker 內用 `postgres`） |
| `POSTGRES_PORT` | No | `5432` | DB port |
| `POSTGRES_DATABASE` | Yes | — | DB 名稱 |
| `POSTGRES_POOL_SIZE` | No | `10` | DB 連線池大小 |
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

## 專案結構

```
src/
├── __mocks__/          # 共享模擬工廠 (Redis, Prisma, Bot, Context)
├── core/               # 設定、日誌、Prisma、Redis、隊列、維護任務
├── modules/
│   ├── board/          # 爬蟲、解析、快取、文章儲存庫
│   │   └── tests/     # 單元測試 + 整合測試
│   ├── broadcast/      # 多平台指令與通知層
│   │   ├── commandHandler.ts   # 共享指令邏輯 (與平台無關)
│   │   ├── registry.ts         # 平台適配器註冊表
│   │   ├── types.ts            # CommandContext, PlatformAdapter 等
│   │   ├── channels/
│   │   │   └── telegram.ts     # Telegram：接收 + 發送 + 格式化
│   │   └── tests/     # 單元測試
│   ├── subscription/   # 關鍵字比對、正規表達式快取
│   │   └── tests/     # 單元測試
│   ├── notification/   # 推播通知工作器與服務
│   │   └── tests/     # 單元測試
│   └── user/           # 使用者/頻道/訂閱儲存庫、同步、錯誤日誌
│       └── tests/     # 單元測試
├── middlewares/         # Express 錯誤處理中間件
├── types/              # 共享型別定義
├── app.ts              # Express 應用設定
└── server.ts           # 啟動引導進入點
```

### 新增平台 (Adding a New Platform)

若要新增訊息平台 (例如 Discord, LINE)：

1. 在 `prisma/schema.prisma` 的 `Platform` 列舉中加入該平台。
2. 建立 `src/modules/broadcast/channels/<platform>.ts` 並實作 `PlatformAdapter` 介面。
3. 該檔案需處理：Bot 設定、接收訊息 → 轉換為 `CommandContext`，以及透過平台 API 發送訊息。
4. 在 `server.ts` 中匯入該檔案 (副作用匯入將觸發自動註冊)。
5. 無須修改 `commandHandler.ts`、`notifierService.ts` 或 `registry.ts`。

## License

ISC
