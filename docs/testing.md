# Testing Strategy

## Overview

採用 Hybrid 測試策略：unit tests 用 `jest.mock()` 隔離外部依賴，integration tests 打真實 DB/Redis/PTT。

## Test Types

| Type | Location | 命名 | 依賴 | 數量 |
|------|----------|------|------|------|
| Unit | `modules/*/tests/`、`core/tests/` | `*.unit.test.ts` | 全部 mock | 392（20 個檔案） |
| Integration | `modules/*/tests/` | `*.test.ts`、`*.integration.test.ts` | 真實 DB/Redis/PTT | 7 個檔案 |

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
| `createMockContext(overrides?)` | grammy Context：`from`、`chat`（預設為私訊，`type: "private"`）、`message`（由 `messageText` 產生）、`callbackQuery`（由 `callbackData` 產生），以及 `reply`、`deleteMessage`、`editMessageText`、`editMessageReplyMarkup`、`answerCallbackQuery` 這幾個 `jest.fn()` |

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
import { myFunction } from "../services/myModule";
```

### 測試策略

| 策略 | 適用對象 | 範例 |
|------|---------|------|
| 直接測試純函數 | `@internal` export 的純函數 | `parsePushCount`, `escapeHtml`, `matchKeyword` |
| `jest.mock()` singleton | 有 singleton 依賴的函數 | `sendNotification` (mock prisma + adapter + mailService) |
| 不測 | thin repository wrapper | `userRepository`, `channelRepository` |
| 不測 | thin BullMQ worker | `crawlerWorker`, `notifierWorker`, `mailWorker` |

### Unit Test Files

| File | Location | Cases |
|------|----------|-------|
| `alertAggregator.unit.test.ts` | `core/tests/` | 23 |
| `circuitBreaker.unit.test.ts` | `core/tests/` | 10 |
| `config.unit.test.ts` | `core/tests/` | 5 |
| `crypto.unit.test.ts` | `core/tests/` | 5 |
| `errorClassifier.unit.test.ts` | `core/tests/` | 25 |
| `roundTracker.unit.test.ts` | `core/tests/` | 6 |
| `htmlFetcher.unit.test.ts` | `board/tests/` | 16 |
| `detailFetcher.unit.test.ts` | `board/tests/` | 11 |
| `articleCache.unit.test.ts` | `board/tests/` | 19 |
| `crawlerService.unit.test.ts` | `board/tests/` | 8 |
| `scheduler.unit.test.ts` | `board/tests/` | 5 |
| `regexCache.unit.test.ts` | `subscription/tests/` | 8 |
| `matcherService.unit.test.ts` | `subscription/tests/` | 16 |
| `notifierService.unit.test.ts` | `notification/tests/` | 20 |
| `errorLogger.unit.test.ts` | `user/tests/` | 11 |
| `syncService.unit.test.ts` | `user/tests/` | 12 |
| `commandHandler.unit.test.ts` | `broadcast/tests/` | 65 |
| `telegram.unit.test.ts` | `broadcast/tests/` | 39 |
| `mailService.unit.test.ts` | `mail/tests/` | 33 |
| `pttTerminal.unit.test.ts` | `mail/tests/` | 55 |

寄信功能相關測試的重點：

- `notifierService.unit.test.ts`：只有 `offerMail` 回傳 id 時 adapter 才收到按鈕；`offerMail` 丟錯誤時通知照常發送；訊息參考以 `setMessageRef` 存下，存失敗不影響通知。
- `telegram.unit.test.ts`：`sendNotification` 把按鈕轉成 inline keyboard 並回傳訊息參考；`updateMessage` 保留原本文、換按鈕並以回覆回報狀態，容忍 `message is not modified` / `message to edit not found`；`mail:<id>` 由非擁有者按下被拒絕且訊息不變；連按兩次只有第一次換成「⏳ 寄送中…」；`mail:noop` 只回應；Webhook secret 與密碼不進 log。
- `mailService.unit.test.ts`：組信、claim 結果、狀態轉換、密碼不進 log。`pttTerminal.unit.test.ts`：登入與寄信的畫面狀態機、編碼與截斷。

## Integration Tests

位於各模組的 `tests/`，需要真實基礎設施：

```bash
# 執行 migration
npx prisma migrate dev

# 跑整合測試
pnpm test:integration
```

| File | Location | 測試內容 |
|------|----------|---------|
| `htmlFetcher.test.ts` | `board/tests/` | 真實 PTT HTTP 請求 |
| `detailFetcher.test.ts` | `board/tests/` | 真實文章頁面解析 |
| `crawlerService.test.ts` | `board/tests/` | 完整 crawl 流程（DB + Redis + PTT） |
| `fullCrawl.test.ts` | `board/tests/` | 抓取看板列表與每篇文章詳情並印出結果 |
| `worker.test.ts` | `board/tests/` | BullMQ worker 端對端 |
| `mailRequestRepository.integration.test.ts` | `mail/tests/` | 真實 Postgres：兩個並發 claim 只有一個成功、不同請求的並發 claim 止於每日上限 |
| `pttTerminal.test.ts` | `mail/tests/` | 真實 PTT 登入並寄信給測試帳號自己；只在 `PTT_LIVE=1` 且設定 `PTT_TEST_ID`、`PTT_TEST_PASSWORD` 時執行，否則整個跳過 |

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
