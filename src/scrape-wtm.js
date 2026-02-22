const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

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
  return [...new Set((arr || []).map(x => clean(x)).filter(Boolean))];
}

function safeCsv(v) {
  return (v ?? "").toString().replace(/"/g, '""');
}

const TIME_RE = /\b([01]\d|2[0-3]):[0-5]\d\b/; // 00:00 - 23:59

function buildUrl(startYYYYMMDD, endYYYYMMDD) {
  return `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${startYYYYMMDD}&showdateend=${endYYYYMMDD}`;
}

function parseYmd(yyyymmdd) {
  // yyyymmdd -> Date UTC 00:00
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d, 0, 0, 0));
  return dt;
}

function formatIdDate(dt, tz = "Asia/Makassar") {
  // output dd/mm/yy in id-ID on timezone
  const s = new Intl.DateTimeFormat("id-ID", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(dt);
  return s;
}

function formatIdDay(dt, tz = "Asia/Makassar") {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: tz,
    weekday: "long",
  }).format(dt);
}

/* =========================
   DATE RESOLVER (WTM)
   =========================
   WTM biasanya punya header per hari (kadang “Sunday 22 February 2026” / “Sun 22 Feb”).
   Kita coba ambil dari elemen heading terdekat. Kalau gagal -> fallback ke start date + offset.
*/
const MONTH_MAP = {
  January: 0, Jan: 0,
  February: 1, Feb: 1,
  March: 2, Mar: 2,
  April: 3, Apr: 3,
  May: 4,
  June: 5, Jun: 5,
  July: 6, Jul: 6,
  August: 7, Aug: 7,
  September: 8, Sep: 8, Sept: 8,
  October: 9, Oct: 9,
  November: 10, Nov: 10,
  December: 11, Dec: 11
};

function tryParseDateFromText(text, defaultYear) {
  const t = clean(text);

  // formats like: "Sunday 22 February 2026" or "Sun 22 Feb 2026"
  let m = t.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b.*?\b(\d{1,2})\b.*?\b([A-Za-z]+)\b.*?\b(20\d{2})\b/i);
  if (m) {
    const dayNum = parseInt(m[2], 10);
    const monthRaw = m[3];
    const year = parseInt(m[4], 10);
    const monthName = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1).toLowerCase();
    const monthIdx = MONTH_MAP[monthName];
    if (monthIdx != null && !Number.isNaN(dayNum)) {
      const d = new Date(year, monthIdx, dayNum);
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }

  // formats like: "Sun 22 Feb" (tanpa tahun)
  m = t.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*?\b(\d{1,2})\b.*?\b([A-Za-z]+)\b/i);
  if (m) {
    const dayNum = parseInt(m[2], 10);
    const monthRaw = m[3];
    const monthName = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1).toLowerCase();
    const monthIdx = MONTH_MAP[monthName];
    if (monthIdx != null && !Number.isNaN(dayNum)) {
      const d = new Date(defaultYear, monthIdx, dayNum);
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }

  return null;
}

/* =========================
   EVENT PARSER (WTM)
   ========================= */

function looksLikeEventBlock(text) {
  const t = clean(text);
  if (!TIME_RE.test(t)) return false;
  // match vs style
  if (!(/\sv\s/i.test(t) || /\svs\s/i.test(t) || /\s-\s/.test(t))) return false;
  return true;
}

function pickNearestHeaderText($, $el) {
  // coba cari header di atas block: h2/h3/h4
  const heads = $el.prevAll("h2,h3,h4").slice(0, 3);
  for (let i = 0; i < heads.length; i++) {
    const ht = clean($(heads[i]).text());
    if (ht) return ht;
  }
  // atau parent container
  const pHeads = $el.parents().first().prevAll("h2,h3,h4").slice(0, 3);
  for (let i = 0; i < pHeads.length; i++) {
    const ht = clean($(pHeads[i]).text());
    if (ht) return ht;
  }
  return "";
}

function extractTeamsFromText(text) {
  const t = clean(text);

  // prefer "A v B" / "A vs B"
  let m = t.match(/(.+?)\s(v|vs)\s(.+?)(\s|$)/i);
  if (m) {
    return {
      home: clean(m[1]),
      away: clean(m[3]),
    };
  }

  // fallback "A - B"
  m = t.match(/(.+?)\s-\s(.+?)(\s|$)/);
  if (m) {
    return { home: clean(m[1]), away: clean(m[2]) };
  }

  return { home: "", away: "" };
}

function extractTimeFromText(text) {
  const t = clean(text);
  const m = t.match(TIME_RE);
  return m ? m[0] : "";
}

function extractChannels($, $block) {
  // channel biasanya ada di img alt/title (logo)
  const raw = $block.find("img").map((_, img) => {
    const $img = $(img);
    return $img.attr("title") || $img.attr("alt") || "";
  }).get();

  return uniq(raw)
    .map(x => x.replace(/Live on\s*/i, "").replace(/\s*logo\s*$/i, "").trim())
    .filter(Boolean);
}

