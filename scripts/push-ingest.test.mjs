import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("uses an occurrence-specific source key when WTM reuses an event URL", () => {
  const directory = mkdtempSync(join(tmpdir(), "wtm-ingest-"));
  const csvPath = join(directory, "results.csv");

  try {
    writeFileSync(
      csvPath,
      [
        "tanggal,time WITA,title,channel_1,event_url",
        '"05-09-2026","19:30","Shamrock Rovers vs Shelbourne","[GB] LOITV","https://www.wheresthematch.com/match/shamrock-rovers-vs-shelbourne/212228"',
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "push-ingest.mjs"), "--dry-run"],
      {
        encoding: "utf8",
        env: { ...process.env, INGEST_CSV_PATH: csvPath },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /"source_key": "https:\/\/www\.wheresthematch\.com\/match\/shamrock-rovers-vs-shelbourne\/212228\|05-09-2026\|19:30"/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
