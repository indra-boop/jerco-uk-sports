const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

/**
 * WTM Scraper (Range) -> Output WITA
 * - kolom GMT dihilangkan
 * - kolom "day" dihapus
 * - hari/tanggal/time = WITA (Asia/Makassar)
 * - tanggal format: dd-mm-yyyy
 * - jika channel > 1 dipisah ke channel_1..channel_8
 * - urutan kolom CSV mengikuti contoh:
 *   hari, tanggal, time, sport, competition, title, home, away, channel_1..channel_8, event_url
 * - tetap simpan raw HTML ke /out untuk audit
 * - optional POST ke Google Apps Script via WEBAPP_URL
 */

function getWebappUrl() {
  return process.env.WEBAPP_URL;
}

/* =========================
   HELPERS
   ========================= */
function clean(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function uniq(arr) {
  return [...new Set((arr || []).map((x) => clean(x)).filter(Boolean))];
}

function safeCsv(v) {
  return (v ?? "").toString().replace(/"/g, '""');
}

function buildUrl(startYYYYMMDD, endYYYYMMDD) {
  return `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${startYYYYMMDD}&showdateend=${endYYYYMMDD}`;
}

/**
 * Convert ISO Z time (UTC) -> WITA parts
 * output:
 * - hari: "Minggu", "Senin", ...
 * - tanggal: dd-mm-yyyy
 * - time: HH:MM
 */
function isoToWitaPartsISO(isoZ) {
  const dt = new Date(isoZ);
  if (Number.isNaN(dt.getTime())) return null;

  // dd, mm, yyyy, HH, MM by timezone Asia/Makassar
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Makassar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const HH = get("hour");
  const MM = get("minute");

  // ✅ format sesuai request
  const tanggal = `${dd}-${mm}-${yyyy}`; // dd-mm-yyyy
  const time = `${HH}:${MM}`;

  const hari = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Makassar",
    weekday: "long",
  }).format(dt);

  return { hari, tanggal, time };
}

function splitChannelsToCols(chArr, max = 8) {
  const cols = {};
  for (let i = 0; i < max; i++) cols[`channel_${i + 1}`] = "";
  (chArr || []).slice(0, max).forEach((c, idx) => {
    cols[`channel_${idx + 1}`] = c;
  });
  return cols;
}

/* =========================
   PARSER WTM (GRID BY INDEX)
   =========================
   Dalam 1 <tr> bisa ada banyak match (td.fixture-details)
   Maka pairing index:
     fixtures[i] -> starts[i] -> channels[i]
 */
function parseWTMEvents($) {
  const rows = [];

  $("table tr").each((_, tr) => {
    const $tr = $(tr);

    const fixtures = $tr.find("td.fixture-details").toArray();
    const starts = $tr.find("td.start-details, td.start-date-time").toArray();
    const channels = $tr.find("td.channel-details").toArray();

    if (fixtures.length === 0) return;

    for (let i = 0; i < fixtures.length; i++) {
      const $fx = $(fixtures[i]);
      const $st = starts[i] ? $(starts[i]) : null;
      const $ch = channels[i] ? $(channels[i]) : null;

      // Teams dari content="India v South-Africa"
      const matchContent = ($fx.attr("content") || "").trim();
      const parts = matchContent.split(" v ");
      const home = parts[0] ? parts[0].replace(/-/g, " ").trim() : "";
      const away = parts[1] ? parts[1].replace(/-/g, " ").trim() : "";

      // Sport + competition ada di dalam fixture-details (lebih stabil)
      const sport = $fx.find(".fixture-sport img").attr("alt")?.trim() || "";
      const competition = $fx.find(".fixture-comp a").first().text().trim() || "";

      // ISO Z (UTC) untuk konversi WITA
      let isoZ = "";
      if ($st) isoZ = ($st.attr("content") || "").trim();

      // fallback ISO ada di meta itemprop startDate dalam row
      if (!isoZ) {
        const metaIso = $tr.find('meta[itemprop="startDate"]').first().attr("content");
        if (metaIso) isoZ = metaIso.trim();
      }

      // hasil WITA
      let hari = "";
      let tanggal = "";
      let time = "";

      if (isoZ) {
        const w = isoToWitaPartsISO(isoZ);
        if (w) {
          hari = w.hari;
          tanggal = w.tanggal;
          time = w.time;
        }
      } else if ($st) {
        // fallback: tanpa ISO (kurang akurat timezone)
        time = $st.find("span.time").text().trim() || "";
        tanggal = $st.find("span.date").text().trim() || "";
        hari = "";
      }

      // Channels: img title/alt di channel-details
      const channelList = [];
      if ($ch) {
        $ch.find("img").each((_, img) => {
          let t = $(img).attr("title") || $(img).attr("alt") || "";
          t = t.replace(/Live on\s*/i, "").replace(/\s*logo\s*$/i, "").trim();
          if (t) channelList.push(t);
        });
      }

      // event_url: link match kalau ada
      let event_url = "";
      const href =
        $fx.find("a.mobile-buy-pass").first().attr("href") ||
        $fx.find("a[href*='/match/']").first().attr("href");
      if (href) event_url = href.startsWith("http") ? href : `https://www.wheresthematch.com${href}`;

      const channelCols = splitChannelsToCols(channelList, 8);

      rows.push({
        hari,
        tanggal,
        time,
        sport,
        competition,
        title: home && away ? `${home} vs ${away}` : matchContent, // ✅ title sebelum home/away
        home,
        away,
        ...channelCols,
        event_url,
      });
    }
  });

  return rows;
}

