# 寄信流程

## 概觀

使用者在通知訊息上按「✉️ 寄信給 <作者>」，系統用使用者自己綁定的 PTT 帳號，透過 PTT 終端機（WebSocket）從主選單 `M` → `S` 寄一封站內信給作者。一次按鈕最多寄出一封信，使用者一定會收到結果訊息，任何 log 都不會出現密碼。

持久狀態只有 Postgres 的 `MailRequest` 列；Redis 在每次開機會被 flush，BullMQ job 只是觸發器。程式在 `src/modules/mail/`：

| 檔案                                            | 職責                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `services/mailService.ts`                       | 信件組裝、資格判斷、按鈕請求、send/verify job、啟動復原、結果訊息 |
| `services/pttTerminal.ts`                       | PTT 終端機客戶端（`sendPttMail`、`verifyPttLogin`）               |
| `repositories/mailRequestRepository.ts`         | 提供 offer、原子 claim、狀態轉換                                  |
| `repositories/pttAccountRepository.ts`          | 加密後的 PTT 帳號                                                 |
| `workers/mailQueue.ts`、`workers/mailWorker.ts` | `mail-queue` 與其 worker                                          |

## 流程

```
通知 ──offerMail──▶ MailRequest(OFFERED) ──▶ 通知附上按鈕 mail:<id>
                                                  │ 使用者按下
                                                  ▼
                              requestMail(id, 按鈕使用者)
                                  │ claim（Postgres 交易）
                                  ▼
                              QUEUED ──▶ mail-queue "send"
                                              │ mailWorker
                                              ▼
                                          SENDING ──▶ sendPttMail
                                  ┌─────────────┼───────────────┐
                                  ▼             ▼               ▼
                                SENT         FAILED          UNKNOWN
```

### 資格判斷與 offer

`checkEligibility` 全部成立才給按鈕：寄信功能啟用（`config.mail.enabled`）、文章有作者、以 `userId + board + keyword` 找到的訂閱 `replyContent` 非空、使用者已綁定 PTT 帳號且未標記失效。`offerMail` 之後對 `(userId, articleCode)` 呼叫 `upsertOffer`；一列對應一篇文章，且保留最先建立時的關鍵字。兩個關鍵字的通知同時建立同一列時，輸的一方遇到唯一鍵衝突（Prisma `P2002`），改讀贏的那一列，再套用下面的關鍵字規則。只有列的 `keyword` 等於這則通知的關鍵字，且列仍為 `OFFERED`，或為 `FAILED` 且嘗試次數未滿，才回傳 request id（即按鈕 id）。同一篇文章符合使用者另一個關鍵字的通知拿不到按鈕，因為按下去會用另一個關鍵字的回信內容寄信；已寄出或不明的文章也不再出現按鈕。

### 按下按鈕

`requestMail` 依序處理：功能關閉回 `disabled`；帳號已標記失效回 `account_invalid`（不再嘗試已知錯誤的密碼，避免帳號被鎖）；再由 `claim` 在一個交易內鎖住使用者的 `PttAccount` 列，依序檢查：

1. 列存在且屬於按下的使用者（`not_found`、`not_owner`），使用者已綁定帳號（`no_account`）。
2. 列的狀態是 `OFFERED` 或 `FAILED`，否則直接回 `not_claimable`（附目前狀態），不計每日上限。
3. 嘗試次數未達 `MAX_MAIL_ATTEMPTS = 3`（`attempts_exhausted`）。
4. 台北時間今天已被 claim 的其他請求數（不含正在 claim 的這一列）未達 `MAIL_DAILY_LIMIT`（`cap_reached`）；因此重按一個今天已計入的 `FAILED` 請求不會被每日上限擋下。

通過後以條件式 update 把 `OFFERED` / `FAILED` 改成 `QUEUED`，where 條件同時要求狀態仍是這兩者且 `attempts` 小於上限，所以等鎖等到的 claim 不會讓次數超過上限。claim 提交後才加入 `send` job（job id 為 `send-<id>-<attempts>`）。入列失敗會把列改成 `FAILED`。

