import { describe, expect, it, vi } from "vitest";

import { deleteScanFiles, getScan, isUuid, listScans } from "@/lib/db/scans";
import type { ListScansParams } from "@/lib/db/scans";

const USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SCAN = "9c858901-8a57-4791-81fe-4c455b099bc9";

// --------------------------------------------------------------------------
// A minimal query-builder double.
//
// The point is to assert on the *filters the code chooses*, not on Supabase's
// behaviour. Every call is recorded, so a filter that stops being applied shows
// up as a missing entry rather than passing silently.
// --------------------------------------------------------------------------

interface Recorded {
  calls: Array<{ method: string; args: unknown[] }>;
  result: { data: unknown; error: unknown; count: number | null };
}

function makeClient(recorded: Recorded) {
  // The builder is thenable, because `listScans` awaits it directly while
  // `getScan`/`deleteScan` end on `.maybeSingle()`. Both terminals resolve to
  // the same recorded result.
  const terminal = new Set(["maybeSingle", "single"]);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") {
          // `await` on a thenable only settles if `resolve` is actually called.
          // Resolve even when `error` is set: the code under test is
          // responsible for checking that field, and rejecting here would
          // bypass the branch under test.
          return (resolve: (value: unknown) => void) => resolve(recorded.result);
        }
        return (...args: unknown[]) => {
          recorded.calls.push({ method: prop, args });
          // `limit`/`order`/`eq` are chainable modifiers, not terminals.
          return terminal.has(prop) ? Promise.resolve(recorded.result) : proxy;
        };
      },
    },
  );

  return {
    from(table: string) {
      recorded.calls.push({ method: "from", args: [table] });
      return proxy;
    },
  };
}

const noRows: Recorded["result"] = { data: [], error: null, count: 0 };

const run = async (params: ListScansParams = {}) => {
  const recorded: Recorded = { calls: [], result: noRows };
  const result = await listScans(makeClient(recorded) as never, params);
  return { recorded, result };
};

const calledWith = (recorded: Recorded, method: string) =>
  recorded.calls.filter((c) => c.method === method);

/** The column names passed to `.eq(...)`. */
const eqColumns = (recorded: Recorded) => calledWith(recorded, "eq").map((c) => c.args[0]);

// --------------------------------------------------------------------------

