# Notification Flow

## Overview

推播流程負責將匹配結果透過 Telegram Bot API 發送給使用者。具有速率限制和部分失敗容錯。

## Flow Diagram

```
┌───────────────┐
│ matcherWorker │
│               │
│ notifyQueue   │
│  .add("notify")│
└──────┬────────┘
       │ per match result
       ▼
┌──────────────────┐
│ notifierWorker   │
│ concurrency: 1   │
│ rate: 30 msg/sec │
└──────┬───────────┘
       │
       ▼
  sendNotification(payload)
       │
       ├─── prisma.user.findUnique({ id, select: { enable, channels } })
       │
       ├─── if (!user || !user.enable) → return false
       │
       ├─── formatMessage(payload) → HTML string
       │
       └─── for each Telegram channel:
            bot.api.sendMessage(chatId, message, { parse_mode: "HTML" })
            │
            ├─── success → sent = true
            └─── failure → logError, continue
                          │
                          └─── all failed? → return false
                               some success? → return true
```

## Rate Limiting

Telegram Bot API 限制每秒約 30 則訊息（同一個 bot）。

```typescript
// notifierWorker.ts
{
  concurrency: 1,              // 序列處理，避免併發衝突
  limiter: { max: 30, duration: 1_000 },  // 30 msg/s
}
```

BullMQ 的 limiter 會自動在達到上限時延遲下一個 job。

## Message Format

HTML 格式，Telegram `parse_mode: "HTML"`：

```
🔔 <b>{keyword}</b>@{board}

📰 {title}
👤 {author}
👍 {pushSum}

🔗 {link}
```

### 特殊處理

| 情境 | 行為 |
|------|------|
| `author` 為 null | 顯示 `"unknown"` |
| HTML 特殊字元 (`&`, `<`, `>`) | 自動 escape |
| 訊息超過 4096 字元 | 截斷為 4093 字元 + `"..."` |
| Link preview | 已停用 (`is_disabled: true`) |

## User Lookup

從 PostgreSQL 查詢 user：

```typescript
prisma.user.findUnique({
  where: { id: payload.userId },
  select: {
    enable: true,
    channels: { where: { platform: "TELEGRAM" } },
  },
});
```

### Guard Conditions

| 條件 | 行為 |
|------|------|
| User 不存在 | return false |
| `user.enable === false` | return false |
| 無 Telegram channel | return false（channels 為空陣列）|

## Multi-Channel Support

一個 user 可以有多個 Telegram channel（不同群組或私訊）。

- 遍歷所有 channel 發送
- 部分 channel 失敗 → 其他 channel 繼續發送 → 整體視為成功
- 全部 channel 失敗 → return false

## Error Handling

| 層級 | 情境 | 行為 |
|------|------|------|
| Worker | Job 處理失敗 | BullMQ exponential backoff retry, 最多 3 次 |
| Service | 單一 channel sendMessage 失敗 | logError to DB + admin alert, 繼續其他 channel |
| Service | 全部 channel 失敗 | return false |

### Error Logging

channel 發送失敗時記錄到 `crawler_logs`：

```typescript
logError("ERROR", "NOTIFIER", "Telegram send failed", {
  userId: payload.userId,
  channelId: channel.id,
  telegramError: err.message,
});
```

### Admin Alert

`errorLogger.ts` 中：
- **FATAL**: 立即推送到 admin Telegram
- **ERROR**: 5 分鐘 cooldown（相同 module+message 組合）
