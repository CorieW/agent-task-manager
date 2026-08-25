/** Notion Error Markdown and resolution coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import * as fixtures from "./support/notion.js";

test("Notion Error resolution stays open when its Markdown write fails", async () => {
  /** Transport that rejects the first resolution mutation. */
  const transport = new fixtures.FailingErrorResolutionTransport();
  /** Provider whose resolution body write fails before any status update. */
  const provider = fixtures.lifecycleProvider(transport);

  await assert.rejects(
    provider.resolveError("retry-chain", "Fixed configuration"),
    /Markdown update failed/u,
  );
  assert.equal(transport.statusPatches, 0);
});

test("Notion Error Markdown preserves embedded level-two headings", async () => {
  /** Transport that serves the exact Markdown created by reportError. */
  const transport = new fixtures.ErrorRoundTripTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = fixtures.lifecycleProvider(transport);
  /** Arbitrary Error text containing headings that previously escaped sections. */
  const description = "First symptom\n\n## Diagnostic\n\nDetailed evidence";
  /** Arbitrary resolution containing another level-two heading. */
  const resolution = "Applied fix\n\n## Verification\n\nAll checks pass";

  /** Round-tripped Error used to compare protected Markdown section content. */
  const reported = await provider.reportError({
    activeAgentId: null,
    agentId: null,
    description,
    errorKey: "heading-round-trip",
    resolution,
    severity: "medium",
    source: "ai",
    taskId: null,
    title: "T".repeat(2_100),
  });

  assert.equal(reported.description, description);
  assert.equal(reported.resolution, resolution);
  assert.equal(transport.createdSource, "AI");
  assert.deepEqual(transport.createdTitleFragmentLengths, [2_000, 100]);
});
