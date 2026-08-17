/** Verifies that external effects accept only closed, bounded, deterministic payloads. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createChildAgentWaveHandler,
  createGitCommitHandler,
  createGitPushHandler,
  createPullRequestCommentHandler,
  type ExternalEffectObservation,
  type ReconcilableEffectAdapter,
} from "../src/index.js";

/** Provides the canonical not-applied effect observation. */
const observation: ExternalEffectObservation = {
  evidence: {},
  externalIdentity: {},
  state: "not_applied",
};

/** Builds a no-op reconcilable adapter for typed-handler validation. */
function adapter<T>(): ReconcilableEffectAdapter<T> {
  return {
    id: "adapter",
    version: "1",
    /** Simulates effect application. */
    async apply() {
      return observation;
    },
    /** Simulates effect reconciliation. */
    async reconcile() {
      return observation;
    },
  };
}

test("validates immutable Git commit and push preconditions", () => {
  /** Describes the Git commit intent under validation. */
  const commit = createGitCommitHandler(adapter());
  commit.validate({
    expectedHead: "a".repeat(40),
    message: "feat: add broker",
    paths: ["src/file.ts"],
    repositoryId: "repo",
    workspaceKey: "work-1",
  });
  assert.throws(
    () =>
      commit.validate({
        expectedHead: "main",
        message: "bad",
        paths: ["../secret"],
        repositoryId: "repo",
        workspaceKey: "work-1",
      }),
    /immutable revision|repository-relative/,
  );
  /** Describes the Git push intent under validation. */
  const push = createGitPushHandler(adapter());
  push.validate({
    branch: "feat/broker",
    expectedLocalHead: "b".repeat(40),
    expectedRemoteHead: null,
    remote: "origin",
    repositoryId: "repo",
    workspaceKey: "work-1",
  });
  assert.throws(
    () =>
      push.validate({
        branch: "../bad",
        expectedLocalHead: "b".repeat(40),
        expectedRemoteHead: null,
        remote: "origin",
        repositoryId: "repo",
        workspaceKey: "work-1",
      }),
    /branch is invalid/,
  );
});

test("requires a closed acyclic child-agent wave", () => {
  /** Describes the dependency-ordered child-agent wave. */
  const wave = createChildAgentWaveHandler(adapter());
  wave.validate({
    maxConcurrency: 2,
    nodes: [
      {
        contextDigest: "a".repeat(64),
        contextResource: "context/a",
        contextVersion: "v1",
        definitionId: "reviewer",
        dependsOn: [],
        nodeKey: "a",
      },
      {
        contextDigest: "b".repeat(64),
        contextResource: "context/b",
        contextVersion: "v1",
        definitionId: "reviewer",
        dependsOn: ["a"],
        nodeKey: "b",
      },
    ],
  });
  assert.throws(
    () =>
      wave.validate({
        maxConcurrency: 2,
        nodes: [
          {
            contextDigest: "a".repeat(64),
            contextResource: "context/a",
            contextVersion: "v1",
            definitionId: "reviewer",
            dependsOn: ["b"],
            nodeKey: "a",
          },
          {
            contextDigest: "b".repeat(64),
            contextResource: "context/b",
            contextVersion: "v1",
            definitionId: "reviewer",
            dependsOn: ["a"],
            nodeKey: "b",
          },
        ],
      }),
    /cycle/,
  );
});

test("validates bounded pull-request comments", () => {
  /** Describes the review or test comment published on a draft PR. */
  const comment = createPullRequestCommentHandler(adapter());
  comment.validate({
    body: "Review finding: make the retry boundary explicit.",
    publicationTarget: "github",
    pullRequestNumber: 12,
    repositoryId: "example/project",
  });
  assert.throws(
    () =>
      comment.validate({
        body: "Invalid PR number",
        publicationTarget: "github",
        pullRequestNumber: 0,
        repositoryId: "example/project",
      }),
    /pullRequestNumber is invalid/u,
  );
});
