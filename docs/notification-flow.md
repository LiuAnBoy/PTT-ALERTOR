# 通知流程

## 概觀

推播流程負責將匹配結果透過各平台適配器 (adapter) 發送給使用者。具備速率限制和部分失敗容錯機制。
目前支援 Telegram，可透過新增 `channels/<platform>.ts` 擴充其他平台。

使用者的訂閱設有回信內容、且已綁定 PTT 帳號時，通知會多一顆「✉️ 寄信給 <作者>」按鈕，見「寄信按鈕」。

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
       ├─── offerMail(payload) → MailRequest id 或 null   (失敗只記錄，視為沒有按鈕)
       │
       └─── 針對每個頻道 (channel):
            getAdapter(channel.platform).sendNotification(chatId, payload, buttons?)
            │       │
            │       └─── 適配器格式化訊息 (TG 用 HTML, Discord 用 Markdown 等)，
            │            有 buttons 時一併附上，並回傳送出的訊息參考 { chatId, messageId }
            │
            ├─── 成功 → sent = true；有按鈕時把訊息參考存到 MailRequest
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

## 寄信按鈕

### 提供按鈕（offer）

`sendNotification` 在查完使用者之後、遍歷頻道之前呼叫一次 `offerMail(payload)`（`mail/services/mailService.ts`）。
資格判斷與 `MailRequest` 的建立見 [mail-flow.md](mail-flow.md)：寄信功能啟用、文章有作者、
訂閱有回信內容、帳號已綁定且未失效；同一篇文章的請求已寄出或不明時不再提供。

- 回傳 request id → 以按鈕 `[[{ text: "✉️ 寄信給 <作者>", action: "mail:<id>" }]]` 傳給 adapter 的第三個參數。
- 回傳 null → 呼叫 adapter 時不帶 `buttons`，行為與沒有寄信功能時完全相同。
- `offerMail` 丟出錯誤 → 記錄警告後照常發送沒有按鈕的通知；寄信功能永遠不會擋住通知本身。

Telegram 把 `buttons` 轉成 inline keyboard（`callback_data` 即 `action`，`mail:<uuid>` 共 41 bytes，低於 64 bytes 上限）。

### 訊息參考（message ref）

`PlatformAdapter.sendNotification` 回傳送出的訊息參考 `{ chatId, messageId }`（無法提供的平台回傳 `void`）。
有按鈕且拿到參考時，`notifierService` 呼叫 `recordNotificationMessage`（mailService）把它存到該 `MailRequest`，之後寄信結果就能回報在這則通知上。
多個頻道時存第一個成功回傳的參考。存參考失敗只記錄警告，不影響通知的結果，也不會觸發 BullMQ 重試。
BullMQ 因暫時性錯誤重試同一則通知時，`offerMail` 會對仍為 `OFFERED` 的請求回傳同一個 id，不會產生第二筆。

### 按下按鈕（tap）

```
callback_query "mail:<id>"            ← telegram.ts handleCallbackQuery
  │
  ├── "mail:noop"                      ← 只回應 callback，不做任何事
  ├── 以按下者的 Telegram 使用者 ID 查 Channel → userId（查無 → 提示先 /start）
  ├── requestMail(id, userId)          ← Postgres 交易內原子 claim，見 mail-flow.md
  │     │
  │     ├── queued   → editMessageReplyMarkup 把 keyboard 換成單顆「⏳ 寄送中…」(mail:noop)
  │     │              （通知本文不變；更新 keyboard 失敗只記錄，claim 仍有效）
  │     └── 其他     → answerCallbackQuery 顯示 describeRequestOutcome 的文字，訊息不動
  │                    not_owner / cap_reached / attempts_exhausted 以彈出視窗 (show_alert) 顯示
  └── 一律 answerCallbackQuery
```

只有 `MailRequest` 的擁有者能領取；連按兩次時 `requestMail` 被呼叫兩次，但只有第一次 claim 成功並加入 `send` job，
第二次得到目前狀態（例如「已在排隊寄送中」）。

