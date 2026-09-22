import { describe, expect, it } from "vitest";
import { runCleanup } from "./helpers/cleanup";

describe("runCleanup", () => {
  it("runs every cleanup task after an earlier task fails", async () => {
    const completed: string[] = [];
    await expect(runCleanup([
      { label: "first", run: () => { completed.push("first"); throw new Error("failed"); } },
      { label: "second", run: async () => { completed.push("second"); } },
      { label: "third", run: () => { completed.push("third"); } },
    ])).rejects.toThrow("first: failed");
    expect(completed).toEqual(["first", "second", "third"]);
  });

  it("retains every labelled failure", async () => {
    const error = await runCleanup([
      { label: "account", run: () => { throw new Error("delete failed"); } },
      { label: "database", run: () => { throw new Error("close failed"); } },
    ]).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(item => (item as Error).message)).toEqual([
      "account: delete failed",
      "database: close failed",
    ]);
  });
});
