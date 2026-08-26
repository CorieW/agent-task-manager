/** Provider-module discovery and construction coverage. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { loadEnvironment, providerFor } from "../src/cli/runtime.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import {
  AGENT_TASK_PROVIDER_MODULE_SCHEMA,
  parseAgentTaskProviderModule,
} from "../src/provider/provider-module.js";

test("CLI loads an arbitrary provider module relative to its environment", async () => {
  /** Temporary provider package and environment root. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-provider-"));
  /** Compiled in-memory provider imported by the external module fixture. */
  const inMemoryUrl = pathToFileURL(
    resolve("dist/src/provider/in-memory-provider.js"),
  ).href;
  try {
    await writeFile(
      join(root, "custom-provider.mjs"),
      `import { InMemoryProvider } from ${JSON.stringify(inMemoryUrl)};
export const agentTaskProviderModule = {
  schema: ${JSON.stringify(AGENT_TASK_PROVIDER_MODULE_SCHEMA)},
  type: "custom-memory",
  create(context) {
    if (context.options.marker !== "opaque") throw new Error("options changed");
    return new InMemoryProvider();
  }
};
`,
      "utf8",
    );
    /** Environment referencing a local adapter without any provider-specific fields. */
    const environmentPath = join(root, "environment.json");
    await writeFile(
      environmentPath,
      JSON.stringify({
        environmentId: "custom",
        provider: {
          module: "./custom-provider.mjs",
          options: { marker: "opaque" },
        },
        schema: "agent-task-manager-environment-v1",
      }),
      "utf8",
    );

    const configuration = await loadEnvironment(environmentPath, {});
    const provider = await providerFor(configuration, {});
    assert.equal(provider instanceof InMemoryProvider, true);
    assert.equal((await provider.validateWorkspace()).valid, true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("provider modules must implement the versioned named-export contract", () => {
  assert.throws(
    () => parseAgentTaskProviderModule({}, "invalid-provider"),
    /must export agentTaskProviderModule/u,
  );
  assert.throws(
    () =>
      parseAgentTaskProviderModule(
        {
          agentTaskProviderModule: {
            create: () => ({}),
            schema: "wrong",
            type: "invalid",
          },
        },
        "invalid-provider",
      ),
    /schema must equal agent-task-provider-module-v1/u,
  );
});
