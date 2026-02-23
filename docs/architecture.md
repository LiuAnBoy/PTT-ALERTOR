# 架構概觀

## 系統架構

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
     │  (平台適配器)    │  │  Check API  │  │  Middleware      │
     └────────┬────────┘  └────────────┘  └─────────────────┘
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
     │    (工作系統)     │    │   (文章 ZSET)       │
     └────────┬──────────┘    └────────────────────┘
              │
     ┌────────▼──────────────────────────────────┐
     │               工作管線 (Worker)           │
     │                                           │
     │  Scheduler ──► Dispatch ──► Crawler       │
     │                               │           │
     │                          Matcher          │
     │                               │           │
     │                          Notifier         │
     └───────────────────────────────────────────┘
```

## 模組結構

```
src/
├── core/                     # 共享基礎設施
│   ├── config.ts             # 集中式環境變數設定 (dotenv)
│   ├── logger.ts             # Pino 日誌器，格式統一
│   ├── prisma.ts             # Prisma client 單例 (透過 Proxy 延遲初始化)
│   ├── redis.ts              # ioredis 單例
│   ├── queue.ts              # BullMQ 共享連線設定
│   ├── maintenance.ts        # 清理任務 (文章、日誌、快取)
│   ├── bigint.ts             # BigInt JSON 序列化修正
│   ├── dayjs.ts              # dayjs 實例
│   ├── startupLogger.ts      # 啟動設定日誌
│   ├── errors/AppError.ts    # 自定義錯誤類別
│   └── base/BaseModule.ts    # 抽象單例基底
│
├── modules/
│   ├── board/                # 文章爬取與快取
│   │   ├── services/
│   │   │   ├── pttClient.ts        # PTT Axios 實例
│   │   │   ├── htmlFetcher.ts      # HTML 抓取 (看板列表頁)
│   │   │   ├── detailFetcher.ts    # 文章詳情頁解析
│   │   │   ├── articleCache.ts     # Redis ZSET 文章快取
│   │   │   └── crawlerService.ts   # 調度器 (抓取 → 過濾 → 儲存 → 派發)
│   │   ├── repositories/
│   │   │   └── articleRepository.ts
│   │   ├── workers/
│   │   │   ├── scheduler.ts        # 定時任務調度器
│   │   │   ├── dispatchWorker.ts   # 讀取看板 → 派發爬蟲任務
│   │   │   ├── crawlerWorker.ts    # 處理爬蟲任務 (併發數: 5)
│   │   │   ├── updateWorker.ts     # 重新整理活躍文章詳情
│   │   │   └── maintenanceWorker.ts
│   │   ├── tests/                  # 單元測試 + 整合測試
│   │   └── types/article.ts
│   │
│   ├── subscription/         # 關鍵字比對
│   │   ├── services/
│   │   │   ├── matcherService.ts   # 標題與關鍵字比對 (純文字 + 正則)
│   │   │   └── regexCache.ts       # 記憶體內正則編譯快取
│   │   ├── workers/
│   │   │   └── matcherWorker.ts    # 處理比對任務 (併發數: 5)
│   │   └── tests/                  # 單元測試
│   │
│   ├── broadcast/            # 多平台指令與通知
│   │   ├── types.ts               # CommandContext, PlatformAdapter, CommandResult
│   │   ├── registry.ts            # 平台適配器註冊表
│   │   ├── commandHandler.ts      # 共享指令邏輯 (平台無關)
│   │   ├── channels/
│   │   │   └── telegram.ts        # Telegram: Bot 設定 + 接收 + 發送 + 格式化
│   │   └── tests/                  # 單元測試
│   │
│   ├── notification/         # 推播通知派發
│   │   ├── services/
│   │   │   └── notifierService.ts  # 透過註冊表進行多平台通知
│   │   ├── workers/
│   │   │   └── notifierWorker.ts   # 速率限制發送器 (30 msg/s)
│   │   └── tests/                  # 單元測試
│   │
│   └── user/                 # 使用者管理
│       ├── repositories/
│       │   ├── userRepository.ts
│       │   ├── channelRepository.ts
│       │   └── subscriptionRepository.ts
│       ├── services/
│       │   ├── syncService.ts      # DB → Redis 訂閱同步
│       │   ├── boardValidator.ts   # PTT 看板存在檢查
│       │   └── errorLogger.ts      # DB 錯誤日誌 + 管理員告警
│       └── tests/                  # 單元測試
│
├── middlewares/
│   └── errorHandler.ts       # Express 錯誤處理中間件
├── types/                    # 共享型別
├── app.ts                    # Express 應用程式設定
└── server.ts                 # 啟動進入點
```

## 資料模型

### User (使用者)
| 欄位 | 型別 | 描述 |
|--------|------|-------------|
| `id` | UUID | 主鍵 |
| `enable` | Boolean | 啟用/停用通知 |
| `username` | String? | 顯示名稱 (來自首次註冊平台) |
| `email` | String? | 電子郵件 |
| `phone` | String? | 電話號碼 |
| `createdAt` | DateTime | 註冊時間 |
| `updatedAt` | DateTime | 最後更新時間 |

### Channel (頻道)
| 欄位 | 型別 | 描述 |
|--------|------|-------------|
| `id` | UUID | 主鍵 |
| `platform` | Platform | TELEGRAM, DISCORD, LINE 等 |
| `platformUserId` | String | 平台上的使用者 ID |
| `platformChatId` | String | 發送訊息用的聊天 ID |
| `rawData` | Json? | 平台原始使用者資料 (例如完整的 `ctx.from` 物件) |
| `userId` | String | 外鍵 → User |
| `createdAt` | DateTime | 建立時間 |

唯一約束：`(platform, platformUserId)`

### 多平台註冊

每個 `/start` 都會建立獨立的 User + Channel 配對。
未來計畫：提供綁定指令，將不同平台的頻道連結到單一 User。

## 設計決策

### 平台適配器模式 (Platform Adapter Pattern)
- `broadcast/` 模組將所有平台相關邏輯抽象化為 `PlatformAdapter` 介面
- 每個平台對應 `channels/` 下的一個檔案 (例如 `telegram.ts`)
- 平台負責：接收訊息 → 轉換為 `CommandContext`，透過平台 API 發送訊息
- 共享的 `commandHandler.ts` 處理所有指令並回傳 `CommandResult`
- `notifierService.ts` 透過 `getAdapter(channel.platform)` 調用正確的適配器
- 新增平台：建立 `channels/<platform>.ts`，實作 `PlatformAdapter`，匯入時自動註冊

### 單例模式 (Singleton Pattern)
- `redis`, `prisma` (Proxy), `bot` (延遲 `getBot()`) 皆為單例
- 便於 `jest.mock()` 在單元測試中替換整個模組

### 儲存庫層 (Repository Layer)
- 包裝 Prisma 的薄層，不含業務邏輯
- 不進行單元測試 — 透過整合測試進行間接測試

### 服務層 (Service Layer)
- 包含所有業務邏輯
- 匯出標註為 `@internal` 的純函數以供直接單元測試
- 非同步函數透過 `jest.mock()` 模擬其依賴項進行測試

### 工作層 (Worker Layer)
- 包裝 BullMQ 的薄層，呼叫服務層
- 不進行單元測試 — 邏輯已由服務層覆蓋

### Redis 作為讀取快取
- 啟動時將所有訂閱資料從 PostgreSQL 同步到 Redis
- 爬蟲與比對器僅從 Redis 讀取 (熱點路徑零 DB 查詢)
- 寫入時同時更新 PostgreSQL (事實來源) 與 Redis (即時同步)
