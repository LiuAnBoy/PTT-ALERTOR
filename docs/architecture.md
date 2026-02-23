# Architecture Overview

## System Architecture

```
                          ┌──────────────┐
                          │   Telegram   │
                          │   Bot API    │
                          └──────┬───────┘
                                 │ webhook
                          ┌──────▼───────┐
                          │   Express    │
                          │   Server     │
                          │  (port 8000) │
                          └──────┬───────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
     ┌────────▼────────┐  ┌─────▼──────┐  ┌────────▼────────┐
     │   Broadcast     │  │  Health     │  │  Error          │
     │  (platform      │  │  Check API  │  │  Middleware      │
     │   adapters)     │  └────────────┘  └─────────────────┘
     └────────┬────────┘
              │
              │ CommandContext → commandHandler → CommandResult
              ▼
     ┌─────────────────┐        ┌──────────────────┐
     │   PostgreSQL    │◄──────►│      Redis       │
     │   (Prisma ORM)  │        │   (ioredis)      │
     └────────┬────────┘        └────────┬─────────┘
              │                          │
              │      ┌───────────────────┤
              │      │                   │
     ┌────────▼──────▼───┐    ┌─────────▼──────────┐
     │    BullMQ Queue   │    │   Redis Cache       │
     │    (Job System)   │    │   (Article ZSET)    │
     └────────┬──────────┘    └────────────────────┘
              │
     ┌────────▼──────────────────────────────────┐
     │              Worker Pipeline              │
     │                                           │
     │  Scheduler ──► Dispatch ──► Crawler       │
     │                               │           │
     │                          Matcher          │
     │                               │           │
     │                          Notifier         │
     └───────────────────────────────────────────┘
```

## Module Structure

```
src/
├── core/                     # Shared infrastructure
│   ├── config.ts             # Centralized env config (dotenv)
│   ├── logger.ts             # Pino logger with aligned formatting
│   ├── prisma.ts             # Prisma client singleton (lazy init via Proxy)
│   ├── redis.ts              # ioredis singleton
│   ├── queue.ts              # BullMQ shared connection config
│   ├── maintenance.ts        # Cleanup tasks (articles, logs, cache)
│   ├── bigint.ts             # BigInt JSON serialization polyfill
│   ├── dayjs.ts              # dayjs instance
│   ├── startupLogger.ts      # Startup config logging
│   ├── errors/AppError.ts    # Custom error class
│   └── base/BaseModule.ts    # Abstract singleton base
│
├── modules/
│   ├── board/                # Article crawling & caching
│   │   ├── services/
│   │   │   ├── pttClient.ts        # Axios instance for PTT
│   │   │   ├── htmlFetcher.ts      # HTML scraping (board list page)
│   │   │   ├── detailFetcher.ts    # Article detail page parsing
│   │   │   ├── articleCache.ts     # Redis ZSET article cache
│   │   │   └── crawlerService.ts   # Orchestrator (fetch → filter → save → dispatch)
│   │   ├── repositories/
│   │   │   └── articleRepository.ts
│   │   ├── workers/
│   │   │   ├── scheduler.ts        # Repeatable job schedulers
│   │   │   ├── dispatchWorker.ts   # Reads boards → dispatches crawler jobs
│   │   │   ├── crawlerWorker.ts    # Processes crawler jobs (concurrency: 5)
│   │   │   ├── updateWorker.ts     # Refreshes active article details
│   │   │   └── maintenanceWorker.ts
│   │   └── types/article.ts
│   │
│   ├── subscription/         # Keyword matching
│   │   ├── services/
│   │   │   ├── matcherService.ts   # Title vs keyword matching (plain + regex)
│   │   │   └── regexCache.ts       # In-memory regex compilation cache
│   │   └── workers/
│   │       └── matcherWorker.ts    # Processes match jobs (concurrency: 5)
│   │
│   ├── broadcast/            # Multi-platform command & notification
│   │   ├── types.ts               # CommandContext, PlatformAdapter, CommandResult
│   │   ├── registry.ts            # Platform adapter registry
│   │   ├── commandHandler.ts      # Shared command logic (platform-agnostic)
│   │   └── channels/
│   │       └── telegram.ts        # Telegram: bot setup + receive + send + format
│   │
│   ├── notification/         # Push notification dispatch
│   │   ├── services/
│   │   │   └── notifierService.ts  # Multi-platform notification via adapter registry
│   │   └── workers/
│   │       └── notifierWorker.ts   # Rate-limited sender (30 msg/s)
│   │
│   └── user/                 # User management
│       ├── repositories/
│       │   ├── userRepository.ts
│       │   ├── channelRepository.ts
│       │   └── subscriptionRepository.ts
│       └── services/
│           ├── syncService.ts      # DB → Redis subscription sync
│           ├── boardValidator.ts   # PTT board existence check
│           └── errorLogger.ts      # DB error logging + admin alerts
│
├── middlewares/
│   └── errorHandler.ts       # Express error middleware
├── types/                    # Shared types
├── app.ts                    # Express app setup
└── server.ts                 # Bootstrap entry point
```

## Design Decisions

### Platform Adapter Pattern
- `broadcast/` module abstracts all platform-specific logic behind `PlatformAdapter` interface
- Each platform is a single file in `channels/` (e.g., `telegram.ts`)
- Platform handles: receiving messages → `CommandContext`, sending via platform API
- Shared `commandHandler.ts` processes all commands, returns `CommandResult`
- `notifierService.ts` dispatches to correct adapter via `getAdapter(channel.platform)`
- To add a new platform: create `channels/<platform>.ts`, implement `PlatformAdapter`, auto-registers on import

### Singleton Pattern
- `redis`, `prisma` (Proxy), `bot` (lazy `getBot()`) are all singletons
- Enables `jest.mock()` to swap out entire modules in unit tests

### Repository Layer
- Thin Prisma wrappers with no business logic
- Not unit tested — tested implicitly via integration tests

### Service Layer
- Contains all business logic
- Pure functions exported with `@internal` for direct unit testing
- Async functions tested with `jest.mock()` on their dependencies

### Worker Layer
- Thin BullMQ wrappers that call services
- Not unit tested — the service layer covers the logic

### Redis as Read Cache
- All subscription data synced from PostgreSQL to Redis on startup
- Crawler and matcher read exclusively from Redis (zero DB queries in hot path)
- Writes go to both PostgreSQL (source of truth) and Redis (real-time sync)
