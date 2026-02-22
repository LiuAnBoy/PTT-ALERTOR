# Subscription Sync

## Overview

訂閱同步負責維持 PostgreSQL（source of truth）和 Redis（read cache）之間的資料一致性。

## 兩種同步機制

### 1. Full Sync — 啟動時

`syncSubscriptions()` 在 server bootstrap 時執行，將所有 DB 訂閱資料載入 Redis。

```
Server bootstrap
  │
  ├── connectDatabase()
  ├── connectRedis()       ← flushall（清除舊資料）
  ├── syncSubscriptions()  ← Full sync
  ├── startScheduler()
  └── startBot()
```

#### 流程

```
1. prisma.subscription.findMany()
   → [{ userId, board, keyword }, ...]

2. Group by:
   boards:         Set<board>
   boardSubs:      Map<board, Set<userId>>
   userKeywords:   Map<userId:board, Set<keyword>>

3. Redis pipeline:
   DEL boards
   DEL keyword:{board1}:subs
   DEL keyword:{board2}:subs
   SADD boards board1 board2
   SADD keyword:{board1}:subs userId1 userId2
   SADD keyword:{board2}:subs userId3
   DEL user:{userId1}:board:{board1}
   SADD user:{userId1}:board:{board1} kw1 kw2
   ...
   EXEC
```

#### 為什麼用 flushall + full sync？

- Redis 啟動時是空的（`connectRedis` 呼叫 `flushall`）
- 確保 Redis 和 DB 完全一致，無殘留資料
- 單次 pipeline 批次寫入，效率高

### 2. Real-time Sync — 使用者操作時

使用者透過 Telegram bot 新增或刪除訂閱時，同時寫入 DB 和 Redis。

#### 新增訂閱

```
handleAdd (bot handler)
  │
  ├── addSubscription()        → PostgreSQL INSERT
  └── addSubscriptionToRedis() → Redis sync
        │
        ├── isCacheEmpty(board)?
        │   │
        │   ├── YES: seed cache
        │   │   ├── fetchHtml(board) → 抓取目前看板文章
        │   │   └── cacheArticles()  → 寫入 Redis ZSET
        │   │   (避免既有文章被視為「新文章」觸發誤報)
        │   │
        │   └── NO: skip seeding
        │
        └── Redis pipeline:
            SADD boards {board}
            SADD keyword:{board}:subs {userId}
            SADD user:{userId}:board:{board} {keyword}
```

#### 刪除訂閱

```
handleDelete (bot handler)
  │
  ├── deleteSubscription()          → PostgreSQL DELETE
  └── removeSubscriptionFromRedis() → Redis sync
        │
        ├── SREM user:{userId}:board:{board} {keyword}
        │
        ├── SCARD user:{userId}:board:{board}
        │   │
        │   └── 0 (no remaining keywords):
        │       │
        │       ├── SREM keyword:{board}:subs {userId}
        │       │
        │       └── SCARD keyword:{board}:subs
        │           │
        │           └── 0 (no remaining subscribers):
        │               └── SREM boards {board}
        │
        └── > 0: done (user still has other keywords on this board)
```

#### Cascading Cleanup 邏輯

刪除訂閱時的清理是逐層的：

```
keyword removed
  └── user has no more keywords on this board?
      └── YES: remove user from board subscriber set
          └── board has no more subscribers?
              └── YES: remove board from boards set
                  (scheduler will stop crawling this board)
```

## Redis Key Patterns

| Key | Type | Purpose |
|-----|------|---------|
| `boards` | SET | 所有有訂閱者的看板 |
| `keyword:{board}:subs` | SET | 訂閱某看板的所有 user ID |
| `user:{userId}:board:{board}` | SET | 某 user 在某看板的所有 keyword |
| `board:{board}:articles` | ZSET | 文章快取（score = timestamp） |

## Cache Seeding

新增訂閱到一個全新看板時，article cache 是空的。如果不 seed，下次 crawl 會把所有既有文章當成「新文章」，觸發大量誤報通知。

Seeding 流程：
1. `isCacheEmpty(board)` → `zcard board:{board}:articles === 0`
2. `fetchHtml(board)` → 抓取目前看板上的文章
3. `cacheArticles(board, articles)` → 寫入 Redis ZSET

如果 fetchHtml 失敗（例如看板名稱拼錯但 boardValidator 沒攔到），只 warn 不中斷，訂閱仍會建立。
