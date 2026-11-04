# Maintenance & Cleanup

## Overview

系統定期執行清理任務，移除過期資料以控制儲存空間和查詢效能。

## Schedule

```
maintenanceQueue → every 3,600,000ms (1 hour) → maintenanceWorker → runCleanup()
```

## Cleanup Tasks

### 1. Crawler Log Cleanup

**保留期限**: 30 天

```sql
DELETE FROM crawler_logs WHERE created_at < (now - 30 days)
```

### 2. Redis Active Articles Cleanup

**保留期限**: 24 小時

```
ZREMRANGEBYSCORE active:articles -inf {cutoff_timestamp}
```

`cutoff_timestamp` = (now - 24h) 的 Unix timestamp（秒）。

> DB 中的文章永久保留，不做 hard delete。

## Article Lifecycle

```
  fetchHtml → New article discovered
      │
      ▼
  insertNewArticles (PostgreSQL, 永久保留)
  cacheArticles (Redis: ZADD active:articles + HSET board:latest)
      │
      ▼
  updateActiveArticles (every 15 min)
  ← ZRANGEBYSCORE active:articles 取得 24h 內文章
      │
      ├── detail changed → UPDATE DB
      ├── 404 → removeActiveArticle (ZREM from active:articles)
      └── no change → skip
      │
      ▼
  runCleanup (every 1 hour)
  ← ZREMRANGEBYSCORE active:articles：移除超過 24h 的條目
  ← DELETE crawler_logs：移除超過 30 天的日誌
```

### Data Retention

| 概念 | 儲存位置 | 保留期限 | 用途 |
|------|----------|----------|------|
| **Active Tracking** | `active:articles` ZSET | 24 小時 | 控制 updateWorker 是否繼續追蹤推文變化 |
| **Latest Timestamp** | `board:latest` HASH | 隨 Redis 生命週期 | 判斷新文章的時間基準 |
| **Article Record** | PostgreSQL `articles` | 永久 | 歷史文章紀錄 |
| **Crawler Log** | PostgreSQL `crawler_logs` | 30 天 | 錯誤與告警紀錄 |

## Error Logging & Alerts

### Error Log Table

`crawler_logs` 記錄所有 WARN/ERROR/FATAL 等級的錯誤：

| Column | Type | Description |
|--------|------|-------------|
| `level` | WARN / ERROR / FATAL | 嚴重程度 |
| `module` | string | 發生模組（CRAWLER, NOTIFIER, etc.） |
| `message` | string | 錯誤摘要 |
| `detail` | JSON | 完整錯誤資訊 |
| `notified` | boolean | 是否已被 admin 確認 |

### Admin Alert Rules

| Level | Behavior |
|-------|----------|
| **FATAL** | 立即推送給 admin |
| **ERROR** | 透過 AlertAggregator 聚合（見下方） |
| **WARN** | 僅寫入 DB，不推送 |

所有告警經 `adminNotifier.sendAdminAlert` 發送：設定 `SERVICE_KEY` 時送 Service Manager 的 `system_admin` 管理頻道，未設定或該次發送失敗時直送 `ADMIN_TELEGRAM_ID` 的 Telegram 聊天室。細節見 [notification-flow.md](notification-flow.md)。

### Alert Aggregation（告警聚合）

避免短暫錯誤與大量錯誤時通知轟炸：ERROR 不會直接推送，只有連續多輪異常才告警。

**狀態機**: `NORMAL → ALERTING → NORMAL`

每筆 ERROR 會先經 `errorClassifier.ts` 的 `classifyError(detail)` 歸入粗分類，再交給 aggregator 累計。分類依 `detail` 的結構化欄位判斷（非 message 字串）：

| 分類 | 判斷依據 | 顯示 |
|------|----------|------|
| `HTTP_5XX` | `detail.httpStatus` 500–599 | PTT 伺服器錯誤(5xx) |
| `HTTP_4XX` | `detail.httpStatus` 400–499 | 用戶端/權限錯誤(4xx) |
| `TIMEOUT` | 訊息含 `ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`/`ECONNABORTED`/`timeout` | 連線逾時/中斷 |
| `PARSE` | `detail.kind === "parse"`（產生端明確標記） | 頁面解析失敗 |
| `OTHER` | 其餘 | 其他錯誤 |

**一輪**是一次 dispatch（每分鐘）：`dispatchCrawlerJobs` 一開始呼叫 `closeAlertRound()` 結算上一分鐘。這一分鐘內有任何 ERROR（不限來源），或 circuit 不是 CLOSED（熔斷時不爬取，不會產生 ERROR），就是異常輪；其餘是正常輪。

| 事件 | 行為 |
|------|------|
| ERROR | 寫入 DB 並按分類計數，不推播 |
| 連續第 5 個異常輪 | 推送首則告警（含異常開始時間與首個錯誤分類），進入 ALERTING |
| 未滿 5 輪就出現正常輪 | 清除累計，不推播；錯誤仍可從 `/errors` 查看 |
| ALERTING 中 | 每 30 分鐘最多推送一則進度告警（`sendProgressAlert()` 以 `lastProgressAt` 節流） |
| ALERTING 中連續 3 個正常輪 | 推送恢復報告（異常期間起訖、持續分鐘、累計次數、各分類次數），再重置計數器；中途出現異常輪時重新計算 |

**訊息類型**：首次告警（⚠️）、進度告警（⏳，每 30 分節流）、恢復報告（✅，含問題分布）。恢復報告務必在 `recover()` 清除計數器**之前**產生。

