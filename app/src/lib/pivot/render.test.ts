import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderPivot } from "@/lib/pivot/render";
import { queryFromJsonable } from "@/lib/pivot/types";
import { FIXTURE } from "@/lib/pivot/allowlist.fixture";

const REPO = path.resolve(__dirname, "../../../..");
const goldens = JSON.parse(
  readFileSync(path.join(REPO, "sql/03_queries/goldens/pivot.json"), "utf8"),
);

describe("renderPivot reproduces every pinned golden byte-for-byte", () => {
  for (const c of goldens.cases) {
    it(c.name, () => {
      const { sql, params } = renderPivot(queryFromJsonable(c.query), FIXTURE);
      expect(sql).toBe(c.sql);
      expect(params).toEqual(c.params);
    });
  }
});
