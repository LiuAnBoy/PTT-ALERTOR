# Bot Commands

## Overview

透過 broadcast 模組接收各平台使用者訊息，共用指令邏輯（`commandHandler.ts`）處理後回覆。
目前支援 Telegram，可透過新增 `channels/<platform>.ts` 擴充其他平台。

## Architecture

```
Platform event → channels/telegram.ts → toCommandContext()
                                             │
                          ┌──────────────────┴──────────────────┐
                          ▼                                     ▼
              handlePending()（等待輸入中？）           parseCommand → execute*
                          │                                     │
                          └──────────────────┬──────────────────┘
                                             ▼
                              CommandResult { reply, buttons? }
                                             │
                                             ▼
                      ctx.reply() ＋ buttons → InlineKeyboard (platform-specific)
```

`CommandResult.buttons` 是 `ButtonRows`（`{ text, action }[][]`，型別定義在 `types.ts`），`action` 為 callback
資料，上限 64 bytes。Telegram 在回覆時把它轉成 inline keyboard。

## Webhook 設定 (Telegram)

```
POST /api/telegram/webhook
```

Express middleware 由 grammy `webhookCallback` 產生。`TELEGRAM_WEBHOOK_SECRET` 有設定時，會同時傳給
`webhookCallback` 的 `secretToken` 與 `setWebhook` 的 `secret_token`：沒有帶正確
`X-Telegram-Bot-Api-Secret-Token` header 的請求一律回 401，不會處理。未設定時不驗證（寄信功能因此關閉）。

請求記錄（pino-http）只記 id、method、path，不記 header 與 body；bot 的錯誤處理只記 update id 與錯誤名稱，
不記錯誤訊息或訊息文字，避免 PTT 密碼進入 log。

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
  └── 回覆成功（寄信功能啟用時附上該訂閱設定卡的按鈕，見「回信設定卡」）
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

寄信功能啟用時，每筆訂閱附一顆 `⚙️ 看板 · 關鍵字` 按鈕（action `sub:<id>:open`，最多 100 顆），按下開啟該訂閱的回信設定卡。
按鈕文字最多 40 個字元，以 code point 計算，不會把一個表情符號切成兩半。

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

顯示完整使用指南，包含基本指令、PTT 寄信指令（綁定PTT / 解除PTT / 如何設定回信）、AND 多關鍵字語法、正則表達式範例。

### 綁定PTT — 綁定寄信用的 PTT 帳號

```
綁定PTT
```

需要寄信功能啟用（`PTT_ENCRYPT_KEY` 與 `TELEGRAM_WEBHOOK_SECRET` 都已設定），且只能在與機器人的私訊中使用。

Flow:
```
綁定PTT
  │
  ├── 寄信功能關閉      ← 回覆「寄信功能目前未啟用」，不寫入任何東西
  ├── 非私訊            ← 拒絕，請改到私訊
  ├── 顯示聲明（PTT_DISCLAIMER）並詢問 PTT 帳號   → pending: bindId
  ├── 收到帳號：非私訊 → 清除 pending 並拒絕
  │            檢查格式（英文字母開頭、2-12 個英數字，不分大小寫拒絕 guest / new）
  │            → 詢問密碼                          → pending: bindPassword
  └── 收到密碼：
        ├── deleteMessage 刪除密碼訊息（失敗 → 回覆中加上「請手動刪除」警告）
        ├── 非私訊 → 拒絕（訊息仍會先被刪除，不入列）
        ├── encryptSecret（AES-256-GCM），密碼取自未去除空白的原始訊息文字（`CommandContext.rawText`）
        ├── enqueueVerifyJob({ userId, chatId, pttId, passwordEnc })  ← 只有密文
        └── 回覆「⏳ 驗證中…」，登入驗證與結果回覆由 mail-queue worker 處理
```

handler 本身不連 PTT，也不記錄密碼。`CommandContext.text` 是去除前後空白的文字，用來解析指令；
密碼不經過它，以免前後有空白的密碼被改掉。聲明內容見 `PTT_DISCLAIMER`（加密儲存、只在寄信時於記憶體解密、
不寫 log、伺服器管理者技術上仍可解密、請用副帳號、解除PTT 會刪除）。

### 解除PTT — 刪除已儲存的帳號

```
解除PTT
```

刪除該使用者的 PTT 帳號與加密密碼並回覆確認；沒有綁定時回覆「你目前沒有綁定 PTT 帳號」。
寄信功能關閉時也可使用。

### 回信設定卡 — 每筆訂閱的寄信設定

`新增` 成功後的回覆，與 `清單` 的 `⚙️` 按鈕，都會帶出該訂閱的設定卡：看板、關鍵字、目前的回信內容
（未設定顯示「未設定」）、附原文 開／關，以及三顆按鈕：

