// scrape-wtm-daily.js
// Daily scraper for Where's The Match (WTM) using showdatestart per date
// - Scrape ALL pages via ASP.NET postback paging
// - Save raw HTML per date/page to ./out/{date}/page-x.html
// - Dedup global to prevent double rows
// - Output: results.csv

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

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
  return (v ?? "").toString().replace(/"/g, '""');
}

function buildDailyUrl(dateYYYYMMDD) {
  // WTM: daily page uses showdatestart only
  return `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${dateYYYYMMDD}`;
}

function isoToWitaPartsISO(isoZ) {
  const dt = new Date(isoZ);
  if (isNaN(dt.getTime())) return null;

  const options = { timeZone: "Asia/Makassar", hour12: false };
  const yyyy = new Intl.DateTimeFormat("en", { ...options, year: "numeric" }).format(dt);
  const mm = new Intl.DateTimeFormat("en", { ...options, month: "2-digit" }).format(dt);
  const dd = new Intl.DateTimeFormat("en", { ...options, day: "2-digit" }).format(dt);
  const HH = new Intl.DateTimeFormat("en", { ...options, hour: "2-digit" }).format(dt);
  const MM = new Intl.DateTimeFormat("en", { ...options, minute: "2-digit" }).format(dt);
  const hari = new Intl.DateTimeFormat("id-ID", { ...options, weekday: "long" }).format(dt);

  return { hari, tanggal: `${dd}-${mm}-${yyyy}`, time: `${HH}:${MM}` };
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

/**
 * IMPORTANT:
 * WTM paging (ASP.NET) biasanya punya event target: pagetotalhp0, pagetotalhp1, dst.
 * Cara paling aman: scan html untuk semua "pagetotalhp{n}" dan ambil max n.
 * totalPages = maxIndex + 1 (karena page-1 = initial GET)
 */
function detectPagingMaxIndex(html) {
  const matches = [...html.matchAll(/pagetotalhp(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (!matches.length) return -1; // means no paging
  const max = Math.max(...matches);
  return Number.isFinite(max) ? max : -1;
}

function parseWTMEvents($, pageNum, sourceDate) {
  const rows = [];

  $("table tr").each((_, tr) => {
    const $tr = $(tr);
    const $fx = $tr.find("td.fixture-details");
    if ($fx.length === 0) return;

    const matchContent = ($fx.attr("content") || "").trim();
    const parts = matchContent.split(" v ");
    const home = parts[0]?.trim() || "";
    const away = parts[1]?.trim() || "";

    const sport = $fx.find(".fixture-sport img").attr("alt")?.trim() || "";
    const competition = $fx.find(".fixture-comp a").first().text().trim() || "";

    const isoZ =
      $tr.find("td.start-details").attr("content") ||
      $tr.find('meta[itemprop="startDate"]').attr("content") ||
      "";

    const w = isoToWitaPartsISO(isoZ) || { hari: "", tanggal: "", time: "" };

    const channels = [];
    $tr.find("td.channel-details img").each((_, img) => {
      let t = $(img).attr("title") || $(img).attr("alt") || "";
      t = t.replace(/Live on\s*/i, "").replace(/\s*logo\s*$/i, "").trim();
      if (t) channels.push(t);
    });

    const href = $fx.find("a[href*='/match/']").attr("href") || "";
    const event_url = href
      ? href.startsWith("http")
        ? href
        : `https://www.wheresthematch.com${href}`
      : "";

    rows.push({
      source_date: sourceDate, // YYYYMMDD yang lu request
      page: pageNum,
      hari: w.hari,
      tanggal: w.tanggal,
      time: w.time,
      sport,
      competition,
      title: home && away ? `${home} vs ${away}` : matchContent,
      home,
      away,
      channels,
      event_url,
    });
  });

  return rows;
}

/**
 * Dedup global:
 * prefer event_url (paling unique), fallback fingerprint stable
 */
function dedupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key =
      (r.event_url && r.event_url.trim()) ||
      `${r.source_date}|${r.tanggal}|${r.time}|${r.home}|${r.away}|${r.sport}|${r.competition}`;
    if (!map.has(key)) map.set(key, r);
  }
  return Array.from(map.values());
}

function fingerprintOfFirstRow(rows) {
  if (!rows || rows.length === 0) return "";
  const r = rows[0];
  return (r.event_url && r.event_url.trim()) || `${r.tanggal}|${r.time}|${r.home}|${r.away}`;
}

/* =========================
   SCRAPE ONE DATE (ALL PAGES)
   ========================= */
async function scrapeOneDate(dateYYYYMMDD) {
  const urlBase = buildDailyUrl(dateYYYYMMDD);
  const outDir = path.join("out", dateYYYYMMDD);
  fs.mkdirSync(outDir, { recursive: true });

  let currentHtml = "";

  console.log(`\n== DATE ${dateYYYYMMDD} ==`);
  console.log(`GET Page 1: ${urlBase}`);

  const res1 = await client.get(urlBase);
  currentHtml = res1.data;
  fs.writeFileSync(path.join(outDir, `page-1.html`), currentHtml);

  const $1 = cheerio.load(currentHtml);
  let data = parseWTMEvents($1, 1, dateYYYYMMDD);
  let allData = [...data];

  console.log(`Page 1 rows: ${data.length}`);

  // detect paging
  const maxIdx = detectPagingMaxIndex(currentHtml);
  const totalPages = maxIdx >= 0 ? maxIdx + 1 : 1;
  console.log(`Detected paging index max: ${maxIdx} => totalPages ~ ${totalPages}`);

  let lastFp = fingerprintOfFirstRow(data);

  // page 2..N via POST postback
  for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
    const idx = pageNum - 2; // because pagetotalhp0 usually means "go to page 2"
    const $prev = cheerio.load(currentHtml);
    const hidden = extractHiddenFields($prev);

    const payload = new URLSearchParams({
      ...hidden,
      __EVENTTARGET: `pagetotalhp${idx}`,
      __EVENTARGUMENT: "",
    });

    console.log(`POST Page ${pageNum}/${totalPages} (target=pagetotalhp${idx})`);

    const resNext = await client.post(
      "https://www.wheresthematch.com/live-sport-on-tv/?paging=true",
      payload.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: urlBase,
        },
      }
    );

    currentHtml = resNext.data;
    fs.writeFileSync(path.join(outDir, `page-${pageNum}.html`), currentHtml);

    const $n = cheerio.load(currentHtml);
    const pData = parseWTMEvents($n, pageNum, dateYYYYMMDD);

    if (pData.length === 0) {
      console.log(`Page ${pageNum}: 0 rows => stop paging.`);
      break;
    }

    const fp = fingerprintOfFirstRow(pData);
    if (fp && fp === lastFp) {
      console.log(`Page ${pageNum}: duplicate page returned (same fingerprint) => stop paging.`);
      break;
    }

    lastFp = fp || lastFp;
    allData.push(...pData);

    // small delay
    await new Promise((r) => setTimeout(r, 1200));
  }

  allData = dedupRows(allData);
  console.log(`DATE ${dateYYYYMMDD} unique rows: ${allData.length}`);
  return allData;
}

