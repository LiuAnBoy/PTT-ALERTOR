# Crawler Service — AI Agent Guide

> 專案全貌、部署方式、環境變數、架構圖等請參考 [README.md](README.md)。
> 詳細流程文件在 [docs/](docs/) 目錄。

## What is this?

PTT Alertor 的爬蟲微服務。定時爬取 PTT 看板文章，比對使用者訂閱的關鍵字，透過 Telegram 推播通知。

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
├── core/               # Shared infra (config, logger, redis, prisma, queue, maintenance, alertAggregator, circuitBreaker, roundTracker)
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
│   │   ├── types.ts        # CommandContext, PlatformAdapter, CommandResult
│   │   ├── registry.ts     # Platform adapter registry
│   │   ├── commandHandler.ts # Shared command logic (platform-agnostic)
│   │   └── channels/       # One file per platform
│   │       └── telegram.ts # Telegram: bot + receive + send + format
│   ├── notification/   # Push notification dispatch
│   │   ├── services/       # notifierService (multi-platform via adapter)
│   │   └── workers/        # notifierWorker
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
```

- **PostgreSQL**: source of truth (users, subscriptions, articles)
- **Redis**: read cache (subscriptions) + article tracking + BullMQ queues
- **CircuitBreaker**: PTT 故障時熔斷（CLOSED → OPEN → HALF_OPEN → CLOSED）
- **AlertAggregator**: 錯誤告警聚合，避免通知轟炸（NORMAL → ALERTING → NORMAL）
- Startup 時 `syncSubscriptions()` 載入訂閱，`seedArticleCache()` 從 DB 回填 24h 內文章至 Redis
- 爬蟲和比對在 hot path 中完全從 Redis 讀取，零 DB 查詢

### Redis Key Patterns

| Key | Type | Purpose |
|-----|------|---------|
| `boards` | SET | All subscribed board names |
| `keyword:{board}:subs` | SET | User IDs subscribed to a board |
| `user:{userId}:board:{board}` | SET | User's keywords for a board |
| `board:latest` | HASH | Latest article timestamp per board (field=board) |
| `active:articles` | ZSET | Active articles in 24h window (score=timestamp, member=`{board}:{code}`) |
| `bull:{queue}:*` | mixed | BullMQ jobs/state — completed/failed pruned by `removeOnComplete`/`removeOnFail` (see `docs/maintenance.md`) |

App db is configurable via `REDIS_DB` env var (default 0). On startup `flushdb` (NOT `flushall`) clears only this db so other services on the same Redis instance are not affected.

### Database Schema

5 models: `User`, `Channel`, `Subscription`, `Article`, `CrawlerLog`. See `prisma/schema.prisma`.

## Development Commands

```bash
pnpm server              # Dev server (nodemon + tsx, hot reload)
pnpm build               # TypeScript compile
pnpm start               # Production start
pnpm test:unit           # Unit tests only (*.unit.test.ts, ~117 cases)
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
| [README.md](README.md) | 專案全貌、Quick Start、部署、環境變數 |
| [docs/architecture.md](docs/architecture.md) | 系統架構、模組結構、設計決策 |
| [docs/crawling-flow.md](docs/crawling-flow.md) | 爬蟲流程、HTML 解析規則、文章快取 |
| [docs/matching-flow.md](docs/matching-flow.md) | 關鍵字比對演算法、Redis 資料結構 |
| [docs/notification-flow.md](docs/notification-flow.md) | 推播流程、速率限制、錯誤處理 |
| [docs/subscription-sync.md](docs/subscription-sync.md) | DB ↔ Redis 同步、cascading cleanup |
| [docs/bot-commands.md](docs/bot-commands.md) | Telegram Bot 指令、routing 邏輯 |
| [docs/maintenance.md](docs/maintenance.md) | 清理策略、文章生命週期、錯誤告警 |
| [docs/testing.md](docs/testing.md) | 測試策略、mock 架構 |
| [docs/deployment.md](docs/deployment.md) | Docker 部署、啟動/關機流程 |
