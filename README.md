# PTT Alertor — Crawler Service

定時爬取 [PTT](https://www.ptt.cc) 看板文章，比對使用者訂閱的關鍵字，透過 Telegram Bot 即時推播通知。

## Features

- **定時爬取** — 每分鐘抓取所有訂閱看板的最新文章
- **關鍵字比對** — 所有關鍵字統一以正則表達式匹配（不分大小寫），無效 regex 自動視為純文字
- **即時推播** — 透過 Telegram Bot 推送通知，速率限制 30 msg/s
- **AND 複合關鍵字** — 用 `&` 串接，標題需同時命中所有子關鍵字才推播
- **看板熱門關鍵字** — `熱門 [看板]` 查詢該看板被訂閱的關鍵字排行
- **一鍵寄信給作者** — 通知上的按鈕用你綁定的 PTT 副帳號寄站內信給文章作者（選用，見 [PTT 寄信功能與帳密聲明](#ptt-寄信功能與帳密聲明)）
- **自動清理** — 過期文章和 log 自動清除
- **錯誤告警** — FATAL/ERROR 自動推送給 admin，可透過 `/errors` 查看。設定 `SERVICE_KEY` 時告警送到 Service Manager 的 `system_admin` 管理頻道，未設定或該次發送失敗時改送 `ADMIN_TELEGRAM_ID` 的 Telegram 聊天室

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
| [pnpm](https://pnpm.io/) | 10.32.1 (pinned via `packageManager`) | `corepack enable`（會自動使用 `package.json` 內 pinned 版本） |
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
| 綁定PTT | 綁定寄信用的 PTT 副帳號（僅限私訊，需啟用寄信功能） | `綁定PTT` |
| 解除PTT | 刪除已儲存的 PTT 帳號與密碼 | `解除PTT` |
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

## PTT 寄信功能與帳密聲明

收到通知後，想直接回信給賣家或作者時，可以在通知上按一顆按鈕，由伺服器用**你自己綁定的 PTT 帳號**從 PTT 主選單寄一封站內信（`M` → `S`）給文章作者，信件主旨是 `Re: <文章標題>`。這項功能是選用的：沒有同時設定 `PTT_ENCRYPT_KEY` 與 `TELEGRAM_WEBHOOK_SECRET` 時整個功能關閉，通知不會出現按鈕，除「解除PTT」外的寄信指令（`綁定PTT`、設定回信內容）都會回覆「寄信功能目前未啟用」。「解除PTT」在功能關閉時仍可使用，讓已儲存的帳號與密碼隨時可以刪除。

### 帳密聲明

要寄信就必須交出 PTT 密碼，請先了解它如何被處理：

- 密碼以 AES-256-GCM 加密後儲存在資料庫，只在寄信（或驗證登入）的當下於記憶體中解密，不會寫入記錄檔。
- 伺服器管理者持有加密金鑰，**在技術上仍然可以解密這份密碼**。
- 請使用專門寄信的 PTT 副帳號，**不要使用你的主要帳號**。
- 輸入「解除PTT」會立刻刪除已儲存的帳號與密碼。

綁定時機器人會先顯示同樣的聲明，內容與程式中的 `PTT_DISCLAIMER`（`commandHandler.ts`）一致。你傳給機器人的密碼訊息會在讀取後立刻被刪除；如果機器人無法刪除，會請你手動刪除。

### 使用方式

1. **綁定 PTT 帳號** — 在與機器人的私訊中輸入 `綁定PTT`，依序輸入 PTT 帳號與密碼。機器人回覆「驗證中…」，登入驗證在背景執行，成功後通知你已綁定；密碼錯誤、兩步驟驗證帳號（不支援）、帳號有未完成的文章草稿或連線失敗會說明原因。群組中不能綁定。
2. **設定回信內容** — 輸入 `新增 [看板] [關鍵字]` 後，回覆下方的設定卡按鈕；或輸入 `清單`，按訂閱旁的 `⚙️` 按鈕。設定卡可以設定回信內容（最多 2000 字）、切換是否附上原文（預設關閉，開啟時信件內文接著以 PTT 引文格式 `※ 引述《作者》之銘言：` 引述整篇文章）、清除回信內容。
3. **按通知上的按鈕** — 訂閱有回信內容、帳號已綁定、文章有作者時，通知底下會出現 `✉️ 寄信給 <作者>`。按一下就寄出，沒有預覽步驟。只有收到這則通知的使用者按得動它。同一篇文章符合你的多個關鍵字時，只有最先建立請求的那個關鍵字的通知帶按鈕，信件內容也用那個關鍵字的回信內容。
4. **看結果** — 結果會以回覆的方式出現在原通知底下，通知本文不變。

### 寄信結果

| 結果 | 意義 | 接下來 |
|------|------|--------|
| SENT | 已確認寄出，訊息「已寄給 <作者>」 | 同一篇文章不會再出現按鈕 |
| FAILED | 確定沒有寄出（例如連線逾時、找不到收件人、PTT 忙碌、帳號有未完成的文章草稿、帳號同時登入的連線太多、PTT 暫停了這個帳號的登入） | 訊息附「再試一次」按鈕，可以重按 |
| UNKNOWN | 存檔之後無法確認信是否寄出 | 請到 PTT 信箱的寄件備份確認；為避免重複寄信，不會自動重試也不再提供按鈕 |

PTT 密碼錯誤時帳號會被標記為失效，之後不再提供按鈕，也不會再用這組密碼登入（避免帳號被鎖），請重新 `綁定PTT`。

登入時若 PTT 提示有未完成的文章草稿，機器人不會替你選擇保留或丟棄，而是停止並請你先登入 PTT 一次，完成或放棄該草稿後再試；你的草稿不會被動到。

登入時若 PTT 問「是否刪除其他重複登入的連線」，機器人一律回答否，不會把你在別處的 PTT 連線踢下線。這個帳號已經有 3 個以上連線時，PTT 會直接拒絕登入，機器人會回報「同時登入的連線太多」，請先登出其中幾個連線再重按。

PTT 的 DDoS/BOT 偵測系統會暫停短時間內反覆登入的帳號（約 5 分鐘，持續重連會延長到最長 12 小時）。遇到暫停時機器人會回報原因，並在 10 分鐘內不再用這個帳號登入。

### 次數限制

- 每位使用者每天（台北時間）最多領取 `MAIL_DAILY_LIMIT` 個不同的寄信請求，預設 20；計的是今天被領取過的不同請求，不論之後成功或失敗。重按一個今天已經計入的失敗請求不會被每日上限擋下。
- 同一篇文章最多嘗試 3 次，用完後不再提供按鈕；重試次數由這個上限限制。
- 同一篇文章對同一位使用者最多寄出一次；連按兩次只有第一次會被受理。
- 同一個 PTT 帳號每 3 分鐘最多登入一次。連續按好幾封時，信會排隊、每 3 分鐘寄出一封，等待期間按鈕顯示「⏳ 寄送中…」；綁定時的驗證登入也算在內。

### 啟用寄信功能

在 `.env` 設定下列三個變數，缺一則功能關閉（變數說明見下方 [Environment Variables](#environment-variables)）：

```bash
PTT_ENCRYPT_KEY=$(openssl rand -base64 32)        # 加密儲存的 PTT 密碼；更換後既有密碼無法解密，使用者需重新綁定
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)   # 驗證 Telegram webhook 來源
MAIL_DAILY_LIMIT=20                               # 選用
```

流程、狀態與失敗處理見 [docs/mail-flow.md](docs/mail-flow.md)。

## Architecture

```
Scheduler (1 min)
  └── dispatchWorker: 讀取訂閱看板 → 派發 crawler jobs
        └── crawlerWorker: 爬取 HTML → 過濾新文章 → 儲存 DB/Redis
              └── matcherWorker: 比對關鍵字 → 找出匹配
                    └── notifierWorker: Telegram 推播（30 msg/s rate limit）

mail-queue（寄信按鈕與綁定 PTT 帳號觸發）
  └── mailWorker: 登入 PTT 終端機 → 寄站內信 / 驗證帳號 → 回報結果
```

```
[PostgreSQL] ◄──── source of truth (users, subscriptions, articles, PTT accounts, mail requests)
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
| `pnpm test:unit` | 單元測試 (478 個案例) |
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
| [通知流程 (Notification Flow)](docs/notification-flow.md) | 推播流程、速率限制、寄信按鈕、錯誤處理 |
| [寄信流程 (Mail Flow)](docs/mail-flow.md) | 寄信請求、狀態、mail-queue、失敗處理 |
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
| `REDIS_DB` | No | `0` | Redis db index (0–15)，當共用 Redis instance 時用來隔離不同服務 |
| **Telegram** ||||
| `TELEGRAM_TOKEN` | Yes | — | Bot token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `TELEGRAM_BOT_USERNAME` | Yes | — | Bot username |
| `TELEGRAM_WEBHOOK_URL` | Yes | — | Public URL，Telegram 會將 update POST 到此 |
| `TELEGRAM_WEBHOOK_SECRET` | No | — | Webhook 驗證密鑰，`openssl rand -hex 32` 產生；只能含 `A-Z a-z 0-9 _ -`、最長 256 字元，否則啟動失敗。設定後沒帶正確 header 的請求一律拒絕。**PTT 寄信功能需要它與 `PTT_ENCRYPT_KEY` 同時設定** |
| `ADMIN_TELEGRAM_ID` | No | — | 你的 chat ID：未設定 `SERVICE_KEY` 時，FATAL/ERROR 告警直接送到這裡；設定 `SERVICE_KEY` 時作為 Service Manager 發送失敗的備援 |
| **管理員告警（Service Manager）** ||||
| `SERVICE_KEY` | No | — | 本服務在 Service Manager 的 bearer key（機密，不進 log）。設定後告警送到 notify_service 的管理頻道；未設定則走 `ADMIN_TELEGRAM_ID` |
| `NOTIFY_SERVICE_URL` | No | `http://127.0.0.1:5000` | notify_service 位址（容器以 `network_mode: host` 連到主機的 5000 埠） |
| `NOTIFY_ADMIN_CHANNEL` | No | `system_admin` | 接收告警的管理頻道 slug |
| **PTT 寄信** ||||
| `PTT_ENCRYPT_KEY` | No | — | 加密 PTT 密碼的金鑰：恰好 32 bytes 的 base64，`openssl rand -base64 32` 產生；設定但長度不對則啟動失敗。**未設定（或缺 `TELEGRAM_WEBHOOK_SECRET`）時寄信功能關閉** |
| `MAIL_DAILY_LIMIT` | No | `20` | 每位使用者每天（台北時間）可領取的不同寄信請求數；重按今天已計入的失敗請求不受此限，重試次數由每篇文章 3 次的上限限制 |

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
3. 連接 Redis（flushdb 清除本服務 db 的舊資料；預設 db0）
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
├── core/               # 設定、日誌、加解密、Prisma、Redis、隊列、維護任務
├── modules/
│   ├── board/          # 爬蟲、解析、快取、文章儲存庫
│   │   └── tests/     # 單元測試 + 整合測試
│   ├── broadcast/      # 多平台指令與通知層
│   │   ├── commandHandler.ts   # 共享指令邏輯 (與平台無關)
│   │   ├── pendingState.ts     # 多步驟輸入狀態 (Redis)
│   │   ├── registry.ts         # 平台適配器註冊表
│   │   ├── types.ts            # CommandContext, PlatformAdapter 等
│   │   ├── channels/
│   │   │   └── telegram.ts     # Telegram：接收 + 發送 + 格式化 + 按鈕 callback
│   │   └── tests/     # 單元測試
│   ├── subscription/   # 關鍵字比對、正規表達式快取
│   │   └── tests/     # 單元測試
│   ├── notification/   # 推播通知工作器與服務
│   │   └── tests/     # 單元測試
│   ├── mail/           # 寄信給作者：PTT 終端機客戶端、寄信服務、mail-queue
│   │   └── tests/     # 單元測試 + 整合測試 + 實機測試
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
