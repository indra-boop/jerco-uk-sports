// src/scrape-wtm.js
// WTM DAILY SCRAPER (LIST ONLY) — rev.2
// Usage: node src/scrape-wtm.js 20260227 20260228 ...
// Env opsional:
//   SAVE_HTML=1     -> simpan HTML mentah ke out/ (default: tidak simpan)
//   MIN_VALID_PCT   -> ambang guard, default 0.8
// Output: results.csv
//   hari,tanggal,time WITA,sport,competition,title,home,away,channel_1..8,event_url

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

const SAVE_HTML = process.env.SAVE_HTML === "1";
const MIN_VALID_PCT = Number(process.env.MIN_VALID_PCT || 0.8);

/* =========================
   AXIOS CLIENT + COOKIE JAR
   ========================= */
const jar = new CookieJar();
const client = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    timeout: 60000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  })
);

/* =========================
   HELPERS
   ========================= */
function safeCsv(v) {
  return (v ?? "")
    .toString()
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, '""');
}

function buildDailyUrl(dateYYYYMMDD) {
  return `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${dateYYYYMMDD}`;
}

// ISO dgn offset UK (+01:00 BST / +00:00 GMT) -> WITA
function isoToWitaPartsISO(isoZ) {
  if (!isoZ) return null;
  const dt = new Date(isoZ);
  if (isNaN(dt.getTime())) return null;

  const o = { timeZone: "Asia/Makassar", hour12: false };
  const yyyy = new Intl.DateTimeFormat("en", { ...o, year: "numeric" }).format(dt);
  const mm = new Intl.DateTimeFormat("en", { ...o, month: "2-digit" }).format(dt);
  const dd = new Intl.DateTimeFormat("en", { ...o, day: "2-digit" }).format(dt);
  const HH = new Intl.DateTimeFormat("en", { ...o, hour: "2-digit" }).format(dt);
  const MM = new Intl.DateTimeFormat("en", { ...o, minute: "2-digit" }).format(dt);
  const hari = new Intl.DateTimeFormat("id-ID", { ...o, weekday: "long" }).format(dt);

  return {
    hari,
    tanggal: `${dd}-${mm}-${yyyy}`,
    time: `${HH.padStart(2, "0")}:${MM.padStart(2, "0")}`,
    iso: dt.toISOString(),
  };
}

function extractHiddenFields($) {
  const fields = {};
  $("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") || "";
    if (name) fields[name] = value;
  });
  return fields;
}

function uniqKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = (x || "").replace(/\s+/g, " ").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function titleCase(s) {
  return s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* =========================
   PARSER (rev.2)
   ========================= */
function parseWTMEvents($, pageNum, sourceDate) {
  const rows = [];

  $("table tr").each((_, tr) => {
    const $tr = $(tr);
    const $fx = $tr.find("td.fixture-details");
    if ($fx.length === 0) return;

    // --- Tim: 2 anchor <em> di span.fixture; event tunggal -> <strong>
    const teams = $fx
      .find("span.fixture a em")
      .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);

    let home = "";
    let away = "";
    let title = "";

    if (teams.length >= 2) {
      home = teams[0];
      away = teams[1];
      title = `${home} vs ${away}`;
    } else {
      title =
        $fx.find("span.fixture strong").first().text().replace(/\s+/g, " ").trim() ||
        $fx.find("span.fixture").first().text().replace(/\s+/g, " ").trim();
    }

    // --- Waktu: <time datetime="2026-08-09T00:00:00+01:00">
    const isoZ = $tr.find("td.start-details time").attr("datetime") || "";
    const w = isoToWitaPartsISO(isoZ) || { hari: "", tanggal: "", time: "", iso: "" };

    // --- Sport: dari nama file icon /images/sports/cricket.gif
    let sport = "";
    const sportSrc =
      $fx.find(".fixture-sport img").attr("src") ||
      $tr.find("td.competition-name img").attr("src") ||
      "";
    const ms = sportSrc.match(/\/sports\/([^./]+)\./);
    if (ms) sport = titleCase(ms[1]);

    // Fallback: alt img competition-name -> "Caribbean Premier League - Live Cricket"
    if (!sport) {
      const altComp = $tr.find("td.competition-name img").attr("alt") || "";
      const ma = altComp.match(/-\s*Live\s+(.+)$/i);
      if (ma) sport = ma[1].trim();
    }

    // --- Competition
    let competition =
      $tr.find("td.competition-name a span").first().text().trim() ||
      $tr.find("td.competition-name > span").not(".stage").first().text().trim();

    if (!competition) {
      // span.fixture-comp berisi <span.fixture-sport> + teks kompetisi
      const $fc = $fx.find("span.fixture-comp").first().clone();
      $fc.children("span").remove();
      competition = $fc.text().replace(/\s+/g, " ").trim();
    }
    if (!competition) {
      competition = $fx.find("span.event-text").first().text().trim();
    }

    // --- Stage (opsional, digabung ke competition)
    const stage =
      $tr.find("td.competition-name span.stage").first().text().trim() ||
      $fx.find("span.fixture-stage").first().text().trim();
    if (stage) competition = competition ? `${competition} — ${stage}` : stage;

    // --- Channel: span.sr-only = nama bersih
    let channels = $tr
      .find("td.channel-details a span.sr-only")
      .map((_, el) => $(el).text().trim())
      .get();

    if (channels.length === 0) {
      channels = $tr
        .find("td.channel-details img")
        .map((_, el) =>
          ($(el).attr("alt") || $(el).attr("title") || "")
            .replace(/^.*\bBroadcast on\s*/i, "")
            .replace(/^Live on\s*/i, "")
            .replace(/\s*logo\s*$/i, "")
            .trim()
        )
        .get();
    }
    channels = uniqKeepOrder(channels);

    // --- URL event
    let href =
      $tr.find("td.home-team a[href]").attr("href") ||
      $fx.find("a[href*='/match/'], a[href*='/event/']").attr("href") ||
      "";
    const event_url = href
      ? href.startsWith("http")
        ? href
        : `https://www.wheresthematch.com${href}`
      : "";

    // Skip baris sampah
    if (!title && channels.length === 0) return;

    rows.push({
      source_date: sourceDate,
      page: pageNum,
      hari: w.hari,
      tanggal: w.tanggal,
      time: w.time,
      iso: w.iso,
      sport,
      competition,
      title,
      home,
      away,
      channels,
      event_url,
    });
  });

  return rows;
}

function dedupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key =
      (r.event_url && r.event_url.trim()) ||
      `${r.tanggal}|${r.time}|${r.title}|${r.competition}`;
    if (!map.has(key)) map.set(key, r);
  }
  return Array.from(map.values());
}

function fingerprintOfFirstRow(rows) {
  if (!rows || rows.length === 0) return "";
  const r = rows[0];
  return (r.event_url && r.event_url.trim()) || `${r.tanggal}|${r.time}|${r.title}`;
}

/* =========================
   SCRAPE ONE DATE
   ========================= */
async function scrapeOneDate(dateYYYYMMDD, opts = {}) {
  const urlBase = buildDailyUrl(dateYYYYMMDD);
  const outDir = path.join("out", dateYYYYMMDD);
  if (SAVE_HTML) fs.mkdirSync(outDir, { recursive: true });

  const maxPagingIndex = Number.isFinite(opts.maxPagingIndex) ? opts.maxPagingIndex : 60;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 1200;

  console.log(`\n== DATE ${dateYYYYMMDD} ==`);
  console.log(`GET Page 1: ${urlBase}`);

  let currentHtml = "";
  try {
    const res1 = await client.get(urlBase);
    currentHtml = res1.data;
  } catch (e) {
    console.log(`GET gagal untuk ${dateYYYYMMDD}: ${e.message}`);
    return [];
  }
  if (SAVE_HTML) fs.writeFileSync(path.join(outDir, `page-1.html`), currentHtml);

  const $1 = cheerio.load(currentHtml);
  const p1 = parseWTMEvents($1, 1, dateYYYYMMDD);

  let allData = dedupRows([...p1]);
  console.log(`Page 1 rows: ${p1.length} | unique total: ${allData.length}`);

  if (p1.length === 0) {
    console.log(`No rows on Page 1. Stop date ${dateYYYYMMDD}.`);
    return allData;
  }

  let lastFp = fingerprintOfFirstRow(p1);
  let pageNum = 2;

  for (let idx = 0; idx <= maxPagingIndex; idx++) {
    const $prev = cheerio.load(currentHtml);
    const hidden = extractHiddenFields($prev);

    const payload = new URLSearchParams({
      ...hidden,
      __EVENTTARGET: `pagetotalhp${idx}`,
      __EVENTARGUMENT: "",
    });

    console.log(`POST Page ${pageNum} (target=pagetotalhp${idx})`);

    let resNext;
    try {
      resNext = await client.post(
        "https://www.wheresthematch.com/live-sport-on-tv/?paging=true",
        payload.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: urlBase,
          },
        }
      );
    } catch (e) {
      console.log(`POST failed on idx ${idx}: ${e.message}`);
      break;
    }

    currentHtml = resNext.data;
    if (SAVE_HTML) fs.writeFileSync(path.join(outDir, `page-${pageNum}.html`), currentHtml);

    const $n = cheerio.load(currentHtml);
    const pData = parseWTMEvents($n, pageNum, dateYYYYMMDD);

    if (pData.length === 0) {
      console.log(`Page ${pageNum}: 0 rows => stop paging.`);
      break;
    }

    const fp = fingerprintOfFirstRow(pData);
    if (fp && fp === lastFp) {
      console.log(`Page ${pageNum}: duplicate page (same fingerprint) => stop.`);
      break;
    }
    lastFp = fp || lastFp;

    const before = allData.length;
    allData = dedupRows([...allData, ...pData]);
    const after = allData.length;

    console.log(`Page ${pageNum}: rows ${pData.length} | added unique: ${after - before}`);

    if (after === before) {
      console.log(`No unique added => stop paging.`);
      break;
    }

    pageNum++;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`DATE ${dateYYYYMMDD} DONE. unique rows: ${allData.length}`);
  return allData;
}

