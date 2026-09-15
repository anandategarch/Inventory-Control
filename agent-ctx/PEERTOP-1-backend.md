# PEERTOP-1 — Backend: queryPeerTopItems + route + definisi Top Item

Task ID: PEERTOP-1
Agent: Main (Z.ai Code)
Task: Backend untuk fitur "top item di tiap peer" — query union lintas peer, route API, schema validasi, dan penguatan definisi "top item" (agregat per item) di query utama peer.

## Work Log
- Ekplorasi kontrak (lihat chat): peer-comparison{,-items}.ts (CTE band sales ±10%, kelompok scoping, numeric latest-week fix R-8), items route (clamp pattern), DIRECTION_FROM_SUM_SQL (shared.ts:111 — konvensi arah level item), queryTopItemsByNominal (konvensi absNominal/agregat), barrel queries/index.ts, validation.ts schema family, tests/ (tidak ada test peer-query yang mematok SQL).
- NEW `src/lib/queries/outlets/peer-top-items.ts` — `queryPeerTopItems(outletCode, month, week, mode, topN, limit, kelompok)`:
  - CTE `sales_mode`/`target`/`target_fallback`/`target_combined`/`peer_outlets` disalin verbatim dari queryPeerComparison (termasuk ORDER BY ABS(sales diff) + LIMIT limit+1 → band peer IDENTIK dengan Peer Table untuk param sama — kontrak eksplisit bagi FE/PDF).
  - CTE `outlet_item_aggs`: agregat per (outlet, item) — SUM(absNominalDeviasi) sebagai absNominal, devBom = SUM(ABS(qtyDeviasi))/SUM(ABS(qtyBom)) (volume-weighted, CASE guard), arah = DIRECTION_FROM_SUM_SQL, rn = ROW_NUMBER PARTITION BY outlet ORDER BY SUM(absNominalDeviasi) DESC; filter absNominalDeviasi > 0 + outlet IN peer_outlets; withStatementTimeout.
  - Final SELECT: `WHERE po."isTarget" OR oia."rn" <= topN` — target menyumbang SEMUA item-nya (rank bisa > topN → "di luar top-N"; deteksi blind spot), peer hanya top-N.
  - Grouping JS: perPeer (top-N per outlet, urut rn), union (rn ≤ topN semua outlet; peerTopCount/peerTopCodes/peerAvg ABSOLUTE/peerMaxAbsNominal; target = baris top-N target ∪ indeks full target), sort peerTopCount desc → target absNominal desc → peerMaxAbsNominal desc → nama.
- Barrel `src/lib/queries/index.ts`: re-export `./outlets/peer-top-items`.
- `src/lib/validation.ts`: `peerTopItemsQuerySchema` (outletCode/month/week/kelompok — topN/limit/mode diparse manual di route ala items route supaya nilai bogus tak mencemari cache key).
- NEW `src/app/api/peer-comparison/top-items/route.ts` — thin shell: rate limit bucket sendiri, zod, mode normalize (BUG-H style), topN clamp 1..10 + limit clamp 1..100 (Math.max lower bound — pola BUG-H LIMIT negatif), kelompok 'all'→null sekali (anti cache-poisoning BUG-2-b), month resolver, buildCacheKey route 'peer-comparison-top-items' + extra {mode,topN,limit}, TTL 5 menit + dedup, errorResponse gated, maxDuration 60. Respons sengaja TANPA peerCount — denominator diturunkan caller dari peers[] route utama (band identik).
- DEFINITION FIX `src/lib/queries/outlets/peer-comparison.ts`: CTE top_items diubah dari single-record (ROW_NUMBER over records) → agregat per (outlet, item) SUM(absNominalDeviasi) — kini satu definisi dengan queryPeerComparisonItems & queryPeerTopItems; kolom mati `topItemNominalRaw` (PEER-BACKEND-9) dihapus dari outlet_aggs.
- Gerbang lokal: tsc exit 0 sebelum diserahkan ke agent FE/PDF.

## Stage Summary
- Kontrak API terkunci lebih dulu oleh Main → 2 agent paralel (PEERTOP-2-a FE, PEERTOP-2-b PDF) membangun di atas kontrak tanpa drift.
- Band peer dijamin identik antara route utama/items/top-items (CTE + ORDER + LIMIT sama) → perPeer map 1:1 ke baris Peer Table; ekspansi row dan denominator "m dari n" konsisten.
- Terminologi master context dijaga: rata-rata ABSOLUTE, arah LOSS/SURPLUS via DIRECTION_FROM_SUM_SQL, tanpa notasi pp, kelompok scope peer-set only, sales secrecy di PDF.
- Commit: f927969 (gabungan PEERTOP-1/2-a/2-b).
