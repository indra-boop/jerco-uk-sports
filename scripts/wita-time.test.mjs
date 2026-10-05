import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isoToWitaPartsISO } = require("../src/wita-time.js");

test("tengah malam WITA ditulis 00:MM, bukan 24:MM", () => {
  // 17:00 BST = 00:00 WITA hari berikutnya
  assert.deepEqual(isoToWitaPartsISO("2026-10-06T17:00:00+01:00"), {
    hari: "Rabu",
    tanggal: "07-10-2026",
    time: "00:00",
    iso: "2026-10-06T16:00:00.000Z",
  });
  // 17:30 BST = 00:30 WITA
  const half = isoToWitaPartsISO("2026-10-06T17:30:00+01:00");
  assert.equal(half.tanggal, "07-10-2026");
  assert.equal(half.time, "00:30");
});

test("jam selalu 00-23 untuk 24 jam penuh", () => {
  for (let h = 0; h < 24; h += 1) {
    const iso = `2026-10-06T${String(h).padStart(2, "0")}:15:00+01:00`;
    const { time } = isoToWitaPartsISO(iso);
    assert.match(time, /^([01]\d|2[0-3]):15$/, `${iso} -> ${time}`);
  }
});

test("BST (+01:00) dan GMT (+00:00) ke WITA", () => {
  // BST: WITA = UK + 7 jam
  const bst = isoToWitaPartsISO("2026-10-05T12:30:00+01:00");
  assert.equal(`${bst.hari} ${bst.tanggal} ${bst.time}`, "Senin 05-10-2026 19:30");
  // GMT: WITA = UK + 8 jam, lewat tengah malam
  const gmt = isoToWitaPartsISO("2026-12-05T20:00:00+00:00");
  assert.equal(`${gmt.hari} ${gmt.tanggal} ${gmt.time}`, "Minggu 06-12-2026 04:00");
});

test("input kosong atau tidak valid mengembalikan null", () => {
  assert.equal(isoToWitaPartsISO(""), null);
  assert.equal(isoToWitaPartsISO(undefined), null);
  assert.equal(isoToWitaPartsISO("bukan tanggal"), null);
});
