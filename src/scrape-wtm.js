const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

/**
 * WTM Scraper (Range) -> Output WITA
 * - hari/tanggal/time = WITA (Asia/Makassar)
 * - tanggal format: dd-mm-yyyy
 * - channels dipisah channel_1..channel_8
 * - urutan kolom CSV:
 *   hari, tanggal, time WITA, sport, competition, title, home, away, channel_1..channel_8, event_url
 * - pagination: GET page1, lalu POST /live-sport-on-tv/?paging=true untuk page berikutnya
 * - simpan raw HTML ke /out (per page)
 * - optional POST ke GAS (WEBAPP_URL)
 */

function getWebappUrl() {
  return process.env.WEBAPP_URL;
}

/* =========================
   AXIOS CLIENT + COOKIE JAR
   ========================= */
const jar = new CookieJar();
const client = wrapper(
  axios.create({
    jar,
    withCredentials: true,
    timeout: 45000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "Accept-Language": "en-GB,en;q=0.9",
    },
  })
);

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

function safeCsv(v) {
  return (v ?? "").toString().replace(/"/g, '""');
}

function buildUrl(startYYYYMMDD, endYYYYMMDD) {
  return `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${startYYYYMMDD}&showdateend=${endYYYYMMDD}`;
}

function isoToWitaPartsISO(isoZ) {
  const dt = new Date(isoZ);
  if (Number.isNaN(dt.getTime())) return null;

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
   PAGINATION DETECTOR
   ========================= */
function getTotalPagesFromHtml(html) {
  // cari goPage(0), goPage(1), dst
  const matches = [...html.matchAll(/goPage\((\d+)\)/g)].map((m) => parseInt(m[1], 10));
  if (!matches.length) return 1;
  return Math.max(...matches) + 1; // 0-based
}

/**
 * Ambil semua hidden inputs dari form utama (ASP.NET biasanya butuh ini untuk paging)
 */
function extractHiddenFormFields($) {
  const data = {};
  // ambil semua hidden input di page
  $("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") ?? "";
    if (name) data[name] = value;
  });
  return data;
}

/**
 * Set page index ke field paging yang ada (WTM kelihatan pakai pagetotalhp*)
 * Karena implementasi bisa beda, kita set beberapa kandidat kalau ada.
 */
function applyPagingIndex(formData, pageIndex0Based) {
  const page1Based = String(pageIndex0Based + 1);

  // dari cookie lu kelihatan ada pagetotalhp3 / pagetotalhp2 / pagetotalhp0
  // jadi kita update yang exist aja
  const candidates = ["pagetotalhp3", "pagetotalhp2", "pagetotalhp1", "page", "pagenum"];
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(formData, k)) {
      formData[k] = page1Based;
    }
  }

  // beberapa ASP.NET paging pakai __EVENTTARGET / __EVENTARGUMENT
  if (Object.prototype.hasOwnProperty.call(formData, "__EVENTARGUMENT")) {
    formData["__EVENTARGUMENT"] = page1Based;
  }
  // kalau ada __EVENTTARGET, biarin aja (jangan kosongin)
  return formData;
}

function toFormUrlEncoded(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    p.append(k, v == null ? "" : String(v));
  }
  return p.toString();
}

/* =========================
   PARSER WTM (GRID BY INDEX)
   ========================= */
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

      const matchContent = ($fx.attr("content") || "").trim();
      const parts = matchContent.split(" v ");
      const home = parts[0] ? parts[0].replace(/-/g, " ").trim() : "";
      const away = parts[1] ? parts[1].replace(/-/g, " ").trim() : "";

      const sport = $fx.find(".fixture-sport img").attr("alt")?.trim() || "";
      const competition = $fx.find(".fixture-comp a").first().text().trim() || "";

      // ISO Z (UTC) untuk convert WITA
      let isoZ = "";
      if ($st) isoZ = ($st.attr("content") || "").trim();
      if (!isoZ) {
        const metaIso = $tr.find('meta[itemprop="startDate"]').first().attr("content");
        if (metaIso) isoZ = metaIso.trim();
      }

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
      }

      // channels
      const channelList = [];
      if ($ch) {
        $ch.find("img").each((_, img) => {
          let t = $(img).attr("title") || $(img).attr("alt") || "";
          t = t.replace(/Live on\s*/i, "").replace(/\s*logo\s*$/i, "").trim();
          if (t) channelList.push(t);
        });
      }

      // event_url
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
        title: home && away ? `${home} vs ${away}` : matchContent,
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
   DEDUPE
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
   FETCH PAGE 1 (GET) + PAGE N (POST paging=true)
   ========================= */
