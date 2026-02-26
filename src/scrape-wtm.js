// scrape-wtm.js (FIX: no double rows, safer pagination)
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
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

function buildUrl(start, end) {
  return `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${start}&showdateend=${end}`;
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
 * Detect total pages from HTML pagination.
 * Fix: jangan +1 ngawur. Ambil max goPage(n) apa adanya.
 * Kalau gak ketemu -> 1.
 */
function detectTotalPages(html) {
  const matches = [...html.matchAll(/goPage\((\d+)\)/g)].map((m) => parseInt(m[1], 10));
  if (!matches.length) return 1;
  const max = Math.max(...matches);
  // WTM biasanya goPage(1..N)
  return Number.isFinite(max) && max >= 1 ? max : 1;
}

function parseWTMEvents($, pageNum) {
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
 * Dedup helper:
 * prefer event_url (paling unique), fallback ke tanggal+time+home+away
 */
function dedupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key =
      (r.event_url && r.event_url.trim()) ||
      `${r.tanggal}|${r.time}|${r.home}|${r.away}|${r.sport}|${r.competition}`;
    if (!map.has(key)) map.set(key, r);
  }
  return Array.from(map.values());
}

async function scrape() {
  const start = process.argv[2];
  const end = process.argv[3];

  if (!start || !end) {
    console.log("Usage: node scrape-wtm.js 20260222 20260301");
    process.exit(1);
  }

  const urlBase = buildUrl(start, end);
  fs.mkdirSync("out", { recursive: true });

  let allData = [];
  let currentPageHtml = "";

  // ===== Page 1 =====
  console.log(`Fetching Page 1: ${urlBase}`);
  const res1 = await client.get(urlBase);
  currentPageHtml = res1.data;
  fs.writeFileSync(`./out/page-1.html`, currentPageHtml);

  const $1 = cheerio.load(currentPageHtml);
  const p1Data = parseWTMEvents($1, 1);
  allData.push(...p1Data);
  allData = dedupRows(allData);

  console.log(`Page 1 done. Found: ${p1Data.length} items (after dedup: ${allData.length}).`);

  // ===== Detect pages =====
  const totalPages = detectTotalPages(currentPageHtml);
  console.log(`Total pages detected: ${totalPages}`);

  // Fingerprint untuk detect halaman sama (biar stop kalau server balikin page yang sama)
  let lastFingerprint = allData.length
    ? (allData[0].event_url || `${allData[0].tanggal}|${allData[0].time}|${allData[0].home}|${allData[0].away}`)
    : "";

  // ===== Paging POST (Page 2..N) =====
  for (let p = 2; p <= totalPages; p++) {
    console.log(`Fetching Page ${p}/${totalPages}...`);

    // hidden fields harus dari HTML terakhir (ASP.NET postback)
    const $prev = cheerio.load(currentPageHtml);
    const hiddenFields = extractHiddenFields($prev);

    // event target biasanya pakai index 1 untuk page 2, 2 untuk page 3, dst
    // jadi idx = p-1
    const idx = p - 1;

    const payload = new URLSearchParams({
      ...hiddenFields,
      __EVENTTARGET: `pagetotalhp${idx}`,
      __EVENTARGUMENT: "",
    });

    try {
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

      currentPageHtml = resNext.data;
      fs.writeFileSync(`./out/page-${p}.html`, currentPageHtml);

      const $next = cheerio.load(currentPageHtml);
      const pNextData = parseWTMEvents($next, p);

      if (pNextData.length === 0) {
        console.log(`Page ${p} returned 0 rows. Stop.`);
        break;
      }

      // detect "same page returned" (server kadang balikin page sebelumnya)
      const fp =
        (pNextData[0].event_url && pNextData[0].event_url.trim()) ||
        `${pNextData[0].tanggal}|${pNextData[0].time}|${pNextData[0].home}|${pNextData[0].away}`;

      if (fp && fp === lastFingerprint) {
        console.log(`Duplicate page detected (same fingerprint). Stop pagination.`);
        break;
      }

      // append + dedup
      const before = allData.length;
      allData.push(...pNextData);
      allData = dedupRows(allData);
      const after = allData.length;

      console.log(`Page ${p} done. Found: ${pNextData.length}. Added unique: ${after - before}.`);

      // update fingerprint
      lastFingerprint = fp || lastFingerprint;

      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error(`Error on page ${p}:`, err.message);
      break;
    }
  }

  // ===== Final dedup (safety) =====
  allData = dedupRows(allData);

  // ===== CSV build =====
  let csv =
    "page,hari,tanggal,time WITA,sport,competition,title,home,away,channel_1,channel_2,event_url\n";

  allData.forEach((r) => {
    csv += `"${safeCsv(r.page)}","${safeCsv(r.hari)}","${safeCsv(r.tanggal)}","${safeCsv(
      r.time
    )}","${safeCsv(r.sport)}","${safeCsv(r.competition)}","${safeCsv(r.title)}","${safeCsv(
      r.home
    )}","${safeCsv(r.away)}","${safeCsv(r.channels?.[0])}","${safeCsv(
      r.channels?.[1]
    )}","${safeCsv(r.event_url)}"\n`;
  });

  fs.writeFileSync("results.csv", csv);
  console.log(`\nCOMPLETED! Total unique data: ${allData.length}. Saved to results.csv`);
}

scrape().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