/* =========================
   MAIN
   ========================= */
async function main() {
  const dates = process.argv.slice(2).filter(Boolean);

  if (dates.length === 0) {
    console.log(
      "Usage:\n  node scrape-wtm-daily.js 20260227 20260228 20260301 20260302 20260303 20260304"
    );
    process.exit(1);
  }

  fs.mkdirSync("out", { recursive: true });

  let all = [];
  for (const d of dates) {
    // basic validation
    if (!/^\d{8}$/.test(d)) {
      console.log(`Skip invalid date: ${d} (must be YYYYMMDD)`);
      continue;
    }
    const rows = await scrapeOneDate(d);
    all.push(...rows);
    all = dedupRows(all);
  }

  // build CSV
  let csv =
    "source_date,page,hari,tanggal,time WITA,sport,competition,title,home,away,channel_1,channel_2,event_url\n";

  for (const r of all) {
    csv += `"${safeCsv(r.source_date)}","${safeCsv(r.page)}","${safeCsv(r.hari)}","${safeCsv(
      r.tanggal
    )}","${safeCsv(r.time)}","${safeCsv(r.sport)}","${safeCsv(r.competition)}","${safeCsv(
      r.title
    )}","${safeCsv(r.home)}","${safeCsv(r.away)}","${safeCsv(r.channels?.[0])}","${safeCsv(
      r.channels?.[1]
    )}","${safeCsv(r.event_url)}"\n`;
  }

  fs.writeFileSync("results.csv", csv);
  console.log(`\nDONE. Total unique rows (all dates): ${all.length}`);
  console.log(`Saved: results.csv`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