/* =========================
   DEDUPE (WITA-based)
   ========================= */
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];

  for (const r of rows) {
    const key = [
      r.tanggal,
      r.time,
      r.sport,
      r.competition,
      r.home,
      r.away,
      r.channel_1,
      r.channel_2,
    ]
      .join("|")
      .toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* =========================
   MAIN
   ========================= */
(async () => {
  const start = process.argv[2];
  const end = process.argv[3];

  if (!start || !end) {
    console.log("Usage: node src/scrape-wtm.js YYYYMMDD YYYYMMDD");
    process.exit(1);
  }

  const url = buildUrl(start, end);
  console.log("Fetching:", url);

  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    timeout: 30000,
  });

  console.log("HTTP:", res.status);

  // simpan raw html buat audit/debug
  fs.mkdirSync("out", { recursive: true });
  const rawPath = `${process.cwd()}/out/wtm-${start}-${end}.html`;
  fs.writeFileSync(rawPath, res.data, "utf-8");
  console.log("Saved raw HTML:", rawPath);

  const $ = cheerio.load(res.data);

  let rows = parseWTMEvents($);
  rows = dedupeRows(rows);

  console.log("TOTAL rows (deduped):", rows.length);
  if (rows.length === 0) {
    console.warn("Warning: no rows scraped. Check site layout / blocking.");
  }

  // CSV output (WITA) - ✅ urutan kolom sesuai contoh
  let csv =
    "hari,tanggal,time WITA,sport,competition,title,home,away,channel_1,channel_2,channel_3,channel_4,channel_5,channel_6,channel_7,channel_8,event_url\n";

  for (const r of rows) {
    csv += `"${safeCsv(r.hari)}","${safeCsv(r.tanggal)}","${safeCsv(r.time)}","${safeCsv(r.sport)}","${safeCsv(r.competition)}","${safeCsv(r.title)}","${safeCsv(r.home)}","${safeCsv(r.away)}","${safeCsv(r.channel_1)}","${safeCsv(r.channel_2)}","${safeCsv(r.channel_3)}","${safeCsv(r.channel_4)}","${safeCsv(r.channel_5)}","${safeCsv(r.channel_6)}","${safeCsv(r.channel_7)}","${safeCsv(r.channel_8)}","${safeCsv(r.event_url)}"\n`;
  }

  const csvPath = `${process.cwd()}/results.csv`;
  fs.writeFileSync(csvPath, csv, "utf-8");
  console.log("CSV written:", csvPath);

  // optional: send ke Google Sheets (GAS)
  const WEBAPP_URL = getWebappUrl();
  if (!WEBAPP_URL) {
    console.log("WEBAPP_URL not set, skip sending to Google Sheets");
    return;
  }

  try {
    // kirim ARRAY langsung
    const postRes = await axios.post(WEBAPP_URL, rows, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });

    console.log("GAS status:", postRes.status);
    console.log("GAS response:", postRes.data);
  } catch (e) {
    console.error("Failed sending to Google Sheets:", e.response?.data || e.message);
  }
})();
