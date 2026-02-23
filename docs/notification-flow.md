# 通知流程

## 概觀

推播流程負責將匹配結果透過各平台適配器 (adapter) 發送給使用者。具備速率限制和部分失敗容錯機制。
目前支援 Telegram，可透過新增 `channels/<platform>.ts` 擴充其他平台。

## 流程圖

```
┌───────────────┐
│ matcherWorker │
│               │
│ notifyQueue   │
│  .add("notify")│
└──────┬────────┘
       │ 每個匹配結果
       ▼
┌──────────────────┐
│ notifierWorker   │
│ 併發數：1        │
│ 速率：30 則/秒    │
└──────┬───────────┘
       │
       ▼
  sendNotification(payload)
       │
       ├─── prisma.user.findUnique({ id, select: { enable, channels } })
       │                                          (所有平台)
       ├─── 若使用者不存在或已停用 (enable === false) → 回傳 false
       │
       └─── 針對每個頻道 (channel):
            getAdapter(channel.platform).sendNotification(chatId, payload)
            │       │
            │       └─── 適配器格式化訊息 (TG 用 HTML, Discord 用 Markdown 等)
            │
            ├─── 成功 → sent = true
            └─── 失敗 → 記錄日誌 (logError), 繼續下一個
                          │
                          └─── 全部失敗？ → 回傳 false
                               部分成功？ → 回傳 true
```

## 速率限制 (Rate Limiting)

Telegram Bot API 限制每個 Bot 每秒約 30 則訊息。

```typescript
// notifierWorker.ts
{
  concurrency: 1,              // 序列處理，避免併發衝突
  limiter: { max: 30, duration: 1_000 },  // 30 則/秒
}
```

當達到上限時，BullMQ 的限制器會自動延遲下一個任務 (job)。

## 訊息格式

採用 HTML 格式，Telegram `parse_mode: "HTML"`：

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
| HTML 特殊字元 (`&`, `<`, `>`) | 自動轉義 (escape) |
| 訊息超過 4096 字元 | 截斷為 4093 字元 + `"..."` |
| 連結預覽 | 已停用 (`is_disabled: true`) |

## 使用者查詢 (User Lookup)

從 PostgreSQL 查詢使用者的所有頻道 (channel)，不限平台：

```typescript
prisma.user.findUnique({
  where: { id: payload.userId },
  select: {
    enable: true,
    channels: true,  // 所有平台
  },
});
```

### 守衛條件 (Guard Conditions)

| 條件 | 行為 |
|------|------|
| 使用者不存在 | 回傳 false |
| `user.enable === false` | 回傳 false |
| 無任何頻道 | 回傳 false (頻道陣列為空) |

## 多頻道與多平台支援

一位使用者可以擁有多個頻道 (例如不同平台，或同一平台不同群組)。

- 遍歷所有頻道，透過 `getAdapter(channel.platform)` 取得對應適配器。
- 每個適配器自行格式化訊息 (Telegram 使用 HTML, Discord 使用 Markdown 等)。
- 部分頻道失敗 → 其他頻道繼續發送 → 整體視為成功。
- 全部頻道失敗 → 回傳 false。

## 錯誤處理

| 層級 | 情境 | 行為 |
|------|------|------|
| 工作器 (Worker) | 任務處理失敗 | 使用 BullMQ 指數退避重試，最多 3 次 |
| 服務 (Service) | 單一頻道 `sendMessage` 失敗 | 將錯誤記錄至 DB (logError) 並向管理員發送 Telegram 告警，隨後繼續其他頻道 |
| 服務 (Service) | 全部頻道失敗 | 回傳 false |

### 錯誤日誌 (Error Logging)

當頻道發送失敗時，會記錄至 `crawler_logs`：

```typescript
logError("ERROR", "NOTIFIER", `${channel.platform} 發送失敗`, {
  userId: payload.userId,
  channelId: channel.id,
  error: err.message,
});
```

### 管理員告警 (Admin Alert)

於 `errorLogger.ts` 透過 `getAdapter("TELEGRAM").sendAlert()` 發送：
- **FATAL**: 立即向管理員 Telegram 發送推播
- **ERROR**: 5 分鐘冷卻時間 (針對相同模組與訊息組合)
