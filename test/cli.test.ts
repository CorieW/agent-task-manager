import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.js";

test("CLI rejects unknown and command-irrelevant flags", async () => {
  await assert.rejects(
    runCli(["providers", "--sttaus", "Open"]),
    /Flag --sttaus is not allowed for providers/u,
  );
  await assert.rejects(
    runCli(["task", "list", "--outcome", "succeeded"]),
    /Flag --outcome is not allowed for task list/u,
  );
  assert.deepEqual(await runCli(["providers", "--json"]), {
    providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
  });
});