describe("isUuid", () => {
  it("accepts a canonical UUID", () => {
    expect(isUuid(USER)).toBe(true);
    expect(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
  });

  it("rejects anything else", () => {
    // These reach the route as `:id` and would otherwise be interpolated into a
    // query, so a loose check matters.
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("../../etc/passwd")).toBe(false);
    expect(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301 ' OR '1'='1")).toBe(false);
    expect(isUuid("3f2504e04f8941d39a0c0305e82c3301")).toBe(false); // no hyphens
  });

  it("anchors both ends, so a valid UUID as a prefix does not pass", () => {
    expect(isUuid(`${USER}extra`)).toBe(false);
    expect(isUuid(` ${USER}`)).toBe(false);
  });
});

describe("listScans", () => {
  it("reads from the scans table", async () => {
    const { recorded } = await run();
    expect(recorded.calls[0]).toEqual({ method: "from", args: ["scans"] });
  });

  it("never filters by user_id, leaving isolation to RLS", async () => {
    // The `scans` policies scope every query to `auth.uid()`. Adding an
    // application-level filter here would be redundant, and worse, it would be
    // the *only* thing standing between a caller and another user's history if
    // a policy were ever dropped.
    const { recorded } = await run();
    expect(eqColumns(recorded)).not.toContain("user_id");
  });

  it("does not accept a user_id override from the caller", async () => {
    // Params come from the URL. If `user_id` were readable from there, a
    // crafted query string would try to read someone else's scans.
    const { recorded } = await run({ userId: USER } as ListScansParams);
    expect(eqColumns(recorded)).not.toContain("user_id");
  });

  it("applies the status filter when one is chosen", async () => {
    const { recorded } = await run({ status: "diseased" });
    expect(calledWith(recorded, "eq")).toContainEqual({ method: "eq", args: ["status", "diseased"] });
  });

  it("omits the status filter when the value is 'all'", async () => {
    // "all" is what the filter bar sends to mean "do not narrow"; passing it
    // through as an equality test would return nothing at all.
    const { recorded } = await run({ status: "all" });
    expect(eqColumns(recorded)).not.toContain("status");
  });

  it("applies the input type filter when one is chosen", async () => {
    const { recorded } = await run({ inputType: "leaf" });
    expect(calledWith(recorded, "eq")).toContainEqual({ method: "eq", args: ["input_type", "leaf"] });
  });

  it("omits the input type filter when the value is 'all'", async () => {
    const { recorded } = await run({ inputType: "all" });
    expect(eqColumns(recorded)).not.toContain("input_type");
  });

  it("filters low-confidence rows only when asked", async () => {
    const withFlag = await run({ lowConfidence: true });
    expect(calledWith(withFlag.recorded, "eq")).toContainEqual({
      method: "eq",
      args: ["is_low_confidence", true],
    });

    const without = await run({ lowConfidence: false });
    expect(eqColumns(without.recorded)).not.toContain("is_low_confidence");
  });

  it("searches with a single OR across the searchable columns", async () => {
    const { recorded } = await run({ search: "canker" });
    const or = calledWith(recorded, "or")[0];
    expect(or).toBeDefined();
    const clause = String(or?.args[0]);
    expect(clause).toContain("predicted_class_display.ilike");
    expect(clause).toContain("predicted_class.ilike");
    expect(clause).toContain("model_version.ilike");
  });

  it("escapes LIKE metacharacters so a search term cannot become a wildcard", async () => {
    // Without escaping, `%` matches every row and `_` matches any character,
    // turning the search box into an unfiltered listing.
    const { recorded } = await run({ search: "100%_" });
    const clause = String(calledWith(recorded, "or")[0]?.args[0]);
    expect(clause).toContain("100\\%");
    expect(clause).toContain("\\_");
  });

  it("ignores a blank search rather than building an empty clause", async () => {
    const { recorded } = await run({ search: "   " });
    expect(calledWith(recorded, "or")).toHaveLength(0);
  });

  it("orders newest-first by default", async () => {
    const { recorded } = await run();
    expect(calledWith(recorded, "order")[0]?.args).toEqual(["created_at", { ascending: false }]);
  });

  it("reverses the order for 'oldest'", async () => {
    const { recorded } = await run({ sort: "oldest" });
    expect(calledWith(recorded, "order")[0]?.args).toEqual(["created_at", { ascending: true }]);
  });

  it("sorts by confidence for that option, with a stable tiebreak", async () => {
    const { recorded } = await run({ sort: "confidence" });
    const orders = calledWith(recorded, "order");
    expect(orders[0]?.args).toEqual(["confidence", { ascending: false }]);
    // Equal confidences would otherwise shuffle between pages.
    expect(orders[1]?.args).toEqual(["created_at", { ascending: false }]);
  });

  it("clamps the page and page size", async () => {
    const negative = await run({ page: -5, pageSize: 10 });
    expect(negative.result.page).toBe(1);
    const range = calledWith(negative.recorded, "range")[0]?.args as number[];
    expect(range[0]).toBe(0);

    const oversized = await run({ pageSize: 10_000 });
    // An unbounded page size would let one request return the whole table.
    expect(oversized.result.pageSize).toBe(50);

    const tiny = await run({ pageSize: 0 });
    expect(tiny.result.pageSize).toBe(1);
  });

  it("computes an in-range offset for a valid page", async () => {
    const { recorded, result } = await run({ page: 3, pageSize: 12 });
    const range = calledWith(recorded, "range")[0]?.args as number[];
    expect(range[0]).toBe(24);
    expect(range[1]).toBe(35);
    expect(result.page).toBe(3);
  });

  it("reports the total so the UI can paginate", async () => {
    const recorded: Recorded = {
      calls: [],
      result: { data: [{ id: "a" }], error: null, count: 42 },
    };
    const result = await listScans(makeClient(recorded) as never, { pageSize: 20 });
    expect(result.total).toBe(42);
    expect(result.totalPages).toBe(3);
    expect(result.scans).toHaveLength(1);
  });

  it("reports one page rather than zero when there are no scans", async () => {
    // `Math.ceil(0/12)` is 0, which would render as "Page 0 of 0".
    const { result } = await run();
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
    expect(Number.isFinite(result.totalPages)).toBe(true);
  });

  it("tolerates a missing count", async () => {
    const recorded: Recorded = { calls: [], result: { data: [], error: null, count: null } };
    const result = await listScans(makeClient(recorded) as never, {});
    expect(result.total).toBe(0);
  });

  it("throws rather than reporting an empty list when the query fails", async () => {
    // Returning `scans: []` on an RLS or network error is indistinguishable
    // from "you have no scans", which reads as data loss to the user.
    const recorded: Recorded = {
      calls: [],
      result: { data: null, error: new Error("permission denied for table scans"), count: null },
    };
    await expect(listScans(makeClient(recorded) as never, {})).rejects.toThrow();
  });

  it("shows the empty state when the schema has not been applied", async () => {
    // An unmigrated database is a *setup state*, and "No scans yet" is the
    // truthful answer to it. Throwing here is what made /scans return HTTP 500
    // for a signed-in user who simply has no scans.
    const recorded: Recorded = {
      calls: [],
      result: {
        data: null,
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.scans' in the schema cache.",
        },
        count: null,
      },
    };
    const result = await listScans(makeClient(recorded) as never, {});
    expect(result.scans).toEqual([]);
    expect(result.total).toBe(0);
    // One page, not zero: `Math.ceil(0/12)` would render as "Page 0 of 0".
    expect(result.totalPages).toBe(1);
  });

  it("still throws for an RLS denial, which is not the same as an empty table", async () => {
    // The boundary that matters. `42501` means the table exists and the caller
    // may not read it - a real fault that must not be laundered into "No scans
    // yet", because that would look exactly like data loss to the user.
    const recorded: Recorded = {
      calls: [],
      result: {
        data: null,
        error: { code: "42501", message: "permission denied for table scans" },
        count: null,
      },
    };
    await expect(listScans(makeClient(recorded) as never, {})).rejects.toThrow();
  });
});