**只會零星發生的錯誤不會觸發這個規則**：`updateWorker` 每 15 分鐘才跑一次，通知發送失敗也只在有通知時才發生，這類錯誤湊不滿連續 5 輪，只會留在 `crawler_logs`，要用 `/errors` 查看。通知重試用盡另有告警，見 Worker 失敗告警；FATAL 一律立即推送。

實作於 `src/core/alertAggregator.ts`（in-memory singleton），由 `errorLogger.ts` 的 `logError()` 累計、`closeAlertRound()` 結算。

> **已知限制**：aggregator 為單一 Node process 內的 in-memory singleton，重啟後累計歸零，節流與防重採「先 mark 再 send」。若未來拆成多 process / 多容器，需改用 Redis-backed 節流與鎖。

### Worker 失敗告警

crawlerWorker、dispatchWorker、updateWorker 在 job 用盡所有重試時，會呼叫 `logError("ERROR", ...)` 將失敗記錄寫入 DB 並計入告警聚合。

notifierWorker 的 job 用盡重試代表這則通知沒有送到使用者，它呼叫 `reportNotificationLost(board, keyword)`，不等五輪：

| 事件 | 行為 |
|------|------|
| 通知重試用盡 | 寫入 DB；距上次遺失告警已滿 30 分鐘（或從未發過）時立即推送，內容含 `keyword@board`，level 為 `error` |
| 30 分鐘內再有通知遺失 | 只累計數量，不另外推送 |
| 窗口結束時有累計 | 下一次 `closeAlertRound()` 推送「共 N 則沒有送出」 |

重試後成功、以及使用者封鎖 bot 這類永久錯誤（不重試，job 不算失敗）都不會觸發。告警只帶關鍵字與看板，不帶原始錯誤訊息。節流狀態在 `src/core/lostNotificationTracker.ts`（in-memory），重啟後歸零。開機 `flushdb` 清掉的排隊中通知不會經過這裡，因此不會告警。

### Admin Commands

- `/errors` — 列出最近 24 小時的錯誤（最多 50 筆）
- `/errors clear` — 標記所有錯誤為已處理

## BullMQ Job Retry & Retention

所有 queue 共用 `defaultJobOptions`：

```typescript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  // Retention caps to prevent unbounded BullMQ growth in Redis.
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 * 7, count: 5000 },
}
```

涵蓋的 queue：`crawler-queue`、`update-queue`、`maintenance-queue`、`dispatch-queue`、`notify-queue`、`matcher-queue`。

### Retry 策略

| Attempt | Delay |
|---------|-------|
| 1st retry | 5s |
| 2nd retry | 10s |
| 3rd retry | 20s |
| 之後 | Job 標記為 failed，觸發 logError 告警 |

### Retention 上限

| 結果 | 上限 | 說明 |
|------|------|------|
| Completed | 1 hour OR 1000 筆 | BullMQ 自動 prune，先到先清 |
| Failed | 7 days OR 5000 筆 | 保留較久供 debug |

> **歷史教訓**：早期沒設 `removeOnComplete` / `removeOnFail`，Redis db0 在 2 個月內累積 ~250 萬個 BullMQ hash key（1.2 GB）。設定 retention 後 BullMQ 會自己清，不需要額外 cleanup job 處理 completed。

## Circuit Breaker（熔斷機制）

當 PTT 無法連線時，避免持續發送無效請求。

**狀態機**: `CLOSED → OPEN → HALF_OPEN → CLOSED`

| 狀態轉換 | 觸發條件 |
|----------|----------|
| CLOSED → OPEN | 單輪 dispatch 中所有看板 crawl 全部失敗 |
| OPEN → HALF_OPEN | 等待 cooldown（2 分鐘）後允許下一輪嘗試 |
| HALF_OPEN → CLOSED | 嘗試成功，恢復正常運作 |
| HALF_OPEN → OPEN | 嘗試仍失敗，繼續熔斷 |

**OPEN 期間行為**:
- crawlerWorker 檢查 circuit 狀態，若 OPEN 則跳過執行
- dispatchCrawlerJobs 照常每分鐘結算告警輪，熔斷期間每一輪都算異常輪（見 Alert Aggregation）
- 不會完全停止排程，只是 worker 端 skip

**每輪計數規則**（`src/core/roundTracker.ts`）：一個看板每輪只貢獻一個結果，以第一個記錄到的為準，同看板後續的記錄一律忽略；整輪結果也只會回報給 circuit breaker 一次。這是必要的，因為同一個 crawl job 會多次進入 worker——BullMQ 會重試，而熔斷後重試又會走 skip 分支——否則失敗數會超過看板總數（log 出現 `Round N complete: 6/3 failed`），並且每多記一次就重複觸發一次 `recordRoundResult`。

已知限制：上一輪的重試有可能在下一輪 `startRound` 之後才落地，佔掉該看板的名額。重試會在 1 分鐘的 dispatch 間隔內跑完，因此極少發生，且下一輪就會自行修正。

實作於 `src/core/circuitBreaker.ts`（singleton `crawlerCircuit`）和 `src/core/roundTracker.ts`（追蹤每輪成功/失敗數）。

## BullMQ Failed Job Cleanup

主要靠 `defaultJobOptions.removeOnFail` 由 BullMQ 在 finalize 時自動 prune（見上一節）。

`runCleanup`（每小時執行）作為 backstop，呼叫 `queue.clean(24h, 100, "failed")` 補抓任何因為 retention 條件邊界沒被即時清掉的 failed jobs：

```
crawlerQueue, updateQueue, maintenanceQueue, dispatchQueue
→ queue.clean(24h, 100, "failed")
```
