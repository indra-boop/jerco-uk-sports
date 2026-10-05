// src/wita-time.js
// Konversi instant (ISO dgn offset UK +01:00 BST / +00:00 GMT) -> jam dinding WITA.
// Dipisah dari scrape-wtm.js supaya bisa di-test tanpa network.

const WITA_ZONE = "Asia/Makassar";

// hourCycle "h23" WAJIB. Dengan `hour12: false` saja, Node 20 (ICU-nya) menulis
// tengah malam sebagai "24", jadi kick-off 00:30 WITA keluar "24:30" dan
// ditolak aggregator (jam > 23 dianggap tidak valid -> event hilang).
const PARTS_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: WITA_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const HARI_FORMAT = new Intl.DateTimeFormat("id-ID", {
  timeZone: WITA_ZONE,
  weekday: "long",
});

function isoToWitaPartsISO(isoZ) {
  if (!isoZ) return null;
  const dt = new Date(isoZ);
  if (isNaN(dt.getTime())) return null;

  const parts = {};
  for (const p of PARTS_FORMAT.formatToParts(dt)) parts[p.type] = p.value;

  // Pengaman kalau suatu runtime tetap mengembalikan 24 untuk tengah malam:
  // tanggalnya sudah tanggal hari baru, jadi cukup jamnya yang jadi 00.
  const hour = Number(parts.hour) % 24;
  const HH = String(hour).padStart(2, "0");
  const MM = String(parts.minute).padStart(2, "0");

  return {
    hari: HARI_FORMAT.format(dt),
    tanggal: `${parts.day}-${parts.month}-${parts.year}`,
    time: `${HH}:${MM}`,
    iso: dt.toISOString(),
  };
}

module.exports = { isoToWitaPartsISO, WITA_ZONE };
