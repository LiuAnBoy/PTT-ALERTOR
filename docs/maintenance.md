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

| 事件 | 行為 |
|------|------|
| 第一筆 ERROR | 立即推送首則告警，進入 ALERTING 狀態 |
| 後續 ERROR（ALERTING 中） | 僅計數（按 module 分組），不推播 |
| Circuit Breaker OPEN 期間 | 每輪 dispatch 發送聚合摘要 |
| 恢復正常 | 推送恢復通知（含故障持續時間和統計），重置計數器 |

實作於 `src/core/alertAggregator.ts`（in-memory singleton），由 `errorLogger.ts` 的 `logError()` 觸發。

### Worker 失敗告警

所有 BullMQ worker（crawlerWorker、dispatchWorker、updateWorker）在 job 用盡所有重試時，會呼叫 `logError("ERROR", ...)` 將失敗記錄寫入 DB 並觸發告警系統。

### Admin Commands

- `/errors` — 列出最近 24 小時的錯誤（最多 50 筆）
- `/errors clear` — 標記所有錯誤為已處理

## BullMQ Job Retry

所有 queue 都設定 retry 策略：

```typescript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
}
```

| Attempt | Delay |
|---------|-------|
| 1st retry | 5s |
| 2nd retry | 10s |
| 3rd retry | 20s |
| 之後 | Job 標記為 failed，觸發 logError 告警 |

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
- dispatchCrawlerJobs 發送聚合摘要告警
- 不會完全停止排程，只是 worker 端 skip

實作於 `src/core/circuitBreaker.ts`（singleton `crawlerCircuit`）和 `src/core/roundTracker.ts`（追蹤每輪成功/失敗數）。

## BullMQ Failed Job Cleanup

`runCleanup`（每小時執行）會清理所有 queue 中超過 24 小時的 failed jobs：

```
crawlerQueue, updateQueue, maintenanceQueue, dispatchQueue
→ queue.clean(24h, 100, "failed")
```

避免 failed jobs 在 Redis 中無限堆積。
