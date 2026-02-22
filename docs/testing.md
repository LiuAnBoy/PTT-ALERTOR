# Testing Strategy

## Overview

採用 Hybrid 測試策略：unit tests 用 `jest.mock()` 隔離外部依賴，integration tests 打真實 DB/Redis/PTT。

## Test Types

| Type | Location | 命名 | 依賴 | 數量 |
|------|----------|------|------|------|
| Unit | co-located with source | `*.unit.test.ts` | 全部 mock | ~101 |
| Integration | `modules/*/tests/` | `*.test.ts` | 真實 DB/Redis/PTT | 4 |

## Commands

```bash
pnpm test:unit          # 只跑 unit tests
pnpm test:integration   # 只跑 integration tests
pnpm test               # 全部
pnpm test:cov           # 含覆蓋率報告
pnpm test:watch         # watch mode
```

## Unit Test 架構

### Mock 工具 (`src/__mocks__/`)

| Factory | 用途 |
|---------|------|
| `createMockRedis()` | ioredis（smembers, pipeline, zcard, etc.） |
| `createMockPrisma()` | PrismaClient（user, channel, subscription, article） |
| `createMockBot()` | grammy Bot（api.sendMessage） |
| `createMockContext()` | grammy Context（from, chat, reply, message） |

### Mock Pattern

每個 unit test 檔案開頭 mock 所有外部依賴：

```typescript
// Mock external dependencies
jest.mock("../../../core/logger", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("../../../core/redis", () => ({
  redis: createMockRedis(),
}));

// Import AFTER mocks are declared
import { myFunction } from "./myModule";
```

### 測試策略

| 策略 | 適用對象 | 範例 |
|------|---------|------|
| 直接測試純函數 | `@internal` export 的純函數 | `parsePushCount`, `escapeHtml`, `matchKeyword` |
| `jest.mock()` singleton | 有 singleton 依賴的函數 | `sendNotification` (mock prisma + bot) |
| 不測 | thin repository wrapper | `userRepository`, `channelRepository` |
| 不測 | thin BullMQ worker | `crawlerWorker`, `notifierWorker` |

### Unit Test Files

| File | Module | Cases |
|------|--------|-------|
| `regexCache.unit.test.ts` | regexCache | 5 |
| `htmlFetcher.unit.test.ts` | htmlFetcher | 16 |
| `detailFetcher.unit.test.ts` | detailFetcher | 10 |
| `notifierService.unit.test.ts` | notifierService | 17 |
| `matcherService.unit.test.ts` | matcherService | 10 |
| `articleCache.unit.test.ts` | articleCache | 9 |
| `syncService.unit.test.ts` | syncService | 11 |
| `crawlerService.unit.test.ts` | crawlerService | 8 |
| `handlers.unit.test.ts` | bot handlers | 15 |

## Integration Tests

位於 `src/modules/board/tests/`，需要真實基礎設施：

```bash
# 先啟動 PostgreSQL + Redis
pnpm docker:up

# 執行 migration
npx prisma migrate dev

# 跑整合測試
pnpm test:integration
```

| File | 測試內容 |
|------|---------|
| `htmlFetcher.test.ts` | 真實 PTT HTTP 請求 |
| `detailFetcher.test.ts` | 真實文章頁面解析 |
| `crawlerService.test.ts` | 完整 crawl 流程（DB + Redis + PTT） |
| `worker.test.ts` | BullMQ worker 端對端 |

## Configuration

### jest.config.ts

```typescript
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/*.test.ts", "**/*.spec.ts"],
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/types/**"],
};
```

### ESLint for Tests

測試檔案中 `@typescript-eslint/no-explicit-any` 設為 off，允許使用 `any` 簡化 mock 型別。