回傳的結果型別：`queued`、`disabled`、`account_invalid`、`enqueue_failed`、`not_found`、`not_owner`、`no_account`、`attempts_exhausted`、`cap_reached`、`not_claimable`（附目前狀態）。`describeRequestOutcome` 把非 `queued` 的結果轉成給使用者的短句。

### 組信

- 主旨 `Re: <文章標題>`（截斷與編碼由 `pttTerminal` 處理）。
- 內文為訂閱的 `replyContent`；`replyIncludeOriginal` 開啟時，接一個空行、`※ 引述《<作者>》之銘言：`，再把原文每一行加上 `: ` 前綴。
- 原文取自 `Article.content`；為空則用 `fetchDetail(link)` 重抓；文章已刪除或無法取得時不附引文照常寄出，結果訊息註明「未附上引文」。

### 狀態

| 狀態      | 意義                  | 之後                                                                   |
| --------- | --------------------- | ---------------------------------------------------------------------- |
| `OFFERED` | 已提供按鈕，尚未按    | 可按；不計入每日上限                                                   |
| `QUEUED`  | 已 claim，等待 worker | 重啟時重新入列                                                         |
| `SENDING` | worker 正在登入並寄信 | 重啟時轉 `UNKNOWN`                                                     |
| `SENT`    | 已確認寄出            | 終點                                                                   |
| `FAILED`  | 確定沒有寄出          | 嘗試次數（每列最多 3 次）未滿時可再按；同一列當天只計入每日上限一次    |
| `UNKNOWN` | 存檔鍵送出後無法確認  | 終點，不自動重試，請使用者查看 PTT 信箱                                |

每日上限計算當天（台北時間，以 `queuedAt` 為準）被 claim 過的不同請求數，不論之後的狀態；同一篇文章的重試由每列的 `attempts` 限制，不會讓登入次數無上限。

### send job 結果

`executeSendJob` 只在列為 `QUEUED` 時動作（轉 `SENDING`），重複或過期的 job 什麼都不做。讀取列與轉 `SENDING` 這兩步若遇到資料庫錯誤，信一定還沒寄：盡可能把列標為 `FAILED`（再讀一次列取得聊天資訊），並回報使用者；資料庫仍然不通時只記錄錯誤，列留在 `QUEUED`，下次啟動由 `recoverInFlight` 重新入列。依 `sendPttMail` 結果：

- `sent` → `SENT`，訊息「已寄給 <作者>」。
- `unknown` → `UNKNOWN`，訊息請使用者到 PTT 信箱確認，不附按鈕。
- `not_sent` → `FAILED`，並依原因：`WrongPassword` 把帳號標記失效（`invalidAt`）並提示重新綁定；`TwoFactorRequired` 回報不支援；`UnfinishedDraft` 請使用者先登入 PTT 一次，完成或放棄未完成的文章草稿再試；`TooManySessions` 請使用者先登出這個帳號的其他連線；`NoSuchUser`、`PttBusy`、`Timeout`、`ConnectFailed` 等回報原因。嘗試次數未滿且不是帳密問題時，訊息附「再試一次」按鈕（`mail:<id>`）。
- 呼叫 `sendPttMail` 之前發生的內部錯誤 → `FAILED`；呼叫之後發生的 → `UNKNOWN`，因為信可能已寄出。

### PTT 終端機的登入與登出

`pttTerminal` 的登入只在送出密碼之後才把主選單當成成功，並且在連線前就拒絕 `guest`、`new`（不分大小寫）這兩個不需密碼的代號。

