# Crawler Service — AI Agent Guide

> 專案全貌、部署方式、環境變數、架構圖等請參考 [README.md](README.md)。
> 詳細流程文件在 [docs/](docs/) 目錄。

## What is this?

PTT Alertor 的爬蟲微服務。定時爬取 PTT 看板文章，比對使用者訂閱的關鍵字，透過 Telegram 推播通知；通知上可附按鈕，用使用者綁定的 PTT 帳號寄站內信給作者。

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript (ES2022, strict mode)
- **Framework**: Express 5
- **Database**: PostgreSQL 17 (Prisma ORM v7, schema at `prisma/schema.prisma`)
- **Cache/Queue**: Redis 7 (ioredis) + BullMQ
- **Bot**: Telegram (grammy)
- **Test**: Jest 30 + ts-jest
- **Container**: Docker multi-stage build (node:22-alpine)

## Project Structure

```
src/
├── core/               # Shared infra (config, logger, redis, prisma, queue, crypto, maintenance, alertAggregator, errorClassifier, circuitBreaker, roundTracker)
├── modules/
│   ├── board/          # Article crawling & caching
│   │   ├── repositories/   # articleRepository (Prisma)
│   │   ├── services/       # htmlFetcher, detailFetcher, articleCache, crawlerService
│   │   ├── types/          # RawArticle, ArticleDetail
│   │   ├── workers/        # BullMQ workers + scheduler
│   │   └── tests/          # Integration tests (real DB/Redis/PTT)
│   ├── subscription/   # Keyword matching
│   │   ├── services/       # matcherService, regexCache
│   │   └── workers/        # matcherWorker
│   ├── broadcast/      # Multi-platform command & notification
│   │   ├── types.ts        # CommandContext, PlatformAdapter, CommandResult, ButtonRows, MessageRef
│   │   ├── registry.ts     # Platform adapter registry
│   │   ├── commandHandler.ts # Shared command logic (platform-agnostic)
│   │   ├── pendingState.ts # Multi-step input state in Redis (mail:pending:<platformUserId>)
│   │   └── channels/       # One file per platform
│   │       └── telegram.ts # Telegram: bot + receive + send + format + button callbacks
│   ├── notification/   # Push notification dispatch
│   │   ├── services/       # notifierService (multi-platform via adapter, mail button), adminNotifier (admin alerts: Service Manager, else ADMIN_TELEGRAM_ID)
│   │   └── workers/        # notifierWorker
│   ├── mail/           # Mail the article author from a notification (PTT terminal)
│   │   ├── repositories/   # mailRequestRepository, pttAccountRepository
│   │   ├── services/       # mailService, pttTerminal, loginGate (one login per PTT account per 3 min)
│   │   ├── workers/        # mailQueue, mailWorker
│   │   └── tests/          # Unit + integration + live (PTT_LIVE=1) tests
│   └── user/           # User management
│       ├── repositories/   # userRepository, channelRepository, subscriptionRepository
│       └── services/       # syncService, boardValidator, errorLogger
├── types/              # Shared types (ModuleTag, env)
├── __mocks__/          # Test mock factories (mockRedis, mockPrisma, mockBot, mockContext)
├── app.ts              # Express app setup
└── server.ts           # Bootstrap entry point
```

## Key Architecture

```
Scheduler (cron) → dispatchWorker → crawlerWorker → matcherWorker → notifierWorker
                        ↕                 ↕
                   CircuitBreaker ←── RoundTracker ──→ AlertAggregator

mail button / 綁定PTT → mail-queue → mailWorker → loginGate → PTT terminal (WebSocket)
```

- **PostgreSQL**: source of truth (users, subscriptions, articles, PTT accounts, mail requests)
- **Redis**: read cache (subscriptions) + article tracking + BullMQ queues + PTT login gate
- **CircuitBreaker**: PTT 故障時熔斷（CLOSED → OPEN → HALF_OPEN → CLOSED）
- **AlertAggregator**: 錯誤告警聚合，避免通知轟炸（NORMAL → ALERTING → NORMAL）；錯誤先經 `errorClassifier` 粗分類（5xx/4xx/逾時/解析/其他），連續 5 輪（每分鐘一輪）異常才告警，之後每 30 分鐘節流進度告警，連續 3 輪正常時送含問題分布的報告
- **Admin alerts**: 所有告警（含 FATAL）經 `adminNotifier.sendAdminAlert` 發送：設定 `SERVICE_KEY` 時送 Service Manager 的 `system_admin` 管理頻道，未設定或發送失敗時直送 `ADMIN_TELEGRAM_ID`；`SERVICE_KEY` 不進任何 log、錯誤文字或啟動日誌
- **Mail queue**: `mail-queue`（`send` 寄信、`verify` 驗證綁定）由 `mailWorker` 以併發 1、每 5 秒 1 個 job 執行，`attempts: 1` 不自動重試；`loginGate` 讓同一個 PTT 帳號每 3 分鐘最多登入一次（PTT 的 DDoS/BOT 偵測會暫停反覆登入的帳號），間隔未到的 job 以 `moveToDelayed` + `DelayedError` 延後。持久狀態只在 Postgres 的 `MailRequest`（claim 在交易內原子完成，一封信最多寄出一次），Redis 被 flush 時由啟動的 `recoverInFlight` 復原；密碼只以 AES-256-GCM 密文存放與傳遞。需同時設定 `PTT_ENCRYPT_KEY` 與 `TELEGRAM_WEBHOOK_SECRET` 才啟用。見 `docs/mail-flow.md`
- Startup 時 `syncSubscriptions()` 載入訂閱，`seedArticleCache()` 從 DB 回填各看板時間基準與 24h 內文章至 Redis
- 爬蟲和比對在 hot path 中完全從 Redis 讀取，零 DB 查詢

