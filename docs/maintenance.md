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
| **ERROR** | 5 分鐘 cooldown（相同 module+message 組合不重複推送） |
| **WARN** | 僅寫入 DB，不推送 |

Cooldown 透過 in-memory `Map<string, number>` 實作（`errorLogger.ts`）。

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
| 之後 | Job 標記為 failed |
