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
     │                                           │
     │  mail-queue ──► mailWorker ──► PTT 終端機 │
     │  (寄信 send / 綁定 verify，與上方管線獨立) │
     └───────────────────────────────────────────┘
```

## 模組結構

```
src/
├── core/                     # 共享基礎設施
│   ├── config.ts             # 集中式環境變數設定 (dotenv)，含 config.mail
│   ├── crypto.ts             # AES-256-GCM 加解密 (encryptSecret / decryptSecret)
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
│   │   ├── types.ts               # CommandContext, PlatformAdapter, CommandResult, ButtonRows, MessageRef
│   │   ├── registry.ts            # 平台適配器註冊表
│   │   ├── commandHandler.ts      # 共享指令邏輯 (平台無關)
│   │   ├── pendingState.ts        # 多步驟輸入狀態 (Redis mail:pending:<platformUserId>)
│   │   ├── channels/
│   │   │   └── telegram.ts        # Telegram: Bot 設定 + 接收 + 發送 + 格式化 + callback 路由
│   │   └── tests/                  # 單元測試
│   │
│   ├── notification/         # 推播通知派發
│   │   ├── services/
│   │   │   └── notifierService.ts  # 透過註冊表進行多平台通知，附寄信按鈕
│   │   ├── workers/
│   │   │   └── notifierWorker.ts   # 速率限制發送器 (30 msg/s)
│   │   └── tests/                  # 單元測試
│   │
│   ├── mail/                 # 從通知寄 PTT 站內信給作者
│   │   ├── services/
│   │   │   ├── mailService.ts      # 資格判斷、offer、requestMail、send/verify job、啟動復原
│   │   │   └── pttTerminal.ts      # PTT 終端機客戶端 (WebSocket，登入與寄信)
│   │   ├── repositories/
│   │   │   ├── mailRequestRepository.ts  # MailRequest：offer、原子 claim、狀態轉換
│   │   │   └── pttAccountRepository.ts   # PttAccount：加密後的帳密
│   │   ├── workers/
│   │   │   ├── mailQueue.ts        # mail-queue 與 job 型別
│   │   │   └── mailWorker.ts       # 處理 send / verify job (併發數: 1)
│   │   └── tests/                  # 單元測試 + 整合測試 + 實機測試
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

### Subscription 的回信欄位
`Subscription` 另有 `replyContent String?`（寄給作者的信件內容，空表示不提供寄信按鈕）與
`replyIncludeOriginal Boolean`（預設 false，開啟時信中引述整篇原文）。

### PttAccount (PTT 帳號)
| 欄位 | 型別 | 描述 |
|--------|------|-------------|
| `id` | UUID | 主鍵 |
| `userId` | String | 外鍵 → User，唯一，刪除使用者時連帶刪除 |
| `pttId` | String | PTT 帳號 |
| `passwordEnc` | String | AES-256-GCM 密文，格式 `v1.<iv>.<tag>.<ciphertext>` |
| `invalidAt` | DateTime? | 登入時發現密碼錯誤的時間；有值時不提供寄信按鈕，需重新綁定 |
| `createdAt` / `updatedAt` | DateTime | 建立與更新時間 |

資料表 `ptt_accounts`。

### MailRequest (寄信請求)
| 欄位 | 型別 | 描述 |
|--------|------|-------------|
| `id` | UUID | 主鍵，同時是按鈕 callback 的 id |
| `userId` | String | 外鍵 → User，刪除使用者時連帶刪除 |
| `board` / `articleCode` / `author` / `title` / `keyword` | String | 通知當下的文章與命中的關鍵字 |
| `status` | MailRequestStatus | `OFFERED` → `QUEUED` → `SENDING` → `SENT` / `FAILED` / `UNKNOWN` |
| `error` | String? | 失敗原因 |
| `chatId` / `messageId` | String? | 通知訊息的位置，結果回報在這則訊息上 |
| `attempts` | Int | 已成功 claim 的次數，上限 3 |
| `queuedAt` / `finishedAt` | DateTime | 最近一次 claim 時間（每日上限的計數依據）與完成時間 |
| `createdAt` / `updatedAt` | DateTime | 建立與更新時間 |

唯一約束：`(userId, articleCode)`，同一使用者對同一篇文章最多一筆；資料表 `mail_requests`。
狀態與流程見 [mail-flow.md](mail-flow.md)。

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
- 通知可附 `ButtonRows`，`sendNotification` 回傳 `MessageRef`；`updateMessage(target, text, buttons?)` 保留原訊息本文，只換按鈕並以回覆回報狀態
- 新增平台：建立 `channels/<platform>.ts`，實作 `PlatformAdapter`，匯入時自動註冊

### 寄信模組與 mail-queue
- `mail/` 與平台無關：`mailService` 負責資格判斷、`requestMail` 與 job 執行，結果文字集中在 `MAIL_TEXT`；`pttTerminal` 是 PTT 終端機客戶端，其他地方不直接碰 PTT 的 WebSocket
- 持久狀態只在 Postgres 的 `MailRequest` 與 `PttAccount`；Redis 每次開機都會 flush，BullMQ job 只是觸發器，啟動時 `recoverInFlight` 依資料庫重新入列或標記未知
- `mail-queue` 以 `attempts: 1`、worker 併發 1、每 5 秒 1 個 job 執行 `send` 與 `verify`，避免重複登入與帳號被鎖
- 同一封信最多寄出一次：claim 在 Postgres 交易內原子完成，只有擁有者能領取，且受每日上限與每封信 3 次嘗試的限制
- 密碼只以密文存放與傳遞（job payload 只含密文），解密後的明文只存在於呼叫 PTT 客戶端的區域變數，不寫 log
- 功能由 `config.mail.enabled` 控制，需同時設定 `PTT_ENCRYPT_KEY` 與 `TELEGRAM_WEBHOOK_SECRET`

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