- **重複登入**：「您想刪除其他重複登入的連線嗎？」一律回 `n`，絕不踢掉使用者在別處的連線。pttbbs（`mbbsd.c` 的 `multi_user_check`）在使用者選擇不踢、而這個帳號仍有 3 個以上其他連線時，會不顯示任何訊息直接斷線；客戶端把「回完 `n` 後連線關閉」回報為 `TooManySessions`，結果訊息請使用者先登出其他連線。
- **一次性提示只回答一次**：PTT 會把是非題連同使用者打的答案再畫一次（例如 `[Y/n] n`）。重複登入、清除錯誤嘗試記錄、選擇簽名檔、是否自存底稿這些提示，客戶端各只回答一次，之後畫面上再出現同一句不會再送鍵，否則多出的 Enter 會落在下一個畫面（例如在主選單上打開分類看板）。
- **未完成的草稿**：只要尚未回應的畫面上任何位置出現「有一篇文章尚未完成」或「請選擇暫存檔」，客戶端就在處理其他提示之前回報 `UnfinishedDraft`：同一個畫面上之後的任意鍵、重複登入或主選單提示也不會收到任何按鍵。它不送出 `Q`、`S` 或任何暫存檔編號，直接關閉連線，使用者的草稿不會被丟棄或存入暫存檔。
- **登出**：已經在主選單時直接按 `G` 再以 `y` 確認；不在主選單時先按左鍵回主選單。在主選單上按左鍵只會移動游標，PTT 不會重畫選單文字，所以不能一律先按左鍵再等主選單。

### verify job

綁定帳號時 webhook 不直接登入，而是 `enqueueVerifyJob` 把 `{ userId, chatId, pttId, passwordEnc }`（只有密文）放進 `mail-queue`（`removeOnComplete` / `removeOnFail` 皆為 true）。`executeVerifyJob` 解密後呼叫 `verifyPttLogin`：成功就 `upsertPttAccount`（密文原樣寫入）並回覆「已綁定」；`WrongPassword`（含 `guest`、`new` 代號）、`TwoFactorRequired`、`UnfinishedDraft`（請使用者先登入 PTT 處理草稿，再重新綁定）與其他失敗各有回覆，失敗時不寫入帳號。

### 結果回報

結果文字都集中在 `mailService.ts` 的 `MAIL_TEXT`。通知送出時，`notifierService` 透過 `recordNotificationMessage` 把訊息的 `chatId` / `messageId` 記在請求上；沒有記到時（寫入失敗），按下按鈕且 claim 成功的 Telegram callback 會把按下的那則訊息補記進去。按下按鈕且 claim 成功時，通知的按鈕換成不可再按的「⏳ 寄送中…」。send 結果：請求記有 `chatId` / `messageId` 且 adapter 實作了可選的 `updateMessage` 時，原通知的文字保持不變，只把按鈕換成結果需要的按鈕（「再試一次」或不留按鈕），結果文字以回覆該通知的訊息送出；`updateMessage` 失敗、不支援，或只有 `chatId` 時改用 `sendReply(chatId)`。verify 結果一律 `sendReply(chatId)`。回報失敗只記錄，不影響已寫入的狀態。

## Queue 設定

| 項目            | 值                                         |
| --------------- | ------------------------------------------ |
| Queue           | `mail-queue`，job 名稱 `send`、`verify`    |
| attempts        | 1（不自動重試，避免重複登入與帳號被鎖）    |
| Worker          | concurrency 1，limiter 5 秒 1 個 job       |
| send job 保留   | 完成 1 小時 / 1000 筆，失敗 7 天 / 5000 筆 |
| verify job 保留 | 完成與失敗皆立即移除                       |

job payload 與 worker 的錯誤 log 都不含密碼；verify job 只帶密文。

## 啟動復原

`server.ts` 在 Redis 連線（並 flush）之後、worker 啟動之前執行 `recoverInFlight`：`QUEUED` 的列重新加入 `send` job；`SENDING` 的列改為 `UNKNOWN` 並通知使用者，因為信可能已寄出。復原失敗只記錄錯誤，不阻止服務啟動。flush 也會丟掉等待中的 `verify` job，使用者需重新 `綁定PTT`。

## 失敗處理摘要

- 同一按鈕重複按：只有第一次 claim 成功，其餘回目前狀態。
- 非擁有者按下：`not_owner`，不改任何狀態。
- 達到每日上限或嘗試次數上限：拒絕並說明。
- 寄信功能關閉（缺 `PTT_ENCRYPT_KEY` 或 `TELEGRAM_WEBHOOK_SECRET`）：所有請求回 `disabled`，進行中的列標為 `FAILED`。
- 密碼不會出現在 log：解密後的明文只存在於呼叫 PTT 客戶端的區域變數；錯誤 log 只記錄錯誤碼與 id。