### 回報結果

`send` job 結束後，`mailService` 透過 `updateMessage(target, text, buttons?)` 回報：Telegram 實作**保留原通知本文**，
先用 `editMessageReplyMarkup` 把 inline keyboard 換成 `buttons`（沒有就移除），再把 `text` 以回覆（`reply_parameters`）
的方式發在原通知底下。因此通知內容在狀態改變後依然可讀。

- `message is not modified`、`message to edit not found`：記錄後略過 keyboard 更新，仍然發出回覆（原訊息已被刪除時回覆不帶 reply 也能送出）。
- 其他錯誤：丟出，`mailService` 改用 `sendReply(chatId, text)` 發新訊息。

結果文字與狀態轉換見 [mail-flow.md](mail-flow.md)。

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
| 工作器 (Worker) | 任務處理失敗 | 使用 BullMQ 指數退避重試，最多 3 次；用盡時送通知遺失告警 |
| 服務 (Service) | 單一頻道 `sendMessage` 失敗 | 將錯誤記錄至 DB (logError) 並向管理員發送告警，隨後繼續其他頻道 |
| 服務 (Service) | 全部頻道失敗 | 回傳 false |
| 服務 (Service) | `offerMail` 失敗 | 記錄警告，通知照常發送、不帶按鈕 |
| 服務 (Service) | 儲存訊息參考失敗 | 記錄警告，通知結果不變 |

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

`errorLogger.ts` 的所有告警都經 `notification/services/adminNotifier.ts` 的 `sendAdminAlert(text, level)` 發送：
- **FATAL**: 立即發送，level 為 `error`
- **ERROR**: 由 AlertAggregator 聚合，連續 5 輪（每輪 1 分鐘）異常才送首則告警（`error`），之後每 30 分鐘一則進度告警（`warning`），連續 3 輪正常時送恢復報告（`success`），見 [maintenance.md](maintenance.md)
- **通知遺失**: 通知重試用盡時立即發送（`error`），每 30 分鐘最多一則，期間的遺失累計到下一則，見 [maintenance.md](maintenance.md)

發送路線：
1. 設定 `SERVICE_KEY` 時，`POST {NOTIFY_SERVICE_URL}/v1/notify/telegram` 到 Service Manager 的管理頻道（預設 `system_admin`），header 為 `Authorization: Bearer <SERVICE_KEY>`，body 為 `{ channel, method: "sendMessage", params: { text, parse_mode: "none" }, level }`。notify_service 會自行加上等級 emoji 與服務名稱，所以這條路線送出前會移除告警文字開頭的 emoji；請求逾時為 15 秒。只有 HTTP 2xx 且回應 envelope 的 `success` 為 `true` 才算送達。
2. 未設定 `SERVICE_KEY`，或上一條路線沒有送達（非 2xx、`success: false`、無法解析、網路錯誤、逾時），且設定了 `ADMIN_TELEGRAM_ID` 時，經 `getAdapter("TELEGRAM").sendAlert()` 直送該聊天室，文字維持原樣。

兩條路線都未設定時 `logError` 只寫入 DB。`sendAdminAlert` 不會丟出例外，連拒絕值不是 Error 時也一樣。Service Manager 逾時但其實已送達時，同一則告警可能在兩處各出現一次，這是為了不漏警報而接受的重複。

Service Manager 路線失敗時只記錄 HTTP 狀態與錯誤代碼，或丟出的錯誤名稱，兩者都採白名單：錯誤代碼取自回應 envelope 的 `payload.code`，只有 notify_service 文件與程式中已知的代碼（例如 `invalid_service_key`、`channel_not_found`、`invalid_param`、`forbidden`、`rate_limited`）會原樣記錄，其他一律記為 `code=unrecognised`；錯誤名稱只記 fetch 會丟出的 `AbortError`、`TimeoutError`、`TypeError`，其他記為 `UnknownError`。格式檢查擋不住長得像代碼的 key，所以採白名單。`SERVICE_KEY`、請求內容與完整錯誤物件都不進 log。
