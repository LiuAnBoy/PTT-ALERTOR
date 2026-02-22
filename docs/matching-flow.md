# Matching Flow

## Overview

比對流程負責將新文章的標題與使用者的訂閱關鍵字進行匹配，找出所有需要通知的 user-keyword 配對。

## Flow Diagram

```
┌───────────────┐
│ crawlerService│
│               │
│ matcherQueue  │
│  .add("match")│
└──────┬────────┘
       │ per new article
       ▼
┌───────────────┐
│ matcherWorker │
│ concurrency:5 │
└──────┬────────┘
       │
       ▼
  matchArticle(board, title)
       │
       ├─── redis.smembers("keyword:{board}:subs")
       │    → [userId1, userId2, ...]
       │
       ├─── for each userId:
       │    redis.smembers("user:{userId}:board:{board}")
       │    → [keyword1, keyword2, ...]
       │
       ├─── for each keyword:
       │    matchKeyword(title, keyword)
       │    → true / false
       │
       └─── collect matches
            → [{ userId, keyword }, ...]
                    │
                    ▼
           ┌────────────────┐
           │ notifyQueue    │
           │  .add("notify")│ per match
           └────────────────┘
```

## Matching Algorithm

### matchKeyword(title, keyword)

兩種模式：

#### 1. Plain Text Match

```
keyword: "問卦"
title:   "[問卦] 有人跟我一樣嗎"
→ title.toLowerCase().includes(keyword.toLowerCase())
→ true (case-insensitive substring match)
```

#### 2. Regex Match

以 `regexp:` 前綴觸發：

```
keyword: "regexp:問卦|爆卦"
pattern: "問卦|爆卦"
→ new RegExp(pattern, "i").test(title)
→ true
```

### Regex Cache

`regexCache.ts` 使用 in-memory `Map<string, RegExp>` 快取已編譯的 RegExp，避免重複編譯。

- 同一個 pattern 只編譯一次
- Invalid pattern → return null → matchKeyword return false + logError

## Redis Data Structure

匹配過程完全基於 Redis，零 DB 查詢：

```
boards (SET)
  └─ "Gossiping"
  └─ "Stock"

keyword:Gossiping:subs (SET)        ← 訂閱 Gossiping 的所有 user ID
  └─ "user-uuid-1"
  └─ "user-uuid-2"

user:user-uuid-1:board:Gossiping (SET)  ← user-1 在 Gossiping 的所有 keyword
  └─ "問卦"
  └─ "regexp:爆卦.*"

user:user-uuid-2:board:Gossiping (SET)
  └─ "政治"
```

## Match Example

```
New article: { board: "Gossiping", title: "[問卦] 有沒有八卦" }

1. redis.smembers("keyword:Gossiping:subs") → ["user-1", "user-2"]

2. user-1:
   redis.smembers("user:user-1:board:Gossiping") → ["問卦", "regexp:爆卦.*"]
   matchKeyword("[問卦] 有沒有八卦", "問卦")       → true ✓
   matchKeyword("[問卦] 有沒有八卦", "regexp:爆卦.*") → false

3. user-2:
   redis.smembers("user:user-2:board:Gossiping") → ["政治"]
   matchKeyword("[問卦] 有沒有八卦", "政治")        → false

Result: [{ userId: "user-1", keyword: "問卦" }]
```

## Dispatch to Notifier

每個 match 結果派發到 `notify-queue`：

```typescript
await notifyQueue.add("notify", {
  userId: match.userId,
  keyword: match.keyword,
  articleCode: code,
  board,
  title,
  author,
  pushSum,
  link,
});
```

## Error Handling

| 情境 | 行為 |
|------|------|
| Invalid regex pattern | logError("WARN"), return false, 不中斷其他 keyword |
| Redis smembers 失敗 | 向上拋出，BullMQ retry |
| 無訂閱者 | 直接回傳 [], 不進入匹配迴圈 |
