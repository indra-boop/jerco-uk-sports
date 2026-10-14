# jerco-uk-sports

Scraper harian untuk jadwal live sports on TV dari [WherestheMatch.com](https://www.wheresthematch.com/) (UK), dengan konversi waktu ke WITA. Output berupa `results.csv` yang kemudian di-push ke aggregator Jerco Sports Schedule.

**Stack:** Node.js (CommonJS) 
**Source:** WherestheMatch live sport listings  
**Target:** `results.csv` + ingest ke `schedule.jerconetwork.com`

## Fitur

- Scrape jadwal harian (multi-page) dari WherestheMatch
- Parsing: sport, competition, title, home/away, channels (prefix `[GB]`), event URL
- Konversi waktu UK (GMT/BST) → WITA (`Asia/Makassar`)
- Guard QC: tidak menimpa CSV jika data kosong atau validitas di bawah ambang
- Retry dengan exponential backoff pada error jaringan
- GitHub Actions: jalankan otomatis setiap hari (H+0 s/d H+2)
- Push hasil ke aggregator via `/api/ingest/v2`

## Struktur

```
.
├── .github/workflows/scrape-wtm.yml   # Cron harian + workflow_dispatch
├── scripts/
│   ├── push-ingest.mjs              # Push results.csv ke aggregator
│   └── push-ingest.test.mjs         # Test
├── src/
│   ├── scrape-wtm.js               # Entry point scraper
│   └── wita-time.js                 # Konversi ISO → WITA parts
├── package.json
├── results.csv                     # Output terbaru (di-commit oleh Actions)
└── CLAUDE.md                       # Peta repo untuk AI agent
```

## Cara Pakai

### Lokal

```bash
npm install
node src/scrape-wtm.js 20261014 20261015 20261016
```

Tanggal wajib format `YYYYMMDD`.  
Hasil ditulis ke `results.csv` (tidak ditimpa jika QC gagal).

### Environment variables (opsional)

| Variable              | Default | Keterangan                                      |
|-----------------------|---------|-------------------------------------------------|
| `SAVE_HTML`           | -       | `1` = simpan HTML mentah ke `out/`              |
| `MIN_VALID_PCT`       | `0.8`   | Ambang minimal baris valid sebelum tulis CSV    |
| `WTM_RETRY_MAX`       | `5`     | Maksimal percobaan per request                  |
| `WTM_RETRY_BASE_MS`   | `2000`  | Base delay exponential backoff                  |
| `WTM_DATE_DELAY_MS`   | `3000`  | Jeda antar tanggal                              |
| `DASHBOARD_INGEST_URL`| -       | Endpoint aggregator (wajib untuk push)          |
| `DASHBOARD_INGEST_TOKEN` | -    | Bearer token (wajib untuk push)                 |

### Push ke aggregator

```bash
# Dry-run
node scripts/push-ingest.mjs --dry-run

# Live (butuh env)
DASHBOARD_INGEST_URL=https://schedule.jerconetwork.com/api/ingest/v2 \
DASHBOARD_INGEST_TOKEN=xxx \
node scripts/push-ingest.mjs
```

Source alias yang dikirim: `jerco-uk-sports` (dipetakan ke `wheresthematch` di sisi aggregator).

## GitHub Actions

Workflow `.github/workflows/scrape-wtm.yml`:

- Jadwal: `05 00 * * *` UTC (08:05 WITA)
- Scrape tanggal H+0, H+1, H+2 (zona WITA)
- Commit & push `results.csv` jika ada perubahan
- Push ke aggregator (butuh secret `DASHBOARD_INGEST_TOKEN`)

Bisa dijalankan manual via `workflow_dispatch`.

## Output CSV

Header:

```
hari,tanggal,time WITA,sport,competition,title,home,away,channel_1,...,channel_8,event_url
```

Contoh baris:

```
"Rabu","14-10-2026","07:00","Basketball","NBA — Pre-Season","Orlando Magic vs Cleveland Cavaliers",...
```

## Test

```bash
npm test
```

## Catatan

- Scraping dilakukan untuk keperluan internal Jerco Sports Schedule.
- Markup situs WherestheMatch dapat berubah; guard QC akan menolak hasil rusak.
- Lihat `CLAUDE.md` untuk peta cepat bagi agent AI.

---

**CV Jerco Digital Solusi** · jerco live sports schedule
