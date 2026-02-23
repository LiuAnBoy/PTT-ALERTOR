# 比對流程

## 概觀

比對流程負責將新文章的標題與使用者的訂閱關鍵字進行匹配，找出所有需要通知的使用者與關鍵字配對。

## 流程圖

```
┌───────────────┐
│ crawlerService│
│               │
│ matcherQueue  │
│  .add("match")│
└──────┬────────┘
       │ 每篇新文章
       ▼
┌───────────────┐
│ matcherWorker │
│  併發數：5    │
└──────┬────────┘
       │
       ▼
  matchArticle(board, title)
       │
       ├─── redis.smembers("keyword:{board}:subs")
       │    → [userId1, userId2, ...]
       │
       ├─── 針對每個 userId:
       │    redis.smembers("user:{userId}:board:{board}")
       │    → [keyword1, keyword2, ...]
       │
       ├─── 針對每個關鍵字:
       │    matchKeyword(title, keyword)
       │    → true / false
       │
       └─── 收集匹配項
            → [{ userId, keyword }, ...]
                    │
                    ▼
           ┌────────────────┐
           │ notifyQueue    │
           │  .add("notify")│ 每個匹配項
           └────────────────┘
```

## 匹配演算法

### matchKeyword(title, keyword)

支援兩種模式：

#### 1. 純文字匹配 (Plain Text Match)

```
關鍵字: "問卦"
標題:   "[問卦] 有人跟我一樣嗎"
→ title.toLowerCase().includes(keyword.toLowerCase())
→ true (不分大小寫的子字串匹配)
```

#### 2. 正規表達式匹配 (Regex Match)

使用 `regexp:` 前置詞觸發：

```
關鍵字: "regexp:問卦|爆卦"
樣式: "問卦|爆卦"
→ new RegExp(pattern, "i").test(title)
→ true
```

### 正規表達式快取 (Regex Cache)

`regexCache.ts` 使用記憶體內 `Map<string, RegExp>` 快取已編譯的正規表達式，以避免重複編譯。

- 同樣的樣式僅編譯一次
- 無效樣式 → 回傳 null → `matchKeyword` 回傳 false + `logError`

## Redis 資料結構

比對過程完全基於 Redis，零資料庫查詢：

```
boards (SET)
  └─ "Gossiping"
  └─ "Stock"

keyword:Gossiping:subs (SET)        ← 訂閱 Gossiping 的所有使用者 ID
  └─ "user-uuid-1"
  └─ "user-uuid-2"

user:user-uuid-1:board:Gossiping (SET)  ← 使用者-1 在 Gossiping 的所有關鍵字
  └─ "問卦"
  └─ "regexp:爆卦.*"

user:user-uuid-2:board:Gossiping (SET)
  └─ "政治"
```

## 匹配範例

```
新文章: { board: "Gossiping", title: "[問卦] 有沒有八卦" }

1. redis.smembers("keyword:Gossiping:subs") → ["user-1", "user-2"]

2. 使用者-1:
   redis.smembers("user:user-1:board:Gossiping") → ["問卦", "regexp:爆卦.*"]
   matchKeyword("[問卦] 有沒有八卦", "問卦")       → true ✓
   matchKeyword("[問卦] 有沒有八卦", "regexp:爆卦.*") → false

3. 使用者-2:
   redis.smembers("user:user-2:board:Gossiping") → ["政治"]
   matchKeyword("[問卦] 有沒有八卦", "政治")        → false

結果: [{ userId: "user-1", keyword: "問卦" }]
```

## 派送至通知器 (Dispatch to Notifier)

每個比對結果皆派送至 `notify-queue`：

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

## 錯誤處理

| 情境 | 行為 |
|------|------|
| 正規表達式無效 | `logError("WARN")`, 回傳 false, 不中斷其他關鍵字比對 |
| Redis `smembers` 失敗 | 向上拋出，由 BullMQ 重試 |
| 無訂閱者 | 直接回傳 [], 不進入比對迴圈 |
