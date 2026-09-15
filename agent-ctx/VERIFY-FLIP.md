---
Task ID: VERIFY-FLIP
Agent: full-stack-developer
Task: Audit kecocokan implementasi Flip Pattern Detection (Phase A+B+C) vs MASTER_CONTEXT.md §"Flip Pattern Detection" (baris 344-382, single source of truth). Verifikasi formula baris-per-baris, FE/BE parity, sort/filter/aggregate, lalu fix mismatch dgn diff minimal di domain flip saja.

Work Log:

## 0. File yang dibaca penuh / diverifikasi

- `MASTER_CONTEXT.md` L330-389 (kutipan verbatim spesifikasi flip)
- `src/lib/flip-metrics.ts` (99 LOC — modul formula tunggal, lihat DOC-STALE #1)
- `src/components/dashboard/tabs/ItemTrendTab/flipHelpers.ts` (370 LOC)
- `src/components/dashboard/tabs/ItemTrendTab/flip-badges.ts`, `FlipMatrix.tsx`, `FlipSummaryCard.tsx`, `FlipDrillPanel.tsx`
- `src/components/dashboard/tabs/ItemTrendTab/FlipRanking/` (index, types, Row, TableHeader, Header, States)
- `src/components/dashboard/tabs/ItemTrendTab/ItemTrendTable/FlipCell.tsx` + `index.tsx` + `ItemTrendTableHeader.tsx` + `patternBadge.ts` (READ-ONLY utk verifikasi)
- `src/components/dashboard/tabs/ItemTrendTab/hooks/useItemTrendDerived.ts` + `useTrendTableSort.ts` (READ-ONLY — domain VERIFY-DISPLAY)
- `src/components/dashboard/tabs/ItemTrendLineChart.tsx` (hanya bagian anotasi flip)
- `src/lib/queries/items/flip-ranking.ts` (379 LOC) + `flip-drilldown.ts` + `item-outlet-breakdown.ts` (core)
- `src/app/api/flip-ranking/route.ts` + `src/app/api/flip-ranking/drilldown/route.ts`
- `src/hooks/useAnalysis/useItemTrend.ts` (ItemTrendPeriod.satuan), `src/lib/month-resolver.ts`
- `tests/lib/flip-metrics.test.ts` (15 test)
- `worklog.md` (entri FLIP-BE, FLIP-DRILL, BUG-FLIP2, DOC-MASTER, 6b2d5c9) + `git show 5489f9c` / `6b2d5c9` untuk bukti histori

## 1. TABEL VERIFIKASI PER FORMULA / KLAIM MASTER

### 1a. Formula inti (master L347-355)

| # | Claim master (verbatim) | Lokasi kode | Status | Bukti kutipan |
|---|---|---|---|---|
| F1 | `isFlip(p1,p2)` = sign(P1) !== sign(P2) AND both non-zero | `src/lib/flip-metrics.ts` L39-43 (dipakai FE via `flipHelpers.ts` L46 import, BE via `flip-ranking.ts` L54-60 import, drill via `FlipDrillPanel.tsx` L22 import) | ✅ MATCH | `return s1 !== 0 && s2 !== 0 && s1 !== s2;` — P1=0/P2=0 → false; same-sign → false. Test: `isFlipPair(0,5)===false`, `isFlipPair(10,20)===false` |
| F2 | `disparity = \|P1+P2\| / MAX(\|P1\|,\|P2\|)` — 0% balanced, 100% dominan | `flip-metrics.ts` L54-58 | ✅ MATCH | `const net = v1 + v2; const maxMagnitude = Math.max(Math.abs(v1), Math.abs(v2)); return maxMagnitude > 0 ? Math.min(Math.abs(net) / maxMagnitude, 1) : 0;` — clamp `Math.min(...,1)` + guard max=0 adalah no-op matematis utk pasangan flip (\|net\| ≤ max saat beda tanda; max=0 hanya saat keduanya 0 → bukan flip), didokumentasikan di JSDoc L49-52. Test: `flipDisparity(100,-98)≈0.02`, `(100,-100)=0`, `(100,-10)≈0.9` |
| F3 | 🟢 Sempurna disparity **< 10%**; 🟡 Dominan **10-40%**; 🔴 Parsial **≥ 40%** | `flip-metrics.ts` L71-75 | ✅ MATCH (operator persis) | `if (disparity < 0.10) return 'sempurna'; if (disparity < 0.40) return 'dominan'; return 'parsial';` — **jawaban pertanyaan boundary: 10% tepat (0.10) masuk DOMINAN** (karena `0.10 < 0.10` = false), **40% tepat (0.40) masuk PARSIAL**. Terkunci test L81/L86: `categorizeFlipDisparity(0.10)==='dominan'`, `categorizeFlipDisparity(0.40)==='parsial'` |
| F4 | riskLevel: `sempurnaCount>0 ? 'high' : flipCount>0 ? 'moderate' : 'low'` | `flip-metrics.ts` L91-98 (`flipRiskLevel`) | ✅ MATCH | `if (sempurnaCount > 0) return 'high'; if (flipCount > 0) return 'moderate'; return 'low';` |
| F5 | riskScore: `min(100, sempurnaCount*30 + flipCount*10)` (BUG2-FLIP-05) | `flip-metrics.ts` L81-83 (`flipRiskScore`) | ✅ MATCH | `return Math.min(100, sempurnaCount * 30 + flipCount * 10);` — Test: `(0,3)=30`, `(1,3)=60`, `(4,10)=100` (capped) |
| F6 | Formula lama `sempurna*100 + dominan*40 + parsial*15` TIDAK dipakai lagi | repo-wide grep | ✅ MATCH (0 sisa) | `rg -e 'sempurna[^/\n]*\*\s*100' -e '\*\s*40[^/\n]*dominan' -e 'parsial[^/\n]*\*\s*15' ...` di `src/ tests/ scripts/ prisma/` → **0 match** (exit 1). Satu-satunya `* 40`/`* 15` adalah teks komentar rentang kategori ("disparity 10-40%"), bukan aritmetika |
| F7 | FE+BE identik ("aligned FE+BE per BUG2-FLIP-05", "FE+BE identik") | FE `flipHelpers.ts` L44-45,260-261 (`sharedFlipRiskScore/Level`); BE `flip-ranking.ts` L54-60,333-334; drill `FlipDrillPanel.tsx` L22 | ✅ MATCH (lebih kuat dari spec) | Ketiga call site **import fungsi yang sama** dari modul tunggal `src/lib/flip-metrics.ts` (refactor H-11/#4c) — parity terjamin by construction, bukan "by comment convention". Tidak ada implementasi riskScore/flip duplikat lain (`rg riskScore src/` → hanya flip files + pareto yang metrik berbeda: `systemic*0.4+financial*0.4+...`) |

### 1b. Phase A (master L359-362)

| # | Claim master | Lokasi kode | Status | Bukti |
|---|---|---|---|---|
| A1 | Flip column badge 🟢/🟡/🔴/⚪/📍 | `flipHelpers.ts` L324-370 `flipBadge()` + `ItemTrendTable/FlipCell.tsx` | ✅ MATCH utk 🟢/🟡/🔴/⚪; 📍 → **DOC-STALE #2** | `case 'sempurna': 🟢`, `'dominan': 🟡`, `'parsial': 🔴`, `'stagnan': ⚪`, konsisten-naik/turun: ⬆/⬇ (lebih kaya dari spec — 4 varian bukan 1). Periode non-applicable (`first`) merender "—" muted (FlipCell L37-39; `flipBadge('first')` → `emoji:'—'`), BUKAN 📍 — lihat DOC-STALE #2 |
| A2 | Sort nulls always bottom (BUG2-FLIP-02/04) | `hooks/useItemTrendDerived.ts` L119-136 | ❌ **MISMATCH — di luar domain saya** (hooks/** = READ-ONLY, milik VERIFY-DISPLAY) | Trace Node.js atas komparator persis: `ASC : flipC, flipE, flipA, nonflipB, nonflipD` (✓ bawah) tapi `DESC: nonflipB, nonflipD, flipA, ...` (**non-flip di ATAS** ✗). Akar masalah: sentinel null (`cmp=1` utk va==null) dinegas oleh `return sortDir === 'desc' ? -cmp : cmp` (L138) → arah DESC membalik penempatan null. DESC adalah arah DEFAULT saat header "Flip" pertama diklik (`useTrendTableSort.ts` L25 `setSortDir('desc')`). Melanggar master L360 "nulls **always** sort to bottom", komentar kode sendiri L124-126, dan commit msg 5489f9c "ALWAYS go to bottom regardless of ASC/DESC". Suggested diff utk agent pemilik file ada di §4 |
| A3 | Chart ring amber dashed, filtered `isFlip===true` (BUG2-FLIP-01) | `ItemTrendLineChart.tsx` L131-134 + L283-294 | ✅ MATCH | `const pairs = flips ? getFlipsForPeriod(flips, pk).filter((f) => f.isFlip) : [];` lalu `{payload.hasFlip && (<circle ... strokeDasharray="2 2" stroke="var(--chart-waste)"/>)}` — ring hanya pada dot flip |
| A4 | FlipSummaryCard di CardContent (atas chart, UI-10) | `components/TrendDataView.tsx` L95-103 | ✅ MATCH | `{selectedItem && periods.length > 1 && (<div className="px-4 pt-2"><FlipSummaryCard score={flipScore}/></div>)}` — di atas section chart, dalam CardContent; menampilkan risk badge + count sempurna/dominan/parsial (+konsisten) |

### 1c. Phase B — FlipMatrix (master L364-365)

| # | Claim master | Lokasi kode | Status | Bukti |
|---|---|---|---|---|
| B1 | red=LOSS / emerald=SURPLUS / muted=zero | `FlipMatrix.tsx` L71-86 `cellColorClass()` | ✅ MATCH | `signed > 0` → `bg-emerald-500/40 …` (SURPLUS); negatif → `bg-red-500/40 …` (LOSS); `signed === 0 \|\| maxAbs === 0` → `bg-muted/30 text-muted-foreground/60` (zero) |
| B2 | Amber ring hanya pada flip cells | `FlipMatrix.tsx` L133-145 + L213-217 | ✅ MATCH | `for (const f of flips) { if (!f.isFlip) continue; s.add(f.period1Key); s.add(f.period2Key); }` lalu `isFlipCell ? 'ring-2 ring-amber-500 …'` (BUG-FLIP-01 fix dipertahankan; tooltip juga difilter `.filter((f) => f.isFlip)` L201) |
| B3 | Native `<table>`, sticky header/kolom, satuan-aware via fmtFullSigned | `FlipMatrix.tsx` L159, L162/L181 (sticky), L219 `fmtFullSigned`, L88-90 `unitLabel = satuan \|\| ''` | ✅ MATCH | Grid native `border-separate border-spacing-1`; `sticky left-0` kolom Week; footer note `Cells = signed QTY Deviasi{unitLabel ? \` (${unitLabel})\` : ''}` |

### 1d. Phase C — Ranking API + widget (master L367-369)

| # | Claim master | Lokasi kode | Status | Bukti |
|---|---|---|---|---|
| C1 | Scans ALL items per (period,item) SIGNED SUM(qtyDeviasi) GROUP BY | `flip-ranking.ts` L215-231 | ✅ MATCH | `COALESCE(SUM(ir."qtyDeviasi"), 0) as "qtyDeviasiSigned" … GROUP BY ir."monthLabel", ir."weekLabel", i.name`; `itemName: null` di `buildSqlFilters` (L200-206) agar SEMUA item discan |
| C2 | Sort `riskScore DESC, sempurnaCount DESC, flipCount DESC` | `flip-ranking.ts` L369-373 | ✅ MATCH | `if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore; if (b.sempurnaCount !== a.sempurnaCount) return b.sempurnaCount - a.sempurnaCount; return b.flipCount - a.flipCount;` |
| C3 | Items 0 flip pairs difilter (BUG2-FLIP-06) | `flip-ranking.ts` L363-366 | ✅ MATCH | `const filteredItems = items.filter((i) => i.totalPairs > 0);` sebelum sort + `slice(0, limit)` |
| C4 | Returns flipCount+sempurna+dominan+parsial+avgDisparity+riskScore+riskLevel | `flip-ranking.ts` L347-360 | ✅ MATCH | Semua field ada; `avgDisparity = flipCount > 0 ? disparitySum / flipCount : 0` (L335 — mean disparity pasangan FLIP saja, konsisten FE `flipHelpers.ts` L267) |
| C5 | topFlips = top 3 pair dgn **P1/P2/Δ/net/disparity/category** | `flip-ranking.ts` L321-331, L337-338 | ⚠️ MISMATCH → **FIXED** | Sebelumnya payload hanya `qtyP1/qtyP2/net/disparityPct/category` — **field Δ (P2−P1) tidak ada**. Fixed: `delta: v2 - v1` ditambahkan ke payload BE + tipe FE + baris Δ di tooltip (diff §3). Sort topFlips `disparityPct ASC` (paling balanced dulu) + `slice(0,3)` ✓ |
| C6 | Widget: sortable 7-kolom (Rank\|Item\|Flips\|Sempurna\|AvgDisparity\|RiskScore\|TopFlipPair) + tooltip P1/P2+net+disparity+category | `FlipRanking/FlipRankingTableHeader.tsx` + `FlipRankingRow.tsx` L136-170 | ✅ MATCH | 7 kolom header (#, Item, Flip, 🟢 Sempurna, Disparitas Rata-rata, Skor Risiko, Top Flip Pair); 5 sort key sortable; tooltip menampilkan P1/P2 signed (+Δ hasil fix)/Net/Disparity/category badge |
| C7 | Row click → setTrendSelectedItem (+search auto-populated) | `FlipRankingRow.tsx` L69 `clickableRowProps(() => onSelectItem(item.itemName))` → `FlipRanking/index.tsx` L176 `onSelectItem={setTrendSelectedItem}` | ✅ MATCH | Widget render di dalam Trend Item tab itu sendiri (index.tsx L241), jadi "tab switches" moot; search bar auto-terisi via `trendSelectedItem` (`useItemTrendAutocomplete({selectedItem})`) |
| C8 | Chevron drill-down hanya HIGH+MODERATE (UI2-08) | `FlipRankingRow.tsx` L104 | ✅ MATCH | `{topFlip && cb && dKey && item.riskLevel !== 'low' ? (…chevron…) : <span>—</span>}` |
| C9 | 5-min DB cache + SWR | `route.ts` L59 `FLIP_RANKING_CACHE_TTL = 5*60*1000` + `withCacheAndDedup` + flag `cached/stale` | ✅ MATCH | Cache key menyertakan month/week/filters/limit |
| C10 | Month filter menerima full "Juli 2026" ATAU short "Jul" via ILIKE prefix | `route.ts` L69 Zod + `flip-ranking.ts` L291 | 🟨 **DOC-STALE #3** | Zod `month: z.string().regex(/^[A-Za-z]+\s+20\d{2}$/)` hanya menerima bentuk FULL; query pakai equality `p1.monthLabel !== monthLabel` (bukan ILIKE). ILIKE prefix adalah mekanisme **drill-down** (`flip-drilldown.ts` `monthMatch:'prefix'`). FE tidak pernah mengirim short month ke ranking (store monthLabel selalu full). Bukti histori di §5 |

### 1e. Phase C — Drill-down API + unified table (master L370-371)

| # | Claim master | Lokasi kode | Status | Bukti |
|---|---|---|---|---|
| D1 | Per-outlet breakdown utk ONE flip pair (item/week/month1/month2) | `flip-drilldown.ts` + `drilldown/route.ts` | ✅ MATCH | Dua query per-outlet paralel (P1+P2); exact `i.name = ${item}`; month matching full/short via ILIKE prefix (`monthMatch: 'prefix'`) |
| D2 | Kolom: Outlet\|Area\|PIC\|P1 QTY\|P2 QTY\|**Δ QTY**\|Net\|🔀 Flip% | `FlipDrillPanel.tsx` L262-343 | ✅ MATCH | Unified table 8 kolom persis; `delta: v2 - v1` (L123) dgn komentar "P2 - P1 (magnitude of change)" |
| D3 | `disparityPct = \|net\| / MAX(\|P1\|,\|P2\|) × 100` | `FlipDrillPanel.tsx` L123 (`flipDisparityPct` → `flip-metrics.ts` L61-63 `flipDisparity * 100`) | ✅ MATCH | Formula shared module, sama dgn ranking & FE per-item |
| D4 | Sorted flip% ASC (most balanced di atas) | `FlipDrillPanel.tsx` L139 | ✅ MATCH | `rows.sort((a, b) => a.disparityPct - b.disparityPct);` + banner info "Diurutkan by Flip Disparity % ascending" |
| D5 | Filtered to flip-only outlets | `FlipDrillPanel.tsx` L115-120 | ✅ MATCH | `if (!o2) continue;` (outlet hanya di 1 periode tak bisa flip) + `if (!isFlipPair(v1, v2)) continue; // hide konsisten outlets` |
| D6 | TOTALS across ALL outlets (bukan hanya flip outlets) | `FlipDrillPanel.tsx` L140-143 | ✅ MATCH (semantik) | `const p1Total = data.period1.outlets.reduce(...)` — dari SELURUH outlet period (termasuk konsisten), komentar "Totals from ALL outlets (including konsisten) — true period aggregate". Catatan kosmetik: totals dirender sebagai baris ringkas DI ATAS tabel, bukan literal footer row di bawah — perilaku identik sejak implementasi awal (git 6b2d5c9 L391-408 juga di atas), klaim inti "ALL outlets not just flip" terpenuhi |
| D7 | Drill-down satuan-aware (dynamic unit via MAX(ir.satuan) + ItemTrendPeriod.satuan) | drilldown response + FlipDrillPanel | 🟨 **DOC-STALE #4** | Tabel drill-down TIDAK menampilkan unit sama sekali (tidak ada satuan hardcode "kg", juga tidak ada kolom unit — kolom spec L371 memang tidak menyebut unit). Cakupan fix SATUAN-BUG aktual = ItemTrendTable + FlipMatrix (bukti §5). Tidak ada hardcoded "kg" di seluruh file flip FE (grep: hanya muncul di komentar fix) |
| D8 | "Backed by single `useFlipDrilldown` hook" | — | 🟨 **DOC-STALE #5** | Hook `useFlipDrilldown` tidak pernah ada — fetch adalah SATU panggilan `useQuery` inline di dalam SATU komponen `FlipDrillPanel` (REFACTOR-1-b pure move). `git log -S useFlipDrilldown` → string hanya pernah ditambahkan ke teks MASTER_CONTEXT.md di commit 6b2d5c9 (dokumen), bukan kode |

### 1f. Satuan-aware umum (master L381)

| # | Claim master | Lokasi kode | Status | Bukti |
|---|---|---|---|---|
| S1 | Dynamic unit via MAX(ir.satuan) + ItemTrendPeriod.satuan; extracted `periods[0]?.satuan`; passed ke ItemTrendTable + FlipMatrix (+drill-down table → DOC-STALE #4) | `item-trend-matrix.ts` L82 `MAX(ir."satuan")`; `useItemTrend.ts` L34 `satuan: string \| null`; `flip-ranking.ts` L221 `MAX(ir."satuan") as "satuan"`; `useItemTrendDerived.ts` L77 `periods[0]?.satuan ?? null`; `TrendDataView.tsx` L165+L174 pass ke ItemTrendTable + FlipMatrix | ✅ MATCH (bagian inti) | Tidak ada lagi hardcoded "kg"; `unitLabel = satuan \|\| ''` dipakai di FlipCell tooltip (P1/P2/Net), FlipMatrix cell/tooltip/footer. Ekstraksi kini ada di hook `useItemTrendDerived` (pindahan murni SPLIT-B dari index.tsx — DOC-STALE #1b) |

## 2. DOC-STALE (dokumen kalah, kode+worklog menang) — dengan bukti

1. **Lokasi formula**: master L347 menyebut formula hidup di `flipHelpers.ts`. Aktual: formula inti dikonsolidasi ke **`src/lib/flip-metrics.ts`** (refactor H-11/#4c) dan di-import oleh flipHelpers.ts, flip-ranking.ts (BE), FlipDrillPanel.tsx. Bukti: header `flipHelpers.ts` L29-34 ("the core flip FORMULAS … now live in ONE shared module"), header `flip-metrics.ts` L13-21 ("Before H-11 this formula lived in THREE places"), tests `tests/lib/flip-metrics.test.ts` L1-4. **Kode menang** (3 copy → 1 modul = parity FE/BE lebih kuat); DOC-STALE pada path saja. Sub-deviasi path lain (pure moves terdokumentasi SPLIT-B/REFACTOR-1-b): satuan extraction `index.tsx` → `hooks/useItemTrendDerived.ts`; FlipRanking.tsx → folder `FlipRanking/`; FlipDrillPanel + flip-badges diekstrak. Semua "pure move, no behavior change".
2. **📍 non-applicable di flip column**: master L360 menyebut 📍 utk single-period. Aktual: `first` selalu merender "—" muted (`flipBadge('first')` → `emoji:'—'`; FlipCell `flip == null → <span>—</span>`). Bukti histori: pada commit 6b2d5c9 (saat section master ditulis) `flipBadge('first')` juga `'—'`; emoji 📍 di file itu adalah milik **patternBadge** kolom "Pola" (Tunggal=1 outlet — BUG-1-03 fix, masih ada di `patternBadge.ts` L37). Kesimpulan: 📍 di master = konflasi dokumen dgn kolom Pola; kode tidak pernah memakai 📍 di kolom Flip. Kode + komentar JSDoc flipBadge ("`first` returns muted '—' styling") menang.
3. **"Month filter … short 'Jul' via ILIKE prefix" (ranking API)**: Zod ranking hanya menerima full `^[A-Za-z]+\s+20\d{2}$`; equality match di query. ILIKE prefix adalah mekanisme drill-down. Bukti: worklog BUG-FLIP2 L39571 "Verified month filter in flip-ranking API: … **Zod schema accepts 'Juli 2026'**" (audit独立 menyatakan full-form); FLIP-BE L39260 cache month='ALL' awalnya (param month ditambah belakangan via USER-REQ full-form); `flip-badges.ts` monthPrefix comment menyebut ILIKE hanya utk drill-down. FE selalu kirim full label. Tidak ada gap fungsional di product flow. (Route menambah resolveMonthLabel case-insensitive via P2-11 — "agustus 2026" → "Agustus 2026".)
4. **Drill-down satuan-aware**: tabel drill tidak menampilkan unit. Bukti: (a) kolom spec master L371 sendiri tidak memuat kolom unit; (b) worklog fix SATUAN asli L39325: "Verified satuan bug fix in: item-trend.ts, useItemTrend.ts, ItemTrendTable.tsx (3 tooltip places), FlipMatrix.tsx (3 tooltip places), index.tsx (extraction)" — tanpa drill-down; (c) audit BUG-FLIP2 L39573: "passed to ItemTrendTable + FlipMatrix" — tanpa drill-down. Invariant inti SATUAN-BUG ("no more hardcoded kg") terpenuhi.
5. **"useFlipDrilldown hook"**: tidak pernah dibuat. Bukti: FLIP-DRILL worklog L39440 "Added FlipDrillPanel component (**inline**) — uses useQuery"; `git log --all -S "useFlipDrilldown"` → hanya commit 6b2d5c9 yang menambah string itu — di **MASTER_CONTEXT.md** (teks dokumen), bukan file kode. Fungsi setara (satu fetch hook-less useQuery dalam satu komponen) tercapai.
6. **"Footer row"**: totals dirender sebagai bar ringkas di atas tabel (sejak implementasi awal — git 6b2d5c9 menunjukkan struktur yang sama). Semantik yang di-spec ("TOTALS across ALL outlets (not just flip outlets)") terpenuhi persis; hanya penempatan visual yang berbeda dari kata "footer". Minor.

## 3. FIX YANG DILAKUKAN (mismatch in-domain — diff minimal, 3 file, +19 LOC)

**C5 — topFlips Δ (P2−P1) missing** (master L368: "top 3 flip pairs with P1/P2/Δ/net/disparity/category"):

```diff
# src/lib/queries/items/flip-ranking.ts (BE payload)
   net: number;
+  /** P2 − P1 (signed change between the two periods). VERIFY-FLIP: … */
+  delta: number;
…
   qtyP1: v1,
   qtyP2: v2,
   net,
+  delta: v2 - v1,
   disparityPct: Number((disparity * 100).toFixed(1)),

# src/components/dashboard/tabs/ItemTrendTab/flip-badges.ts (FE type)
   net: number;
+  /** P2 − P1 … Optional + defensive: 5-min in-memory API cache can serve a
+   *  pre-fix payload — consumers fall back to qtyP2 − qtyP1. */
+  delta?: number;

# src/components/dashboard/tabs/ItemTrendTab/FlipRanking/FlipRankingRow.tsx (tooltip render)
+  const topFlipDelta = topFlip ? (topFlip.delta ?? topFlip.qtyP2 - topFlip.qtyP1) : 0;
…
+  <div className="flex justify-between gap-4">
+    <span className="text-muted-foreground">Δ (P2−P1):</span>
+    <span className={… ${topFlipDelta < 0 ? 'text-red-600' : 'text-emerald-600'}}>
+      {topFlipDelta >= 0 ? '+' : ''}{fmtNum(topFlipDelta, '', false)}
+    </span>
+  </div>
```

Alasan fix (bukan DOC-STALE): (a) checklist audit eksplisit menyebut Δ di topFlips; (b) tidak ada entri worklog yang mendokumentasikan keputusan sengaja MENGGUGURKAN Δ (worklog FLIP-BE hanya mendeskripsikan bentuk yang dibangun); (c) additive & zero-risk — konsumen lain (export PDF section 9) hanya membaca field lama; FE dibuat defensive-optional + fallback `qtyP2 − qtyP1` agar entri cache in-memory pra-fix tetap aman; field langsung dirender di tooltip agar tidak menjadi dead-field (kelas bug BUG2-FLIP-02).

## 4. MISMATCH DI LUAR DOMAIN (HANDOFF → VERIFY-DISPLAY / orchestrator)

**A2 — Flip column sort "nulls always bottom" JATUH pada arah DESC.**
File: `src/components/dashboard/tabs/ItemTrendTab/hooks/useItemTrendDerived.ts` L119-138 (hooks/** = READ-ONLY utk saya; agent VERIFY-DISPLAY pemilik). Bukki trace (replica komparator persis):

```
ASC : flipC, flipE, flipA, nonflipB, nonflipD   → non-flip di bawah  ✓
DESC: nonflipB, nonflipD, flipA, flipE, flipC   → non-flip di ATAS   ✗ (default arah klik pertama header Flip = desc)
```

Akar: `else if (va == null) cmp = 1;` lalu `return sortDir === 'desc' ? -cmp : cmp;` membalik sentinel null saat DESC (−1 → non-flip "less" → naik ke atas). Ini regression parsial dari fix 5489f9c (commit msg & komentar kode sama-sama klaim "ALWAYS bottom regardless of ASC/DESC"; komentar `ItemTrendTable/index.tsx` L25-26 malah klaim "bottom on desc" — ketiganya tidak konsisten dgn perilaku aktual). Suggested minimal fix (early-return sebelum negasi):

```ts
if (va == null && vb == null) cmp = 0;
else if (va == null) return 1;   // non-flip ALWAYS bottom (asc & desc)
else if (vb == null) return -1;  // non-flip ALWAYS bottom
else cmp = va - vb;
break;
```

Saya TIDAK mengedit file tsd (aturan domain). Kerjakan fix di task VERIFY-DISPLAY.

## 5. Bukti histori tambahan (git + worklog)

- `git show 5489f9c` — diff BUG2-FLIP-04/05: `-1` → null+sentinel (ASC fixed, DESC regression tidak disadari); riskLevel/riskScore FE lama (`>=50 high / >=20 moderate`, weighted/totalPairs) diganti ke count thresholds + `min(100, s*30+f*10)` — sesuai master.
- `git show 6b2d5c9` — MASTER_CONTEXT flip section ditulis; pada commit itu pula: Zod ranking full-form-only (route L69), FlipDrillPanel totals di atas tabel, `flipBadge('first')='—'`, 📍 hanya di patternBadge.
- `git log --all -S useFlipDrilldown` → hanya teks master doc (6b2d5c9).
- Worklog FLIP-BE L39276: "topFlips array contains top 3 … qtyP1, qtyP2, net, disparityPct, category" (bentuk pra-Δ).
- Worklog BUG-FLIP2 L39569: "Verified unified table logic (delta = P2-P1, net = P1+P2, disparityPct = |net|/MAX(|P1|,|P2|)*100, sort ASC)" + L39570 "Verified totals computed from ALL outlets (not just flip outlets)".
- Grep repo-wide (`src/ tests/ scripts/ prisma/`): formula lama `sempurna*100+dominan*40+parsial*15` → 0 match.

## 6. VERIFIKASI PASCA-FIX

| Check | Hasil |
|---|---|
| `bunx vitest run tests/lib/flip-metrics.test.ts` | ✅ **15/15 PASS** (tanpa edit test) — mengunci isFlip, disparity (+clamp), boundary 0.10→dominan / 0.40→parsial, riskScore min(100, s*30+f*10), riskLevel |
| `bunx tsc --noEmit --incremental false` | ✅ **EXIT 0** (0 error; domain flip 0, seluruh repo 0) |
| `bun run lint 2>&1 \| tail -30` | ✅ **0 errors** (377 warnings — semua pre-existing, tidak ada di file yang saya ubah; baseline pra-fix saya 0 err/380 warn; Δ-3 berasal dari perubahan agent paralel lain) |

Catatan lingkungan: working tree juga berisi modifikasi dari agent paralel lain (`AreaItemHeatmapSheet.tsx`, `rules.yaml`, `metrics/definitions.ts`, `metrics/deviation.ts`, `rule-evaluation.ts`) — BUKAN sentuhan saya. Diff saya hanya 3 file domain flip (FlipRankingRow.tsx +10, flip-badges.ts +5, flip-ranking.ts +4). Tidak ada commit/push; tidak menulis worklog.md.

Stage Summary:

- **20/23 klaim master MATCH persis** — termasuk kelima formula inti (isFlip / disparity / categorizeFlip boundary <10 vs 10-40 vs ≥40 / riskLevel / riskScore min(100, s*30+f*10)) yang kini hidup di modul tunggal `src/lib/flip-metrics.ts` sehingga parity FE+BE terjamin by construction (lebih kuat dari spec "identik by convention"); formula lama `s*100+d*40+p*15` terbukti 0 pemakaian; aggregate SIGNED SUM GROUP BY + sort riskScore/sempurna/flipCount DESC + filter totalPairs>0 + avgDisparity + top-3 flips + drilldown (disparityPct, ASC, flip-only, totals ALL outlets) semua sesuai; FlipMatrix warna + ring & chart ring ter-filter isFlip.
- **1 mismatch in-domain DIFIX**: topFlips kini membawa `delta` (P2−P1) di payload BE + tipe FE + baris Δ di tooltip (+19 LOC, 3 file, additive).
- **1 mismatch OUT-OF-DOMAIN dilaporkan utk di-fix agent pemilik** (hooks/useItemTrendDerived.ts): null-comparator flip sort terbalik saat DESC → non-flip rows muncul di ATAS pada arah default — regression parsial BUG2-FLIP-04; suggested diff disertakan (§4).
- **6 DOC-STALE terdokumentasi** (formula path → flip-metrics.ts; 📍 = konflasi patternBadge; ranking month full-form-only; drill-down tanpa kolom unit sesuai cakupan fix SATUAN asli; hook useFlipDrilldown tidak pernah ada; totals di-render di atas tabel) — masing-masing dengan bukti git/worklog.
- Pasca-fix: tsc EXIT 0 · lint 0 error · vitest 15/15 PASS.
