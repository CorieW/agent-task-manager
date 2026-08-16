/** Verifies environment-defined commands, publication targets, and browser boundaries. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfiguredCommandEffects,
  DisposableBrowserEffects,
  DraftPublicationEffects,
  sha256,
  type CommandProcessRunner,
  type DisposableBrowserDriver,
  type DraftPublicationDriver,
  type ExternalEffectObservation,
} from "../src/index.js";

/** Defines the shared not applied fixture for this test module. */
const notApplied: ExternalEffectObservation = {
  evidence: {},
  externalIdentity: {},
  state: "not_applied",
};

test("runs only a pinned configured command in a broker-resolved workspace", async () => {
  /** Defines the root fixture for “runs only a pinned configured command in a broker-resolved workspace”. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-command-"));
  /** Defines the executable fixture for “runs only a pinned configured command in a broker-resolved workspace”. */
  const executable = join(root, "tool.exe");
  await writeFile(executable, "tool");
  /** Defines the observed arguments fixture for “runs only a pinned configured command in a broker-resolved workspace”. */
  let observedArguments: readonly string[] = [];
  /** Defines the runner fixture for “runs only a pinned configured command in a broker-resolved workspace”. */
  const runner: CommandProcessRunner = {
    /** Creates the run test fixture. */
    async run(input) {
      observedArguments = input.arguments;
      return {
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: Buffer.from("ok"),
      };
    },
  };
  /** Defines the effects fixture for “runs only a pinned configured command in a broker-resolved workspace”. */
  const effects = new ConfiguredCommandEffects(
    [
      {
        argumentsPrefix: ["test"],
        executableDigest: sha256("tool"),
        executablePath: executable,
        key: "unit",
        replaySafe: true,
        timeoutMilliseconds: 1000,
      },
    ],
    {
      /** Creates the locate test fixture. */
      async locate() {
        return root;
      },
    },
    runner,
  );
  /** Defines the result fixture for “runs only a pinned configured command in a broker-resolved workspace”. */
  const result = await effects.apply({
    control: control(),
    effectId: "a".repeat(64),
    payload: {
      arguments: ["--run"],
      commandKey: "unit",
      repositoryId: "repo",
      workspaceKey: "work",
    },
  });
  assert.equal(result.state, "applied");
  assert.deepEqual(observedArguments, ["test", "--run"]);
  await assert.rejects(
    effects.apply({
      control: control(),
      effectId: "a".repeat(64),
      payload: {
        arguments: [],
        commandKey: "other",
        repositoryId: "repo",
        workspaceKey: "work",
      },
    }),
    /not configured/,
  );
});

test("binds publication and browser effects to configured logical targets", async () => {
  /** Defines the publication driver fixture for “binds publication and browser effects to configured logical targets”. */
  const publicationDriver: DraftPublicationDriver = {
    /** Simulates effect application. */
    async apply() {
      return notApplied;
    },
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied;
    },
  };
  /** Defines the publication fixture for “binds publication and browser effects to configured logical targets”. */
  const publication = new DraftPublicationEffects(
    [{ id: "github", repositoryIds: ["repo"] }],
    publicationDriver,
  );
  /** Defines the base fixture for “binds publication and browser effects to configured logical targets”. */
  const base = {
    baseBranch: "main",
    body: "body",
    expectedHead: "a".repeat(40),
    headBranch: "feat/x",
    publicationTarget: "github",
    repositoryId: "repo",
    title: "feat: x",
  };
  assert.equal(
    (
      await publication.reconcile({
        control: control(),
        effectId: "b".repeat(64),
        payload: base,
      })
    ).state,
    "not_applied",
  );
  assert.throws(
    () =>
      publication.reconcile({
        control: control(),
        effectId: "b".repeat(64),
        payload: { ...base, repositoryId: "other" },
      }),
    /not authorized/,
  );
  /** Defines the browser driver fixture for “binds publication and browser effects to configured logical targets”. */
  const browserDriver: DisposableBrowserDriver = {
    /** Simulates effect application. */
    async apply() {
      return notApplied;
    },
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied;
    },
  };
  /** Defines the browser fixture for “binds publication and browser effects to configured logical targets”. */
  const browser = new DisposableBrowserEffects(
    [
      {
        allowedOrigins: ["http://127.0.0.1:3000"],
        id: "local",
        isolated: true,
      },
    ],
    browserDriver,
  );
  assert.equal(
    (
      await browser.reconcile({
        control: control(),
        effectId: "c".repeat(64),
        payload: {
          environmentKey: "local",
          repositoryId: "repo",
          scenarioResource: "scenario/ui",
          workspaceKey: "work",
        },
      })
    ).state,
    "not_applied",
  );
});
/** Creates the control test fixture. */
function control() {
  return {
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal,
  };
}
