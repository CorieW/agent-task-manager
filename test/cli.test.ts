/** CLI parsing and command-registry regression coverage. */
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

test("boolean flags do not consume command positionals", async () => {
  const providers = {
    providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
  };
  assert.deepEqual(await runCli(["--json", "providers"]), providers);
  const help = await runCli(["task", "--help", "list"]);
  assert.equal(
    typeof help === "object" && help !== null && "help" in help,
    true,
  );
  await assert.rejects(
    runCli(["providers", "--json=true"]),
    /Boolean flag --json does not accept a value/u,
  );
});

test("CLI rejects unknown command shapes before loading configuration", async () => {
  await assert.rejects(
    runCli(["providers", "bogus", "--json"]),
    /Unknown command: providers bogus/u,
  );
  const help = await runCli(["help"]);
  assert.equal(
    typeof help === "object" &&
      help !== null &&
      "help" in help &&
      typeof help.help === "string" &&
      help.help.includes("active-agent restart"),
    true,
  );
});