/* =========================
   MAIN
   ========================= */
async function main() {
  let dates = process.argv.slice(2).filter(Boolean);

  if (dates.length === 0) {
    console.log("Usage: node src/scrape-wtm.js 20260227 20260228 ...");
    process.exit(1);
  }

  dates = dates.filter((d) => {
    if (!/^\d{8}$/.test(d)) {
      console.log(`Skip invalid date: ${d} (must be YYYYMMDD)`);
      return false;
    }
    return true;
  });

  if (SAVE_HTML) fs.mkdirSync("out", { recursive: true });

  let all = [];
  for (const d of dates) {
    const rows = await scrapeOneDate(d, { maxPagingIndex: 60, delayMs: 1200 });
    all.push(...rows);
    all = dedupRows(all);
  }

  /* ---- GUARD: jangan timpa CSV dgn data rusak/kosong ---- */
  const total = all.length;
  const valid = all.filter((r) => r.tanggal && r.time && r.title).length;
  const pct = total ? valid / total : 0;

  console.log(`\nQC: ${valid}/${total} baris valid (${(pct * 100).toFixed(1)}%)`);

  if (total === 0) {
    console.error("GUARD: 0 baris ter-parse. results.csv TIDAK ditimpa.");
    process.exit(1);
  }
  if (pct < MIN_VALID_PCT) {
    console.error(
      `GUARD: hanya ${(pct * 100).toFixed(1)}% baris valid (min ${MIN_VALID_PCT * 100}%). ` +
        `Kemungkinan markup situs berubah. results.csv TIDAK ditimpa.`
    );
    console.error("Contoh baris bermasalah:");
    console.error(
      JSON.stringify(all.filter((r) => !r.tanggal || !r.title).slice(0, 3), null, 2)
    );
    process.exit(1);
  }

  /* ---- Urutkan kronologis ---- */
  all.sort((a, b) => (a.iso || "").localeCompare(b.iso || ""));

  /* ---- Tulis CSV ---- */
  const header = [
    "hari", "tanggal", "time WITA", "sport", "competition", "title", "home", "away",
    "channel_1", "channel_2", "channel_3", "channel_4",
    "channel_5", "channel_6", "channel_7", "channel_8",
    "event_url",
  ];

  let csv = header.join(",") + "\n";

  for (const r of all) {
    const ch = r.channels || [];
    const cells = [
      r.hari, r.tanggal, r.time, r.sport, r.competition, r.title, r.home, r.away,
      ch[0], ch[1], ch[2], ch[3], ch[4], ch[5], ch[6], ch[7],
      r.event_url,
    ];
    csv += cells.map((c) => `"${safeCsv(c)}"`).join(",") + "\n";
  }

  fs.writeFileSync("results.csv", csv);
  console.log(`\nDONE. Total unique rows: ${total}`);
  console.log(`Saved: results.csv`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
