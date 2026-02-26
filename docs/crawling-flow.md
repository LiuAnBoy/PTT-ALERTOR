# 爬取流程

## 概觀

爬蟲流程負責定時抓取 PTT 看板文章，解析 HTML，儲存新文章到 DB 和 Redis 快取。

## 流程圖

```
┌───────────┐    每 1 分鐘       ┌──────────────┐
│  排程器   │ ──────────────────►│ dispatchQueue│
└───────────┘                    └──────┬───────┘
                                        │
                                        ▼
                                ┌───────────────┐
                                │dispatchWorker │
                                │               │
                                │ redis.smembers│
                                │  ("boards")   │
                                └──────┬────────┘
                                       │ 針對每個看板
                                       ▼
                                ┌───────────────┐
                                │ crawlerQueue  │
                                │ (每個看板一個) │
                                └──────┬────────┘
                                       │
                                       ▼
                                ┌───────────────┐
                                │crawlerWorker  │
                                │  併發數：5    │
                                └──────┬────────┘
                                       │
                                       ▼
                              fetchNewArticles()
                                       │
                    ┌──────────────────┤
                    ▼                  ▼
             ┌─────────────┐   ┌──────────────┐
             │ fetchHtml() │   │filterNewArts │
             │ (pttClient) │   │ (Redis HASH) │
             └──────┬──────┘   └──────┬───────┘
                    │                 │
                    ▼                 ▼
             解析 HTML          過濾已快取的文章
             .r-ent 元素        (Filter out)
                    │                 │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ insertNewArticles│ (PostgreSQL)
                    ├─────────────────┤
                    │ cacheArticles   │ (Redis ZADD)
                    ├─────────────────┤
                    │ fetchDetail     │ (每篇文章)
                    ├─────────────────┤
                    │ matcherQueue.add│ (每篇文章)
                    └─────────────────┘
```

## 步驟詳解

### 1. 排程器派發 (每 1 分鐘)

`scheduler.ts` 設定重複性工作，觸發 `dispatchWorker`。

```
dispatchQueue → 每 60,000 毫秒 → dispatchWorker
```

### 2. 派發工作器 (Dispatch Worker)

讀取 Redis `boards` 集合，為每個有訂閱者的看板派發一個爬蟲任務 (crawler job)。

```typescript
const boards = await redis.smembers("boards");
for (const board of boards) {
  await crawlerQueue.add("crawl", { boardName: board });
}
```

### 3. 爬蟲工作器 (Crawler Worker)

每個爬蟲任務處理一個看板。工作器併發數為 5，表示同時最多爬取 5 個看板。

### 4. fetchHtml — HTML 抓取

1. 透過 `pttClient` (axios) 發送 GET 請求至 `https://www.ptt.cc/bbs/{board}/index.html`
2. 設定 `Cookie: over18=1` 以跳過年齡確認頁面
3. 使用 cheerio 解析 HTML

### 5. HTML 解析規則

| 元素 | 用途 |
|---------|------|
| `.r-ent` | 每篇文章的容器 |
| `.r-list-sep` | 置頂文分隔線 — 之後的 `.r-ent` 為置頂文，予以跳過 |
| `.title a` | 文章標題 + 連結 (href) |
| `.meta .author` | 作者 |
| `.nrec span` | 推文數文字 |

### 6. 推文數 (Push Count) 解析

| 文字 | 結果 |
|------|------|
| `""` (空) | 0 |
| `"爆"` | 100 |
| `"X1"` ~ `"X9"` | -10 ~ -90 |
| `"10"` | 10 |
| 非數字 | 0 |

### 7. 文章代碼 (Article Code) 提取

從連結 `/bbs/Gossiping/M.1234567890.A.ABC.html` 提取代碼 `M.1234567890.A.ABC`。

正規表達式：`/\/([GM]\.\d+\.A\.[A-Z0-9]+)\.html/`

### 8. ALLPOST 看板特殊處理

當 `boardName` 為 `allpost` 時，真實看板名稱會從標題末尾的 `(BoardName)` 提取，並替換連結中的 `ALLPOST`。

### 9. 過濾新文章 (Filter New Articles)

透過 `board:latest` HASH 取得該看板最新文章的時間戳記，過濾掉時間戳記 ≤ 此值的文章。若看板無紀錄（首次爬取），所有文章均視為新文章。

### 10. 儲存與快取 (Save & Cache)

- `insertNewArticles` → PostgreSQL (`createMany`, `skipDuplicates`)
- `cacheArticles` → Redis pipeline：ZADD `active:articles`（score = 時間戳記）+ HSET `board:latest`（更新最大時間戳記）

### 11. 抓取詳情頁面 (Fetch Detail Pages)

對每篇新文章呼叫 `fetchDetail(link)` 抓取內文頁面並解析：
- 推/噓/→ 計數
- 內文 (去除 metaline 和推文後的 `#main-content`)
- IP (來自 `"來自: x.x.x.x"`)
- 頁尾截斷 (丟棄 `"※ 發信站:"` 之後的內容)

### 12. 派發比對任務 (Dispatch Matcher Jobs)

將每篇新文章派發至 `matcher-queue`，內容包含看板、標題、代碼、作者、推文總數及連結。

## 更新流程 (每 15 分鐘)

```
updateQueue → updateWorker → updateActiveArticles()
```

1. 從 Redis `active:articles` ZSET 取得 24 小時內的文章代碼（`ZRANGEBYSCORE`）
2. 重新抓取詳情 (`fetchDetail`)，比對推文數和內文是否有變化
3. 若有變化 → 更新 DB
4. 若回傳 404 → 從 `active:articles` ZSET 移除該文章（`ZREM`）

## 錯誤處理

- HTTP 錯誤 → 記錄至 `crawler_logs` 並透過 AlertAggregator 聚合告警
- 404 → 使用 `ARTICLE_DELETED` 標記，從 Redis `active:articles` 移除
- 其他錯誤 → 回傳 null，跳過該文章
- BullMQ 任務失敗 → 使用指數退避進行重試 (最多 3 次)
- 任務重試用盡 → worker `on("failed")` 呼叫 `logError` 寫入 DB 並觸發告警

## Circuit Breaker（熔斷機制）

```
dispatchCrawlerJobs()
    │
    ├── Circuit OPEN + cooldown 未到？ → 跳過 dispatch，發送摘要告警
    ├── Circuit OPEN + cooldown 已到？ → HALF_OPEN，派發 probe round
    └── Circuit CLOSED？ → 正常派發
            │
            ▼
    crawlerWorker processor
            │
            ├── roundTracker.isCircuitOpen()？ → skip，記錄 failure
            └── 正常爬取 → try/catch 記錄 success/failure
                    │
                    ▼
            roundTracker.checkRoundComplete()
                    │
                    ├── 全滅 → circuitBreaker OPEN + 首則告警
                    └── 有成功 → 保持/恢復 CLOSED + 恢復通知
```

相關模組：
- `src/core/circuitBreaker.ts` — 熔斷狀態機
- `src/core/roundTracker.ts` — 每輪成功/失敗追蹤
- `src/core/alertAggregator.ts` — 告警聚合
