/** Command-execution lease and containment coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrokerCommandRequest,
  ContainmentShutdownUnconfirmedError,
  createCommandExecutionGate,
} from "../src/core/command-proxy.js";

test("command gate releases the global mutex while retaining the run lease", async () => {
  /** Whether the short-lived global mutex is currently held. */
  let globallyLocked = false;
  /** Whether containment failure deliberately abandoned the run lease. */
  let runAbandoned = false;
  /** Whether command execution still owns the non-reclaimable run lease. */
  let runLocked = false;
  /** Global mutex boundary exercised by "command gate releases the global mutex while retaining the run lease". */
  const globalMutex = {
    lock: async () =>
      Object.assign(async () => undefined, {
        abandon: async () => undefined,
      }),
    run: async <T>(operation: () => Promise<T>) => {
      globallyLocked = true;
      try {
        return await operation();
      } finally {
        globallyLocked = false;
      }
    },
  };
  /** Run mutex boundary exercised by "command gate releases the global mutex while retaining the run lease". */
  const runMutex = {
    lock: async (options?: {
      /** Whether a dead owner permits the test mutex to be reclaimed. */
      readonly reclaimable?: boolean;
    }) => {
      assert.equal(globallyLocked, true);
      assert.deepEqual(options, { reclaimable: false });
      runLocked = true;
      return Object.assign(
        async () => {
          runLocked = false;
        },
        {
          abandon: async () => {
            runAbandoned = true;
            runLocked = false;
          },
        },
      );
    },
    run: async <T>(operation: () => Promise<T>) => operation(),
  };
  /** Gate boundary exercised by "command gate releases the global mutex while retaining the run lease". */
  const gate = createCommandExecutionGate(globalMutex, () => runMutex);
  /** Command result returned while only the run lease is held. */
  const result = await gate.execute(
    "run-1",
    async () => {
      assert.equal(globallyLocked, true);
      assert.equal(runLocked, true);
      return {
        arguments: [],
        command: "git",
        commands: { inclusion: ["git"] },
        runId: "run-1",
        schema: "agent-command-broker-request-v1",
        workingDirectory: null,
      };
    },
    async () => {
      assert.equal(globallyLocked, false);
      assert.equal(runLocked, true);
      return "complete";
    },
  );
  assert.equal(result, "complete");
  assert.equal(runLocked, false);
  await assert.rejects(
    gate.execute(
      "run-1",
      async () => brokerRequest(),
      async () => {
        throw new Error("broker failed");
      },
    ),
    /broker failed/u,
  );
  assert.equal(runLocked, false);
  assert.equal(runAbandoned, false);
  await assert.rejects(
    gate.execute(
      "run-1",
      async () => brokerRequest(),
      async () => {
        throw new ContainmentShutdownUnconfirmedError("unconfirmed");
      },
    ),
    /unconfirmed/u,
  );
  assert.equal(runLocked, false);
  assert.equal(runAbandoned, true);
});

/** Builds the minimal authorized request accepted by broker tests. */
function brokerRequest(): BrokerCommandRequest {
  return {
    arguments: [],
    command: "git",
    commands: { inclusion: ["git"] },
    runId: "run-1",
    schema: "agent-command-broker-request-v1",
    workingDirectory: null,
  };
}
