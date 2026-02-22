const axios = require("axios");
const fs = require("fs");
const https = require("https");

const start = process.argv[2];
const end = process.argv[3];

if (!start || !end) {
  console.log("Usage: node src\\scrape-wtm.js YYYYMMDD YYYYMMDD");
  process.exit(1);
}

const url = `https://www.wheresthematch.com/live-sport-on-tv/?showdatestart=${start}&showdateend=${end}`;

// NOTE: buat local kamu yang SSL di-intercept ISP.
// Di GitHub Actions ini gak perlu, tapi aman.
const agent = new https.Agent({ rejectUnauthorized: false });

(async () => {
  try {
    console.log("Fetching:", url);

    const res = await axios.get(url, {
      httpsAgent: agent,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-GB,en;q=0.9"
      },
      timeout: 30000,
      validateStatus: () => true
    });

    console.log("HTTP:", res.status);

    // simpan raw html buat debug
    fs.mkdirSync("out", { recursive: true });
    const outFile = `out/wtm-${start}-${end}.html`;
    fs.writeFileSync(outFile, res.data, "utf-8");

    if (res.status !== 200) {
      console.log("Saved HTML anyway:", outFile);
      console.log("Non-200 response, cek file HTML itu (mungkin block/captcha/redirect).");
      process.exit(0);
    }

    console.log("Saved:", outFile);
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
})();