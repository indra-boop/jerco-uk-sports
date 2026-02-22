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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
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

/* =========================
   CORE LOGIC
   ========================= */
function extractHiddenFields($) {
  const fields = {};
  $("input[type='hidden']").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") || "";
    if (name) fields[name] = value;
  });
  return fields;
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
    
    let isoZ = $tr.find("td.start-details").attr("content") || $tr.find('meta[itemprop="startDate"]').attr("content");
    let { hari, tanggal, time } = isoToWitaPartsISO(isoZ) || { hari: "", tanggal: "", time: "" };

    const channels = [];
    $tr.find("td.channel-details img").each((_, img) => {
      let t = $(img).attr("title") || $(img).attr("alt") || "";
      t = t.replace(/Live on\s*/i, "").replace(/\s*logo\s*$/i, "").trim();
      if (t) channels.push(t);
    });

    const event_url = $fx.find("a[href*='/match/']").attr("href");

    rows.push({
      page: pageNum,
      hari, tanggal, time, sport, competition,
      title: home && away ? `${home} vs ${away}` : matchContent,
      home, away,
      channels,
      event_url: event_url ? (event_url.startsWith("http") ? event_url : `https://www.wheresthematch.com${event_url}`) : ""
    });
  });
  return rows;
}

async function scrape() {
  const start = process.argv[2];
  const end = process.argv[3];

  if (!start || !end) {
    console.log("Usage: node scrape.js 20260222 20260301");
    return;
  }

  const urlBase = buildUrl(start, end);
  fs.mkdirSync("out", { recursive: true });

  let allData = [];
  let currentPageHtml = "";

  console.log(`Fetching Page 1: ${urlBase}`);
  const res1 = await client.get(urlBase);
  currentPageHtml = res1.data;
  fs.writeFileSync(`./out/page-1.html`, currentPageHtml);

  const $1 = cheerio.load(currentPageHtml);
  const p1Data = parseWTMEvents($1, 1);
  allData.push(...p1Data);
  console.log(`Page 1 done. Found: ${p1Data.length} items.`);

  const pageMatches = [...currentPageHtml.matchAll(/goPage\((\d+)\)/g)];
  const totalPages = pageMatches.length > 0 ? Math.max(...pageMatches.map(m => parseInt(m[1]))) + 1 : 1;
  console.log(`Total pages detected: ${totalPages}`);

  for (let p = 1; p < totalPages; p++) {
    const pageNum = p + 1;
    console.log(`Fetching Page ${pageNum}/${totalPages}...`);
    
    const $prev = cheerio.load(currentPageHtml);
    const hiddenFields = extractHiddenFields($prev);

    const payload = new URLSearchParams({
      ...hiddenFields,
      "__EVENTTARGET": `pagetotalhp${p}`,
      "__EVENTARGUMENT": "",
    });

    try {
      const resNext = await client.post("https://www.wheresthematch.com/live-sport-on-tv/?paging=true", payload.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": urlBase
        }
      });

      currentPageHtml = resNext.data;
      fs.writeFileSync(`./out/page-${pageNum}.html`, currentPageHtml);

      const $next = cheerio.load(currentPageHtml);
      const pNextData = parseWTMEvents($next, pageNum);
      
      if (pNextData.length === 0) break;

      allData.push(...pNextData);
      console.log(`Page ${pageNum} done. Found: ${pNextData.length} items.`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`Error on page ${pageNum}:`, err.message);
      break;
    }
  }

  let csv = "page,hari,tanggal,time WITA,sport,competition,title,home,away,channel_1,channel_2,event_url\n";
  allData.forEach(r => {
    csv += `"${safeCsv(r.page)}","${safeCsv(r.hari)}","${safeCsv(r.tanggal)}","${safeCsv(r.time)}","${safeCsv(r.sport)}","${safeCsv(r.competition)}","${safeCsv(r.title)}","${safeCsv(r.home)}","${safeCsv(r.away)}","${safeCsv(r.channels[0])}","${safeCsv(r.channels[1])}","${safeCsv(r.event_url)}"\n`;
  });

  fs.writeFileSync("results.csv", csv);
  console.log(`\nCOMPLETED! Total data: ${allData.length}. Saved to results.csv`);
}

scrape();
