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
| **FATAL** | 立即推送到 admin Telegram |
| **ERROR** | 透過 AlertAggregator 聚合（見下方） |
| **WARN** | 僅寫入 DB，不推送 |

### Alert Aggregation（告警聚合）

取代舊版 per-key cooldown，避免大量錯誤時通知轟炸。

**狀態機**: `NORMAL → ALERTING → NORMAL`

每筆 ERROR 會先經 `errorClassifier.ts` 的 `classifyError(detail)` 歸入粗分類，再交給 aggregator 累計。分類依 `detail` 的結構化欄位判斷（非 message 字串）：

| 分類 | 判斷依據 | 顯示 |
|------|----------|------|
| `HTTP_5XX` | `detail.httpStatus` 500–599 | PTT 伺服器錯誤(5xx) |
| `HTTP_4XX` | `detail.httpStatus` 400–499 | 用戶端/權限錯誤(4xx) |
| `TIMEOUT` | 訊息含 `ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`/`ECONNABORTED`/`timeout` | 連線逾時/中斷 |
| `PARSE` | `detail.kind === "parse"`（產生端明確標記） | 頁面解析失敗 |
| `OTHER` | 其餘 | 其他錯誤 |

| 事件 | 行為 |
|------|------|
| 第一筆 ERROR | 立即推送首則告警（含首個錯誤分類），進入 ALERTING 狀態 |
| 後續 ERROR（ALERTING 中） | 僅按分類計數，不推播 |
| Circuit Breaker OPEN 期間 | 每 30 分鐘最多推送一則進度告警（`sendProgressAlert()` 以 `lastProgressAt` 節流） |
| 恢復正常 | 推送恢復報告（異常期間起訖、持續分鐘、累計次數、各分類次數），再重置計數器 |

**訊息類型**：首次告警（⚠️）、進度告警（⏳，每 30 分節流）、恢復報告（✅，含問題分布）。恢復報告務必在 `recover()` 清除計數器**之前**產生。

實作於 `src/core/alertAggregator.ts`（in-memory singleton），由 `errorLogger.ts` 的 `logError()` / `sendProgressAlert()` / `sendRecoveryAlert()` 觸發。

> **已知限制**：aggregator 為單一 Node process 內的 in-memory singleton，節流與防重採「先 mark 再 send」。若未來拆成多 process / 多容器，需改用 Redis-backed 節流與鎖。

### Worker 失敗告警

所有 BullMQ worker（crawlerWorker、dispatchWorker、updateWorker）在 job 用盡所有重試時，會呼叫 `logError("ERROR", ...)` 將失敗記錄寫入 DB 並觸發告警系統。

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
- dispatchCrawlerJobs 呼叫 `sendProgressAlert()`（每 30 分鐘最多一則進度告警，非每輪洗版）
- 不會完全停止排程，只是 worker 端 skip

實作於 `src/core/circuitBreaker.ts`（singleton `crawlerCircuit`）和 `src/core/roundTracker.ts`（追蹤每輪成功/失敗數）。

## BullMQ Failed Job Cleanup

主要靠 `defaultJobOptions.removeOnFail` 由 BullMQ 在 finalize 時自動 prune（見上一節）。

`runCleanup`（每小時執行）作為 backstop，呼叫 `queue.clean(24h, 100, "failed")` 補抓任何因為 retention 條件邊界沒被即時清掉的 failed jobs：

```
crawlerQueue, updateQueue, maintenanceQueue, dispatchQueue
→ queue.clean(24h, 100, "failed")
```
