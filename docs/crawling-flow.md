# Crawling Flow

## Overview

爬蟲流程負責定時抓取 PTT 看板文章，解析 HTML，儲存新文章到 DB 和 Redis Cache。

## Flow Diagram

```
┌───────────┐    every 1 min     ┌──────────────┐
│ Scheduler │ ──────────────────►│ dispatchQueue│
└───────────┘                    └──────┬───────┘
                                        │
                                        ▼
                                ┌───────────────┐
                                │dispatchWorker │
                                │               │
                                │ redis.smembers│
                                │  ("boards")   │
                                └──────┬────────┘
                                       │ for each board
                                       ▼
                                ┌───────────────┐
                                │ crawlerQueue  │
                                │  (per board)  │
                                └──────┬────────┘
                                       │
                                       ▼
                                ┌───────────────┐
                                │crawlerWorker  │
                                │ concurrency:5 │
                                └──────┬────────┘
                                       │
                                       ▼
                              fetchNewArticles()
                                       │
                    ┌──────────────────┤
                    ▼                  ▼
             ┌─────────────┐   ┌──────────────┐
             │ fetchHtml() │   │filterNewArts │
             │ (pttClient) │   │ (Redis ZSET) │
             └──────┬──────┘   └──────┬───────┘
                    │                 │
                    ▼                 ▼
             Parse HTML         Filter cached
             .r-ent elements    articles out
                    │                 │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ insertNewArticles│ (PostgreSQL)
                    ├─────────────────┤
                    │ cacheArticles   │ (Redis ZADD)
                    ├─────────────────┤
                    │ fetchDetail     │ (per article)
                    ├─────────────────┤
                    │ matcherQueue.add│ (per article)
                    └─────────────────┘
```

## Step by Step

### 1. Scheduler Dispatch (every 1 min)

`scheduler.ts` 設定 repeatable job，觸發 `dispatchWorker`。

```
dispatchQueue → every 60,000ms → dispatchWorker
```

### 2. Dispatch Worker

讀取 Redis `boards` SET，為每個有訂閱者的看板派發一個 crawler job。

```typescript
const boards = await redis.smembers("boards");
for (const board of boards) {
  await crawlerQueue.add("crawl", { boardName: board });
}
```

### 3. Crawler Worker

每個 crawler job 處理一個看板。Worker concurrency 為 5，同時最多爬 5 個看板。

### 4. fetchHtml — HTML 抓取

1. 透過 `pttClient`（axios）GET `https://www.ptt.cc/bbs/{board}/index.html`
2. 設定 `Cookie: over18=1` 跳過年齡確認
3. 用 cheerio 解析 HTML

### 5. HTML 解析規則

| Element | 用途 |
|---------|------|
| `.r-ent` | 每篇文章的容器 |
| `.r-list-sep` | 置頂文分隔線 — 之後的 `.r-ent` 是置頂文，跳過 |
| `.title a` | 文章標題 + href |
| `.meta .author` | 作者 |
| `.nrec span` | 推文數文字 |

### 6. Push Count 解析

| 文字 | 結果 |
|------|------|
| `""` (空) | 0 |
| `"爆"` | 100 |
| `"X1"` ~ `"X9"` | -10 ~ -90 |
| `"10"` | 10 |
| 非數字 | 0 |

### 7. Article Code 提取

從 href `/bbs/Gossiping/M.1234567890.A.ABC.html` 提取 code `M.1234567890.A.ABC`。

Regex: `/\/([GM]\.\d+\.A\.[A-Z0-9]+)\.html/`

### 8. ALLPOST 看板特殊處理

當 boardName 為 `allpost` 時，真實看板名從標題末尾的 `(BoardName)` 提取，並替換 link 中的 `ALLPOST`。

### 9. Filter New Articles

用 Redis ZSET pipeline `zscore` 批次查詢，score 為 null 的代表新文章。

### 10. Save & Cache

- `insertNewArticles` → PostgreSQL (`createMany`, `skipDuplicates`)
- `cacheArticles` → Redis ZADD（score = timestamp）

### 11. Fetch Detail Pages

對每篇新文章呼叫 `fetchDetail(link)` 抓取內文頁面，解析：
- 推/噓/→ 計數
- 內文（去除 metaline 和推文後的 `#main-content`）
- IP（from `"來自: x.x.x.x"`）
- Footer 截斷（`"※ 發信站:"` 之後丟棄）

### 12. Dispatch Matcher Jobs

每篇新文章派發到 `matcher-queue`，payload 包含 board, title, code, author, pushSum, link。

## Update Flow (every 15 min)

```
updateQueue → updateWorker → updateActiveArticles()
```

1. 從 DB 取得所有未過期文章（`expireAt > now`）
2. 重新 fetchDetail，比對推文數和內文是否有變化
3. 有變化 → update DB
4. 404 → 標記文章過期

## Error Handling

- HTTP 錯誤 → 記錄到 `crawler_logs` + admin Telegram alert
- 404 → `ARTICLE_DELETED` sentinel，標記過期
- 其他錯誤 → return null，跳過該文章
- BullMQ job 失敗 → exponential backoff retry（最多 3 次）