describe("getScan", () => {
  it("returns the row for a valid UUID", async () => {
    const recorded: Recorded = {
      calls: [],
      result: { data: { id: SCAN }, error: null, count: null },
    };
    const scan = await getScan(makeClient(recorded) as never, SCAN);
    expect(scan?.id).toBe(SCAN);
  });

  it("does not query at all for a non-UUID id", async () => {
    // The id reaches this as a URL segment. Bailing out before the query means
    // a crafted path cannot be used to probe for rows.
    const recorded: Recorded = { calls: [], result: noRows };
    const scan = await getScan(makeClient(recorded) as never, "1 OR 1=1");
    expect(scan).toBeNull();
    expect(recorded.calls).toHaveLength(0);
  });

  it("returns null rather than throwing when RLS hides the row", async () => {
    // Someone else's scan must look identical to one that does not exist.
    const recorded: Recorded = {
      calls: [],
      result: { data: null, error: { message: "no rows" }, count: null },
    };
    await expect(getScan(makeClient(recorded) as never, SCAN)).resolves.toBeNull();
  });
});

describe("deleteScanFiles", () => {
  /**
   * A storage double modelling the real object layout:
   *   {user}/{scan}/{original,processed,explanation}/{file}
   *
   * `list` is depth-aware and returns `id: null` for a folder, exactly as the
   * Supabase client does - the distinction the implementation relies on.
   */
  function makeStorage(objects: string[]) {
    const removed: string[] = [];
    const listCalls: string[] = [];

    const list = vi.fn((prefix: string) => {
      listCalls.push(prefix);
      const depth = prefix.split("/").filter(Boolean).length;
      const names = [
        ...new Set(
          objects
            .filter((key) => key.startsWith(`${prefix}/`))
            .map((key) => key.slice(prefix.length + 1).split("/")[0])
            .filter(Boolean),
        ),
      ];
      return Promise.resolve({
        data: names.map((name) => ({
          name,
          // A folder is reported with a null id; a real object has one.
          id: objects.includes(`${prefix}/${name}`) ? "obj-1" : null,
        })),
        error: null,
      });
    });

    const remove = vi.fn((paths: string[]) => {
      removed.push(...paths);
      return Promise.resolve({ data: paths, error: null });
    });

    return { removed, listCalls, list, remove, admin: { storage: { from: () => ({ list, remove }) } } };
  }

  it("descends into the folder level, so files are actually removed", async () => {
    // The original bug: listing `{user}/{scan}` returns `original/`,
    // `processed/`, `explanation/` - not files. Removing those literal names
    // deletes nothing, orphaning the images after the row is gone.
    const storage = makeStorage([
      `${USER}/${SCAN}/original/upload.jpg`,
      `${USER}/${SCAN}/processed/processed.png`,
      `${USER}/${SCAN}/explanation/heatmap.png`,
      `${USER}/${SCAN}/explanation/overlay.png`,
    ]);

    await deleteScanFiles(storage.admin as never, USER, SCAN);

    expect(storage.removed).toEqual(
      expect.arrayContaining([
        `${USER}/${SCAN}/original/upload.jpg`,
        `${USER}/${SCAN}/processed/processed.png`,
        `${USER}/${SCAN}/explanation/heatmap.png`,
        `${USER}/${SCAN}/explanation/overlay.png`,
      ]),
    );
  });

  it("never removes a directory as if it were a file", async () => {
    const storage = makeStorage([`${USER}/${SCAN}/original/upload.jpg`]);
    await deleteScanFiles(storage.admin as never, USER, SCAN);
    for (const path of storage.removed) {
      expect(path).not.toMatch(/\/(original|processed|explanation)$/);
    }
  });

  it("keeps every removed path inside the user's own scan prefix", async () => {
    const storage = makeStorage([`${USER}/${SCAN}/original/upload.jpg`]);
    await deleteScanFiles(storage.admin as never, USER, SCAN);
    expect(storage.removed.length).toBeGreaterThan(0);
    for (const path of storage.removed) expect(path.startsWith(`${USER}/${SCAN}/`)).toBe(true);
  });

  it("removes a file sitting directly under the scan prefix too", async () => {
    // Not the current layout, but the recursion must not depend on it: an
    // object at depth 1 has a non-null id and should be removed as-is.
    const storage = makeStorage([`${USER}/${SCAN}/stray.png`]);
    await deleteScanFiles(storage.admin as never, USER, SCAN);
    expect(storage.removed).toEqual([`${USER}/${SCAN}/stray.png`]);
  });

  it("does nothing, and does not throw, when there are no objects", async () => {
    const storage = makeStorage([]);
    await expect(deleteScanFiles(storage.admin as never, USER, SCAN)).resolves.toBeUndefined();
    expect(storage.removed).toEqual([]);
  });

  it("leaves the row deletable when storage cleanup fails", async () => {
    // Best-effort by design: the caller deletes the database row afterwards, and
    // an orphaned object is recoverable where a lost scan record is not.
    const storage = makeStorage([`${USER}/${SCAN}/original/upload.jpg`]);
    storage.list.mockRejectedValue(new Error("storage unavailable") as never);
    await expect(deleteScanFiles(storage.admin as never, USER, SCAN)).resolves.toBeUndefined();
  });

  it("refuses ids that could escape the prefix, before touching storage", async () => {
    // A crafted prefix would let one user's delete reach another's objects.
    const storage = makeStorage(["other/scan-2/original/x.jpg"]);
    for (const [user, scan] of [
      ["..", SCAN],
      [USER, ".."],
      ["../../etc", SCAN],
      [USER, "a/b"],
      ["", SCAN],
    ]) {
      await expect(deleteScanFiles(storage.admin as never, user, scan)).rejects.toThrow();
    }
    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.removed).toEqual([]);
  });
});