# 訂閱同步

## 概觀

訂閱同步負責維持 PostgreSQL（事實來源）與 Redis（讀取快取）之間的資料一致性。

## 兩種同步機制

### 1. 全量同步 — 啟動時 (Full Sync)

`syncSubscriptions()` 在伺服器引導 (bootstrap) 時執行，將資料庫中的所有訂閱資料載入 Redis。

```
伺服器引導
  │
  ├── connectDatabase()
  ├── connectRedis()       ← flushdb（只清本服務 db）
  ├── syncSubscriptions()  ← 全量同步訂閱
  ├── seedArticleCache()   ← 從 DB 回填 24h 內文章至 Redis
  ├── startScheduler()
  └── startBot()
```

#### 流程

```
1. prisma.subscription.findMany()
   → [{ userId, board, keyword }, ...]

2. 分組處理:
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

#### 為什麼使用 `flushdb` + 全量同步？

- Redis 啟動時把本服務的 db 清空（`connectRedis` 呼叫 `flushdb`，預設 db0）。
  使用 `flushdb` 而非 `flushall`，避免影響共用 Redis instance 上其他服務的 db。
- 確保 Redis 和資料庫完全一致，無殘留舊資料。
- 單次 pipeline 批次寫入，效率最高。

### 2. 即時同步 — 使用者操作時 (Real-time Sync)

使用者透過 Telegram Bot 新增或刪除訂閱時，同時寫入資料庫與 Redis。

#### 新增訂閱

```
handleAdd (Bot handler)
  │
  ├── addSubscription()        → PostgreSQL INSERT
  └── addSubscriptionToRedis() → Redis 同步
        │
        ├── HEXISTS board:latest {board}?
        │   │
        │   ├── 否：植入快取 (Seed Cache)
        │   │   ├── fetchHtml(board) → 抓取目前看板文章
        │   │   └── cacheArticles()  → ZADD active:articles + HSET board:latest
        │   │   (避免既有文章被視為「新文章」而誤報)
        │   │
        │   └── 是：跳過植入（看板已有時間基準）
        │
        └── Redis pipeline:
            SADD boards {board}
            SADD keyword:{board}:subs {userId}
            SADD user:{userId}:board:{board} {keyword}
```

#### 刪除訂閱

```
handleDelete (Bot handler)
  │
  ├── deleteSubscription()          → PostgreSQL DELETE
  └── removeSubscriptionFromRedis() → Redis 同步
        │
        ├── SREM user:{userId}:board:{board} {keyword}
        │
        ├── SCARD user:{userId}:board:{board}
        │   │
        │   └── 0 (使用者已無該看板關鍵字)：
        │       │
        │       ├── SREM keyword:{board}:subs {userId}
        │       │
        │       └── SCARD keyword:{board}:subs
        │           │
        │           └── 0 (該看板已無任何訂閱者)：
        │               ├── SREM boards {board}
        │               └── HDEL board:latest {board}
        │
        └── > 0：完成 (使用者仍有該看板的其他關鍵字)
```

#### 階層式清理邏輯 (Cascading Cleanup)

刪除訂閱時採逐層清理：

```
關鍵字移除
  └── 使用者是否已無該看板之關鍵字？
      └── 是：從看板訂閱者集合中移除使用者
          └── 該看板是否已無任何訂閱者？
              └── 是：從看板列表集合中移除該看板
                  + 從 board:latest HASH 移除該看板
                  (排程器將停止爬取此看板)
```

## Redis 鍵名模式 (Key Patterns)

| 鍵 (Key) | 型別 | 用途 |
|-----|------|---------|
| `boards` | SET | 所有有訂閱者的看板 |
| `keyword:{board}:subs` | SET | 訂閱某看板的所有使用者 ID |
| `user:{userId}:board:{board}` | SET | 某使用者在某看板的所有關鍵字 |
| `board:latest` | HASH | 各看板最新文章時間戳記（field = 看板名稱） |
| `active:articles` | ZSET | 24h 內活躍文章（score = 時間戳記，member = `{board}:{code}`） |

## 快取植入 (Cache Seeding)

### 即時植入 — 新增訂閱時

當新增一個全新看板的訂閱時，`board:latest` HASH 中無該看板紀錄。若不預先植入，下次爬蟲會將看板內的所有既有文章視為「新文章」，導致大量誤報通知。

植入流程：
1. `hasLatestTimestamp(board)` → `HEXISTS board:latest {board}`
2. 若不存在：`fetchHtml(board)` → 抓取看板當前的文章
3. `cacheArticles(board, articles)` → ZADD `active:articles` + HSET `board:latest`

若 `fetchHtml` 失敗（例如看板名稱錯誤但 `boardValidator` 未攔截），系統會發出警告但不會中斷流程，訂閱仍會成功建立。

### 啟動植入 — 伺服器重啟時

伺服器重啟時 `connectRedis()` 執行 `flushdb`，本服務 db 清空（其他 db 不動）。`seedArticleCache()` 從 DB 回填最近 24 小時的文章：

```
seedArticleCache()
  │
  ├── redis.smembers("boards") → 取得所有訂閱看板
  ├── prisma.article.findMany({ timestamp >= 24h前 }) → 查詢 DB
  │
  ├── 計算每個看板的最大 timestamp
  │   └── HSET board:latest {board} {maxTimestamp}
  │
  └── 寫入所有文章至 active:articles ZSET
      └── ZADD active:articles {timestamp} {board}:{code}
```

確保重啟後 updateWorker 能繼續追蹤推文，且不會重複推播舊文章。
