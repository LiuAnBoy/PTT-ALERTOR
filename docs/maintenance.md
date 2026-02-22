# Maintenance & Cleanup

## Overview

系統定期執行清理任務，移除過期資料以控制儲存空間和查詢效能。

## Schedule

```
maintenanceQueue → every 3,600,000ms (1 hour) → maintenanceWorker → runCleanup()
```

## Cleanup Tasks

### 1. Article Cleanup

**保留期限**: 7 天

```sql
DELETE FROM articles WHERE created_at < (now - 7 days)
```

### 2. Crawler Log Cleanup

**保留期限**: 30 天

```sql
DELETE FROM crawler_logs WHERE created_at < (now - 30 days)
```

### 3. Redis Cache Cleanup

**保留期限**: 7 天（與 article 一致）

```
for each key matching "board:*:articles":
  ZREMRANGEBYSCORE key -inf {cutoff_timestamp}
```

`cutoff_timestamp` = (now - 7 days) 的 Unix timestamp（秒）。

## Article Lifecycle

```
  fetchHtml → New article discovered
      │
      ▼
  insertNewArticles (PostgreSQL)
  cacheArticles (Redis ZADD, score = timestamp)
  expireAt = now + 3 days
      │
      ▼
  updateActiveArticles (every 15 min)
  ← refreshes detail for articles where expireAt > now
      │
      ├── detail changed → UPDATE
      ├── 404 → expireArticle (set expireAt = now)
      └── no change → skip
      │
      ▼
  runCleanup (every 1 hour)
  ← deletes articles where createdAt < (now - 7 days)
  ← removes Redis cache entries with score < cutoff
```

### Expiry vs Cleanup

| 概念 | 欄位/Key | 用途 |
|------|----------|------|
| **Expiry** (3 days) | `article.expireAt` | 控制 updateWorker 是否繼續追蹤 |
| **Cleanup** (7 days) | `article.createdAt` | 實際從 DB 和 Redis 移除 |

文章在 3 天後停止被 update，7 天後被完全刪除。

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