async function fetchFirstPage(urlBase) {
  const res = await client.get(urlBase, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  return { html: res.data, status: res.status };
}

async function fetchPagedPage(urlBase, prevHtml, pageIndex0Based) {
  // endpoint paging (sesuai Network lu)
  const pagingUrl = "https://www.wheresthematch.com/live-sport-on-tv/?paging=true";

  // ambil hidden fields dari HTML terakhir (biasanya berubah tiap page)
  const $ = cheerio.load(prevHtml);
  const formData = extractHiddenFormFields($);

  // inject page index
  applyPagingIndex(formData, pageIndex0Based);

  // kadang perlu bawa showdatestart/showdateend juga kalau ada
  // (kalau hidden inputs sudah ada, aman)
  // kalau gak ada, minimal tetap referer ke urlBase

  const body = toFormUrlEncoded(formData);

  const res = await client.post(pagingUrl, body, {
    headers: {
      Origin: "https://www.wheresthematch.com",
      Referer: urlBase,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html, */*; q=0.9",
    },
  });

  return { html: res.data, status: res.status, usedUrl: pagingUrl };
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

  const urlBase = buildUrl(start, end);
  console.log("Fetching:", urlBase);

  fs.mkdirSync("out", { recursive: true });

  // GET page 1
  const first = await fetchFirstPage(urlBase);
  console.log("HTTP page1:", first.status);

  const rawPath1 = `${process.cwd()}/out/wtm-${start}-${end}-p1.html`;
  fs.writeFileSync(rawPath1, first.html, "utf-8");
  console.log("Saved raw HTML:", rawPath1);

  const totalPages = getTotalPagesFromHtml(first.html);
  console.log("Detected pages:", totalPages);

  let rowsAll = [];
  let prevHtml = first.html;

  // parse page1
  {
    const $ = cheerio.load(first.html);
    const r1 = parseWTMEvents($);
    console.log("Rows p1:", r1.length);
    rowsAll.push(...r1);
  }

  // POST page2..N
  for (let p = 1; p < totalPages; p++) {
    console.log(`Fetching page ${p + 1}/${totalPages} via POST paging=true ...`);
    const got = await fetchPagedPage(urlBase, prevHtml, p);

    const rawPath = `${process.cwd()}/out/wtm-${start}-${end}-p${p + 1}.html`;
    fs.writeFileSync(rawPath, got.html, "utf-8");
    console.log("Saved raw HTML:", rawPath, "HTTP:", got.status);

    const $p = cheerio.load(got.html);
    const rp = parseWTMEvents($p);
    console.log(`Rows p${p + 1}:`, rp.length);
    rowsAll.push(...rp);

    // penting: update prevHtml (VIEWSTATE berubah)
    prevHtml = got.html;
  }

  const rows = dedupeRows(rowsAll);
  console.log("TOTAL rows (deduped):", rows.length);

  // CSV output
  // NOTE: header boleh ada spasi ("time WITA") — Excel/Sheets aman.
  // Kalau mau enak dipakai program lain, pakai time_WITA.
  let csv =
    "hari,tanggal,time WITA,sport,competition,title,home,away,channel_1,channel_2,channel_3,channel_4,channel_5,channel_6,channel_7,channel_8,event_url\n";

  for (const r of rows) {
    csv += `"${safeCsv(r.hari)}","${safeCsv(r.tanggal)}","${safeCsv(r.time)}","${safeCsv(r.sport)}","${safeCsv(r.competition)}","${safeCsv(r.title)}","${safeCsv(r.home)}","${safeCsv(r.away)}","${safeCsv(r.channel_1)}","${safeCsv(r.channel_2)}","${safeCsv(r.channel_3)}","${safeCsv(r.channel_4)}","${safeCsv(r.channel_5)}","${safeCsv(r.channel_6)}","${safeCsv(r.channel_7)}","${safeCsv(r.channel_8)}","${safeCsv(r.event_url)}"\n`;
  }

  const csvPath = `${process.cwd()}/results.csv`;
  fs.writeFileSync(csvPath, csv, "utf-8");
  console.log("CSV written:", csvPath);

  // optional: send ke GAS
  const WEBAPP_URL = getWebappUrl();
  if (!WEBAPP_URL) {
    console.log("WEBAPP_URL not set, skip sending to Google Sheets");
    return;
  }

  try {
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