| 按鈕 | callback `action` | 行為 |
|------|-------------------|------|
| ✏️ 設定回信內容 | `sub:<id>:reply` | 進入 pending: replyText，下一則文字（最多 2000 字）存為回信內容並重新顯示設定卡 |
| 📎 附原文：開／關 | `sub:<id>:orig` | 切換是否在信中引述原文，原地更新設定卡 |
| 🗑 清除回信 | `sub:<id>:clear` | 清空回信內容，原地更新設定卡 |
| （清單按鈕） | `sub:<id>:open` | 以新訊息送出設定卡 |

每個動作都先載入該訂閱，**只有訂閱屬於按下按鈕的使用者才會執行**，否則回覆「找不到這個訂閱」（與不存在時相同，不洩漏他人資料）。
寄信功能關閉時，所有動作回覆功能未啟用，`新增` 與 `清單` 也不附按鈕。

### /errors — 錯誤記錄（Admin Only）

僅限 `ADMIN_TELEGRAM_ID` 使用。

| 指令 | 行為 |
|------|------|
| `/errors` | 列出最近 24 小時的錯誤記錄 |
| `/errors clear` | 標記所有錯誤為已處理 |

## Pending 輸入

多步驟輸入（綁定帳號、綁定密碼、回信內容）的狀態存在 Redis key `mail:pending:<platformUserId>`
（JSON：`step` 與必要資料，不含密碼；TTL 300 秒）。`handleText` 在 `parseCommand` 之前先呼叫
`handlePending()`，依 pending 的步驟處理：

- 綁定密碼步驟：下一則文字一律是密碼，不經指令解析。`熱門…`、`新增…`、`清單`、`幫助`、`綁定PTT` 這類文字也一樣被當成密碼：
  先刪除訊息，再加密並入列驗證，不會執行任何指令，也不會被回覆引用。這個步驟沒有「取消」字樣，
  等待 5 分鐘 pending 過期即取消（密碼提示中會說明）。
- 綁定帳號步驟：下一則文字一律是 PTT 帳號、格式錯誤的提示，或恰好等於 `取消`（清除 pending 並結束綁定）；
  不經指令解析。
- 綁定帳號與綁定密碼兩個步驟只在私訊中進行：在群組收到時清除 pending 並拒絕，密碼訊息仍會先被刪除。
- 回信內容步驟：文字是已知指令（含 `綁定PTT` 本身）→ 清除 pending，照常執行該指令；否則存為回信內容。
- 讀取密碼後立即清除 pending。
- 啟動時 Redis `flushdb` 會一併清掉 pending，使用者重新輸入 `綁定PTT` 即可。

## Callback Query

`bot.on("callback_query:data")` 依 `callback_data` 前綴分派：

| 前綴 | 用途 |
|------|------|
| `sub:` | 回信設定卡（見上表） |
| `mail:<id>` | 通知上的「✉️ 寄信給 <作者>」按鈕，`<id>` 是 `MailRequest` id；流程見 [notification-flow.md](notification-flow.md#寄信按鈕) |
| `mail:noop` | 領取成功後取代寄信按鈕的「⏳ 寄送中…」，只回應 callback，不做任何事 |

`mail:<id>` 把按下按鈕的 Telegram 使用者解析成 User（與其他指令相同，見「User Resolution」），再呼叫 `requestMail(id, userId)`。
成功領取時，若請求沒有記錄通知訊息（送出通知時寫入失敗），就以按下的這則訊息補記為該請求的訊息
（`recordNotificationMessage`），寄信結果才有地方回報；接著把訊息的 inline keyboard 換成「⏳ 寄送中…」。
任何拒絕都只用 `describeRequestOutcome` 的文字回應 callback，並且不動訊息。

每次按鈕都會呼叫 `answerCallbackQuery`（出錯時也是），以結束 Telegram 端的載入動畫。

## Text Routing

共用 `parseCommand()` 根據訊息文字路由到對應指令：

```typescript
// commandHandler.ts
if (text === "幫助") return { command: "help", args: "" };
if (text === "清單") return { command: "list", args: "" };
if (text.startsWith("新增")) return { command: "add", args: text.slice(2).trim() };
if (text.startsWith("刪除")) return { command: "delete", args: text.slice(2).trim() };
if (text.startsWith("熱門")) return { command: "boardStats", args: text.slice(2).trim() };
if (/^綁定ptt$/i.test(text)) return { command: "bindPtt", args: "" };
if (/^解除ptt$/i.test(text)) return { command: "unbindPtt", args: "" };
// 不認識的文字 → null → 回覆「❌ 無法辨識的指令」
```

在此之前 `handleText` 會先檢查 pending 輸入（見「Pending 輸入」）。

## User Resolution

所有需要使用者身份的指令透過 `CommandContext` 查詢，由 `commandHandler.ts` 匯出的 `getUser(ctx)` 完成；
`channels/telegram.ts` 的 `mail:<id>` 也用同一個函式，不直接存取 repository：

```
CommandContext.platformUserId
  → getUser(ctx)
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