function parseWTMEvents($, startYYYYMMDD) {
  const rows = [];

  const startDate = parseYmd(startYYYYMMDD);
  const defaultYear = startDate.getUTCFullYear();

  // kandidat elemen yang “event-like”
  const candidates = $("li, div, article, section, p")
    .filter((_, el) => looksLikeEventBlock($(el).text()))
    .toArray();

  // filter: ambil leaf block (biar gak dobel nested)
  const blocks = candidates.filter(el => {
    const $el = $(el);
    const childHasEvent = $el.find("li, div, p").toArray()
      .some(ch => looksLikeEventBlock($(ch).text()));
    return !childHasEvent;
  });

  for (const el of blocks) {
    const $block = $(el);
    const text = clean($block.text());
    const time_gmt = extractTimeFromText(text);
    if (!time_gmt) continue;

    // ambil teams dari line yang mengandung v/vs/-
    const lines = text.split("\n").map(clean).filter(Boolean);
    const lineTeams =
      lines.find(l => /\sv\s/i.test(l) || /\svs\s/i.test(l) || /\s-\s/.test(l)) || text;

    const { home, away } = extractTeamsFromText(lineTeams);

    // event_url: coba ambil link pertama dalam block
    let event_url = "";
    const href = $block.find("a").first().attr("href");
    if (href) {
      event_url = href.startsWith("http") ? href : `https://www.wheresthematch.com${href}`;
    }

    // date: coba dari header terdekat
    const headerGuess = pickNearestHeaderText($, $block);
    let baseDate = tryParseDateFromText(headerGuess, defaultYear);

    // fallback kalau header gak kebaca: pake start date (ga akurat tapi keep data)
    if (!baseDate) {
      baseDate = new Date(startDate);
      baseDate.setUTCHours(0, 0, 0, 0);
    } else {
      baseDate.setHours(0, 0, 0, 0);
    }

    // sport/competition: best-effort dari headerGuess (kalau headerGuess isinya sport/competition)
    // (WTM kadang header = tanggal, jadi bisa kosong)
    const sport = ""; // nanti bisa di-upgrade kalau udah tau selector stabil
    const competition = ""; // nanti bisa di-upgrade kalau udah tau selector stabil

    // hari/tanggal untuk output WITA (biar mirip style lu)
    // NOTE: time di WTM biasanya waktu UK/GMT/Local UK; lu bisa mapping ke WITA nanti.
    // Untuk sekarang kita simpan sebagai "time_gmt" + tanggal baseDate.
    const hari_wita = formatIdDay(baseDate, "Asia/Makassar");
    const tanggal_wita = formatIdDate(baseDate, "Asia/Makassar");

    const channels = extractChannels($, $block);

    rows.push({
      day: "range",
      hari: hari_wita,
      tanggal: tanggal_wita,
      time_gmt,
      sport,
      competition,
      home,
      away,
      title: home && away ? `${home} vs ${away}` : lineTeams,
      channels: channels.join(" | "),
      event_url
    });
  }

  return rows;
}

/* =========================
   DEDUPE
   ========================= */
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];

  for (const r of rows) {
    const key = [
      r.tanggal,
      r.time_gmt,
      r.sport,
      r.competition,
      r.home,
      r.away,
      r.channels
    ].join("|").toLowerCase();

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
      "Accept-Language": "en-GB,en;q=0.9"
    },
    timeout: 30000
  });

  console.log("HTTP:", res.status);

  // simpan raw html buat audit/debug
  fs.mkdirSync("out", { recursive: true });
  const rawPath = `${process.cwd()}/out/wtm-${start}-${end}.html`;
  fs.writeFileSync(rawPath, res.data, "utf-8");
  console.log("Saved raw HTML:", rawPath);

  const $ = cheerio.load(res.data);

  let rows = parseWTMEvents($, start);
  rows = dedupeRows(rows);

  console.log("TOTAL rows (deduped):", rows.length);
  if (rows.length === 0) {
    console.warn("Warning: no rows scraped. Check site layout / blocking.");
  }

  // CSV output (mirip gaya lu)
  let csv =
    "day,hari,tanggal,time_gmt,sport,competition,home,away,title,channels,event_url\n";

  for (const r of rows) {
    csv += `"${safeCsv(r.day)}","${safeCsv(r.hari)}","${safeCsv(r.tanggal)}","${safeCsv(r.time_gmt)}","${safeCsv(r.sport)}","${safeCsv(r.competition)}","${safeCsv(r.home)}","${safeCsv(r.away)}","${safeCsv(r.title)}","${safeCsv(r.channels)}","${safeCsv(r.event_url)}"\n`;
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
    const postRes = await axios.post(WEBAPP_URL, rows, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log("GAS status:", postRes.status);
    console.log("GAS response:", postRes.data);
  } catch (e) {
    console.error("Failed sending to Google Sheets:", e.response?.data || e.message);
  }
})();
