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

function parseWTMEvents($) {
  const rows = [];

  $("table tr").each((_, tr) => {
    const $tr = $(tr);

    const fixtures = $tr.find("td.fixture-details").toArray();
    const starts = $tr.find("td.start-details, td.start-date-time").toArray(); // fallback class lama
    const channels = $tr.find("td.channel-details").toArray();

    if (fixtures.length === 0) return;

    for (let i = 0; i < fixtures.length; i++) {
      const $fx = $(fixtures[i]);
      const $st = starts[i] ? $(starts[i]) : null;
      const $ch = channels[i] ? $(channels[i]) : null;

      // teams dari content="India v South-Africa"
      const matchContent = ($fx.attr("content") || "").trim();
      const parts = matchContent.split(" v ");
      const home = parts[0] ? parts[0].replace(/-/g, " ").trim() : "";
      const away = parts[1] ? parts[1].replace(/-/g, " ").trim() : "";

      // sport + competition ada di dalam fixture-details (lihat HTML lu)
      const sport = $fx.find(".fixture-sport img").attr("alt")?.trim() || "";
      const competition = $fx.find(".fixture-comp a").first().text().trim() || "";

      // date/time: ambil dari start-details
      let tanggal = "";
      let time_gmt = "";

      if ($st) {
        time_gmt = $st.find("span.time").text().trim() || "";
        tanggal = $st.find("span.date").text().trim() || "";

        // fallback ke attribute content ISO
        const iso = $st.attr("content");
        if ((!tanggal || !time_gmt) && iso) {
          // contoh: 2026-02-25T13:30:00Z
          // kita ambil date/time raw dari ISO (GMT)
          const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
          if (m) {
            if (!time_gmt) time_gmt = m[2];
            if (!tanggal) tanggal = m[1];
          }
        }
      }

      // channels: img title/alt di channel-details
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
      const href = $fx.find("a.mobile-buy-pass, a[href*='/match/']").first().attr("href");
      if (href) event_url = href.startsWith("http") ? href : `https://www.wheresthematch.com${href}`;

      rows.push({
        day: "range",
        tanggal,
        time_gmt,
        sport,
        competition,
        home,
        away,
        title: home && away ? `${home} vs ${away}` : matchContent,
        channels: channelList.join(" | "),
        event_url
      });
    }
  });

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
