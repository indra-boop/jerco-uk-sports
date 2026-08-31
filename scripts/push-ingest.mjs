#!/usr/bin/env node
// Push results.csv ke aggregator /api/ingest/v2.
// Source alias "jerco-uk-sports" dipetakan ke "wheresthematch" oleh core.mjs.
// Header CSV dikirim apa adanya; adaptWtm() yang menangani normalisasi.

import { readFileSync } from "node:fs";

const CSV_PATH = process.env.INGEST_CSV_PATH || "results.csv";
const SOURCE = "jerco-uk-sports";
const MAX_EVENTS_PER_SYNC = 2000;
const DRY_RUN = process.argv.includes("--dry-run");

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toRecords(rows) {
  if (rows.length < 2) {
    throw new Error(`${CSV_PATH}: tidak ada baris data.`);
  }

  const header = rows[0].map((h) => h.trim());
  const records = [];

  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.trim() === "")) continue;

    const record = {};
    header.forEach((key, i) => {
      const value = (row[i] ?? "").trim();
      if (value !== "") record[key] = value;
    });

    // WTM can reuse the same event URL for a later occurrence. The aggregator
    // keeps rows outside the incoming date window, so a URL-only key can clash
    // with an older occurrence that is intentionally preserved.
    if (record.event_url && record.tanggal && record["time WITA"]) {
      record.source_key = [
        record.event_url,
        record.tanggal,
        record["time WITA"],
      ].join("|");
    }

    if (Object.keys(record).length > 0) records.push(record);
  }

  return records;
}

function summarise(records) {
  const dates = new Set();
  let withChannel = 0;
  for (const r of records) {
    if (r.tanggal) dates.add(r.tanggal);
    if (r.channel_1) withChannel += 1;
  }
  return {
    rows: records.length,
    distinctDates: [...dates].sort(),
    rowsWithChannel: withChannel,
  };
}

async function main() {
  const raw = readFileSync(CSV_PATH, "utf8");
  const records = toRecords(parseCsv(raw));
  const stats = summarise(records);

  console.log(`Source        : ${SOURCE}`);
  console.log(`CSV           : ${CSV_PATH}`);
  console.log(`Rows          : ${stats.rows}`);
  console.log(`Rows w/channel: ${stats.rowsWithChannel}`);
  console.log(`Dates         : ${stats.distinctDates.join(", ") || "(none)"}`);

  if (stats.rows === 0) {
    console.error("FATAL: tidak ada event untuk dikirim.");
    process.exit(1);
  }
  if (stats.rows > MAX_EVENTS_PER_SYNC) {
    console.error(`FATAL: ${stats.rows} event melebihi batas ${MAX_EVENTS_PER_SYNC} per sync.`);
    process.exit(1);
  }
  if (stats.rowsWithChannel === 0) {
    console.error("FATAL: tidak ada baris dengan channel_1 terisi; kemungkinan markup berubah.");
    process.exit(1);
  }

  const payload = { source: SOURCE, events: records };

  if (DRY_RUN) {
    console.log("\n-- DRY RUN: tidak ada request keluar --");
    console.log(`Payload bytes : ${Buffer.byteLength(JSON.stringify(payload))}`);
    console.log("Sample event  :");
    console.log(JSON.stringify(records[0], null, 2));
    return;
  }

  const url = process.env.DASHBOARD_INGEST_URL;
  const token = process.env.DASHBOARD_INGEST_TOKEN;
  if (!url) throw new Error("DASHBOARD_INGEST_URL belum diset.");
  if (!token) throw new Error("DASHBOARD_INGEST_TOKEN belum diset.");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`FATAL: ingest gagal HTTP ${response.status}`);
    console.error(text.slice(0, 1000));
    process.exit(1);
  }

  console.log(`\nIngest OK (HTTP ${response.status})`);
  console.log(text.slice(0, 1000));
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
