# Bot Commands

## Overview

透過 broadcast 模組接收各平台使用者訊息，共用指令邏輯（`commandHandler.ts`）處理後回覆。
目前支援 Telegram，可透過新增 `channels/<platform>.ts` 擴充其他平台。

## Architecture

```
Platform event → channels/telegram.ts → toCommandContext()
                                             │
                                             ▼
                                      commandHandler.ts
                                      (parseCommand → execute*)
                                             │
                                             ▼
                                      CommandResult { reply }
                                             │
                                             ▼
                                      ctx.reply() (platform-specific)
```

## Webhook 設定 (Telegram)

```
POST /api/telegram/webhook
```

Express middleware 由 grammy `webhookCallback` 產生。

## Commands

### /start — 註冊 / 歡迎

| 情境 | 行為 |
|------|------|
| 新使用者 | 建立 User + Channel，回覆「註冊成功」 |
| 已註冊使用者 | 回覆「歡迎回來」 |
| `ctx.from` 為 null | 靜默 return |

Flow:
```
/start
  │
  ├── findChannelByPlatformUserId("TELEGRAM", from.id)
  │
  ├── null (new user):
  │   ├── createUser(displayName)    → PostgreSQL (User.username = displayName)
  │   ├── createChannel(rawData)     → PostgreSQL (Channel.rawData = ctx.from)
  │   └── reply("🎉 註冊成功...")
  │
  └── found (existing):
      └── reply("👋 歡迎回來...")
```

### 新增 [看板] [關鍵字] — 新增訂閱

```
新增 Gossiping 問卦
新增 Stock 台積電.*\d+           ← 支援正則表達式
新增 Gossiping 問卦|爆卦         ← OR 用 regex 的 | 即可
新增 Gamesale 售&ps5             ← AND，標題需同時含「售」與「ps5」
```

`&` 為 **AND 邏輯**：整串視為單一訂閱，標題需同時命中所有以 `&` 分隔的子關鍵字。

**`&` 為保留字**：無法直接用於字面比對。例如 `R&D`、`M&A`、`AT&T` 會被解讀為 AND，
而非字面字串。若真的需要比對含 `&` 的字面字串，可在輸入時把 `&` 改寫成 regex
的 unicode escape `\u0026`（這 6 個字元的字串本身不含 `&`，因此不會被 AND
拆分；regex 引擎仍會把它解回字面 `&`）。例：

- 想要字面 `R&D`：輸入 `新增 Soft_Job R\u0026D`
- 想要字面 `M&A`：輸入 `新增 Stock M\u0026A`

**畸形輸入**：`售&&ps5`、`售&`、`&ps5` 等 `&` 兩側出現空 segment 的輸入會被拒絕。

Flow:
```
新增 {board} {keyword}
  │
  ├── requireUser(ctx)          ← 未註冊 → 提示 /start
  ├── 格式檢查                   ← 少於 2 個參數或關鍵字為空 → 錯誤提示
  ├── boardExists(board)         ← 看板不存在 → 錯誤提示
  ├── regex 安全性檢查（含 & 時逐一檢查每個子 pattern）← unsafe → 錯誤提示
  ├── subscriptionExists()      ← 已存在 → 重複提示
  ├── addSubscription()         → PostgreSQL（整串 keyword 作為一筆）
  ├── addSubscriptionToRedis()  → Redis
  └── 回覆成功
```

### 刪除 [看板] [關鍵字] — 刪除訂閱

```
刪除 Gossiping 問卦
```

Flow:
```
刪除 {board} {keyword}
  │
  ├── requireUser(ctx)
  ├── 格式檢查
  ├── subscriptionExists()      ← 不存在 → 錯誤提示
  ├── deleteSubscription()      → PostgreSQL
  ├── removeSubscriptionFromRedis() → Redis (含 cascading cleanup)
  └── 回覆成功
```

### 清單 — 查看訂閱

```
清單
```

Output (按看板分組):
```
📋 您的訂閱清單：

📌 Gossiping
   • 問卦
   • 爆卦.*
📌 Stock
   • 台積電
```

無訂閱時:
```
📋 您目前沒有任何訂閱。
輸入「新增 [看板] [關鍵字]」開始追蹤。
```

### 熱門 [看板] — 看板熱門關鍵字

```
熱門 Gamesale
```

列出該看板被訂閱的關鍵字（含 AND 複合 / 單一），按訂閱人數降序，最多 50 筆。

Flow:
```
熱門 {board}
  │
  ├── 格式檢查                   ← 缺看板名 → 錯誤提示
  ├── boardExists(board)         ← 看板不存在 → 錯誤提示
  ├── countByBoard(board, 50)   → SELECT keyword, COUNT(*) FROM subscriptions
  │                                WHERE board = ? GROUP BY keyword
  │                                ORDER BY count DESC, keyword ASC LIMIT 50
  ├── 結果為空                   ← 「目前無人訂閱關鍵字」
  └── 格式化輸出（count + keyword 對齊）
```

Output 範例:
```
📊 Gamesale 熱門關鍵字（前 3）

15  ps5
12  switch
 8  售&ps5
```

### 幫助 — 使用說明

```
幫助
```

顯示完整使用指南，包含基本指令、AND 多關鍵字語法、正則表達式範例。

### /errors — 錯誤記錄（Admin Only）

僅限 `ADMIN_TELEGRAM_ID` 使用。

| 指令 | 行為 |
|------|------|
| `/errors` | 列出最近 24 小時的錯誤記錄 |
| `/errors clear` | 標記所有錯誤為已處理 |

## Text Routing

共用 `parseCommand()` 根據訊息文字路由到對應指令：

```typescript
// commandHandler.ts
if (text === "幫助") return { command: "help", args: "" };
if (text === "清單") return { command: "list", args: "" };
if (text.startsWith("新增")) return { command: "add", args: text.slice(2).trim() };
if (text.startsWith("刪除")) return { command: "delete", args: text.slice(2).trim() };
if (text.startsWith("熱門")) return { command: "boardStats", args: text.slice(2).trim() };
// 不認識的文字 → null → 回覆「❌ 無法辨識的指令」
```

## User Resolution

所有需要使用者身份的指令透過 `CommandContext` 查詢：

```
CommandContext.platformUserId
  → findChannelByPlatformUserId(ctx.platform, ctx.platformUserId)
    → channel.user (with User relation)
```

找不到 → 回傳 `{ reply: "❌ 請先輸入 /start 來開始使用。" }`。

## Adding a New Command

1. **定義指令邏輯**:
   在 `src/modules/broadcast/commandHandler.ts` 中：
   - 更新 `parseCommand(text)` 函數，加入新的關鍵字識別（例如 `text === "設定"`）。
   - 新增 `execute*` 函數實作業務邏輯（例如 `executeSettings(ctx)`）。

2. **更新平台 Adapter**:
   在平台 adapter 檔案（如 `src/modules/broadcast/channels/telegram.ts`）的 `handleText` 中：
   - 在 `switch (parsed.command)` 中加入對應的 case 並呼叫新的 `execute*` 函數。

3. **更新單元測試**:
   在 `src/modules/broadcast/tests/commandHandler.unit.test.ts` 與 `telegram.unit.test.ts` 加入測試案例。

## Adding a New Platform

1. Create `src/modules/broadcast/channels/<platform>.ts`
2. Implement `PlatformAdapter` interface (sendReply, sendNotification, sendAlert)
3. Convert platform events → `CommandContext`, call `commandHandler` functions
4. Call `registerAdapter()` at module level (auto-registers on import)
5. Import the file in `server.ts`
6. No changes needed to `commandHandler.ts` or `notifierService.ts`