### Redis Key Patterns

| Key | Type | Purpose |
|-----|------|---------|
| `boards` | SET | All subscribed board names |
| `keyword:{board}:subs` | SET | User IDs subscribed to a board |
| `user:{userId}:board:{board}` | SET | User's keywords for a board |
| `board:latest` | HASH | Latest article timestamp per board (field=board) |
| `active:articles` | ZSET | Active articles in 24h window (score=timestamp, member=`{board}:{code}`) |
| `mail:pending:<platformUserId>` | STRING | Pending multi-step input (bind ID, bind password, reply text) as JSON, never the password; TTL 300s. The bind steps take every text (slash commands included) as input and end only by input, `取消` at the ID step, or the TTL; a recognised command clears only the reply-text step |
| `mail:login:<pttId lower case>` | STRING | Login gate of one PTT account: set NX with PX 180000 when a mail or verify job logs in; PX 600000 after PTT suspended the account |
| `bull:{queue}:*` | mixed | BullMQ jobs/state — finalized completed/failed records pruned by `removeOnComplete`/`removeOnFail`. Scheduler / repeatable / delayed metadata is **not** capped by retention; cleared only by startup `flushdb`. See `docs/maintenance.md`. |

App db is configurable via `REDIS_DB` env var (default 0, validated 0-15). On startup `flushdb` (NOT `flushall`) clears only this db so other services on the same Redis instance are not affected.

### Database Schema

7 models: `User`, `Channel`, `Subscription`, `Article`, `CrawlerLog`, `PttAccount`, `MailRequest`. See `prisma/schema.prisma`.

## Development Commands

```bash
pnpm server              # Dev server (nodemon + tsx, hot reload)
pnpm build               # TypeScript compile
pnpm start               # Production start
pnpm test:unit           # Unit tests only (*.unit.test.ts, ~500 cases)
pnpm test:integration    # Integration tests (requires DB/Redis)
pnpm test:cov            # Coverage report
pnpm lint                # ESLint check
pnpm lint:fix            # ESLint auto-fix
pnpm format              # Prettier format
```

## Environment & Deployment

環境變數完整列表見 [README.md#environment-variables](README.md#environment-variables)，`.env.example` 有範本。

### 必要環境變數

| Variable | Description |
|----------|-------------|
| `POSTGRES_PASSWORD` | DB 密碼 |
| `TELEGRAM_TOKEN` | Bot token（從 @BotFather 取得） |

### 部署方式

- **Development**: `npx prisma migrate dev` → `pnpm server`
- **Production**: `docker compose up -d`（含 app + PostgreSQL + Redis，health check）
- **deploy.sh**: `init` / `migrate` / `update` / `stop` / `status`

詳見 [README.md#deployment](README.md#deployment) 和 [docs/deployment.md](docs/deployment.md)。

## Code Conventions

### TypeScript

- **Strict mode** enabled, `no-explicit-any` as warning (off in test files)
- **Type imports**: use `import type { ... }` (enforced by eslint)
- **Import order**: auto-sorted by `simple-import-sort` (enforced)
- **Formatting**: Prettier — double quotes, semicolons, trailing commas, 100 print width

### Comments & Docs

- All comments in **English**
- All exported functions must have **JSDoc** with `@param` / `@returns`
- Internal exports for testing use `@internal` tag

### Module Patterns

- **Singletons**: `redis`, `prisma` (via Proxy), `bot` (via `getBot()` lazy init)
- **Repositories**: thin Prisma wrappers, no business logic — do NOT unit test
- **Services**: contain business logic, unit testable with `jest.mock()`
- **Workers**: thin BullMQ wrappers that call services — do NOT unit test

### Testing

- **Unit tests**: in `modules/*/tests/` as `*.unit.test.ts`, mock all external deps
- **Integration tests**: in `modules/*/tests/` as `*.integration.test.ts`, hit real DB/Redis/PTT
- **Mock utilities**: `src/__mocks__/` — `createMockRedis()`, `createMockPrisma()`, `createMockBot()`, `createMockContext()`
- **Mock pattern**: `jest.mock()` at file top before imports, `jest.clearAllMocks()` in `beforeEach`

詳見 [docs/testing.md](docs/testing.md)。

### Git

- Follow **Conventional Commits**: `type(scope): message`
- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`

## Documentation Index

| Document | Content |
|----------|---------|
| [README.md](README.md) | 專案全貌、Quick Start、部署、環境變數、PTT 寄信功能與帳密聲明 |
| [docs/architecture.md](docs/architecture.md) | 系統架構、模組結構、設計決策 |
| [docs/crawling-flow.md](docs/crawling-flow.md) | 爬蟲流程、HTML 解析規則、文章快取 |
| [docs/matching-flow.md](docs/matching-flow.md) | 關鍵字比對演算法、Redis 資料結構 |
| [docs/notification-flow.md](docs/notification-flow.md) | 推播流程、速率限制、寄信按鈕、錯誤處理 |
| [docs/mail-flow.md](docs/mail-flow.md) | 寄信請求、狀態、mail-queue、啟動復原、失敗處理 |
| [docs/subscription-sync.md](docs/subscription-sync.md) | DB ↔ Redis 同步、cascading cleanup |
| [docs/bot-commands.md](docs/bot-commands.md) | Telegram Bot 指令、routing 邏輯 |
| [docs/maintenance.md](docs/maintenance.md) | 清理策略、文章生命週期、錯誤告警 |
| [docs/testing.md](docs/testing.md) | 測試策略、mock 架構 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署、啟動/關機流程 |
