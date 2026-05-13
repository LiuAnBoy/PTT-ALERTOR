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

所有關鍵字都統一以正則表達式比對（不分大小寫）。流程：

1. **Backward compat**：若以 `regexp:` 開頭則去掉前綴
2. **AND 拆分**：若 keyword 含 `&`，按 `&` 拆成多個子 pattern；否則視為單一子 pattern
3. **逐一比對**：每個子 pattern 透過 `getRegex()` 編譯後 `regex.test(title)`
4. **AND 語意**：所有子 pattern 都需命中才回傳 true

#### 範例

```
關鍵字: "問卦"             → /問卦/i.test(title)              ← 單一 pattern
關鍵字: "問卦|爆卦"        → /問卦|爆卦/i.test(title)         ← regex OR
關鍵字: "售&ps5"           → /售/i.test(title) && /ps5/i.test(title)  ← AND
關鍵字: "regexp:問卦.*貓"  → /問卦.*貓/i.test(title)          ← legacy 前綴
關鍵字: "C++"              → 無效 regex → escape 後 /C\+\+/i.test(title)
```

### 正規表達式快取 (Regex Cache)

`regexCache.ts` 使用記憶體內 `Map<string, RegExp>` 快取已編譯的正規表達式，以避免重複編譯。

- 同樣的樣式僅編譯一次（AND 模式下每個子 pattern 各自快取）
- 無效樣式 → escape 後當字面字串重新編譯 → 仍會被 cache
- ReDoS 不安全的 pattern → 回傳 null → `matchKeyword` 回傳 false + `logError`

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
