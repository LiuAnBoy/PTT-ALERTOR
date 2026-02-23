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
新增 Stock regexp:台積電.*\d+
新增 Gossiping 問卦&爆卦&閒聊    ← 多關鍵字用 & 分隔
```

Flow:
```
新增 {board} {keywords}
  │
  ├── requireUser(ctx)          ← 未註冊 → 提示 /start
  ├── 格式檢查                   ← 少於 2 個參數 → 錯誤提示
  ├── boardExists(board)         ← 看板不存在 → 錯誤提示
  │
  └── for each keyword (split by &):
      ├── regex 語法檢查          ← regexp: prefix + invalid → 錯誤提示
      ├── subscriptionExists()   ← 已存在 → 重複提示
      ├── addSubscription()      → PostgreSQL
      ├── addSubscriptionToRedis() → Redis
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
   • regexp:爆卦.*
📌 Stock
   • 台積電
```

無訂閱時:
```
📋 您目前沒有任何訂閱。
輸入「新增 [看板] [關鍵字]」開始追蹤。
```

### 幫助 — 使用說明

```
幫助
```

顯示完整使用指南，包含基本指令、多關鍵字語法、正則表達式範例。

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
// 不認識的文字 → null → 無回覆
```

## User Resolution

所有需要使用者身份的指令透過 `CommandContext` 查詢：

```
CommandContext.platformUserId
  → findChannelByPlatformUserId(ctx.platform, ctx.platformUserId)
    → channel.user (with User relation)
```

找不到 → 回傳 `{ reply: "❌ 請先輸入 /start 來開始使用。" }`。

## Adding a New Platform

1. Create `src/modules/broadcast/channels/<platform>.ts`
2. Implement `PlatformAdapter` interface (sendReply, sendNotification, sendAlert)
3. Convert platform events → `CommandContext`, call `commandHandler` functions
4. Call `registerAdapter()` at module level (auto-registers on import)
5. Import the file in `server.ts`
6. No changes needed to `commandHandler.ts` or `notifierService.ts`
