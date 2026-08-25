/** Notion Task body and managed-page boundary coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import * as fixtures from "./support/notion.js";

test("Notion Task body updates require and replace exact Markdown", async () => {
  /** Transport boundary exercised by "Notion Task body updates require and replace exact Markdown". */
  const transport = new fixtures.TaskBodyTransport();
  /** Updated state observed by "Notion Task body updates require and replace exact Markdown". */
  const updated = await fixtures
    .lifecycleProvider(transport)
    .updateTaskBody(
      fixtures.ids.task,
      "## Context\n\nOriginal.\n",
      "## Context\n\nOriginal.\n\n## Planning\n\nPlan.\n",
    );
  assert.match(updated.body, /## Planning\n\nPlan\./u);
  assert.deepEqual(transport.patch, {
    type: "update_content",
    update_content: {
      content_updates: [
        {
          new_str: "## Context\n\nOriginal.\n\n## Planning\n\nPlan.\n",
          old_str: "## Context\n\nOriginal.\n",
        },
      ],
    },
  });
});

test("Notion Tasks may have an empty Markdown body", async () => {
  /** Provider whose otherwise valid Task has no page content. */
  const provider = fixtures.lifecycleProvider(
    new fixtures.EmptyTaskBodyTransport(),
  );

  assert.equal((await provider.getTask(fixtures.ids.task))?.body, "");
});

test("Notion Tasks reject truncated inline relations", async () => {
  /** Provider whose Dependencies relation exceeds Notion's inline limit. */
  const provider = fixtures.lifecycleProvider(
    new fixtures.TruncatedTaskRelationTransport(),
  );

  await assert.rejects(
    provider.getTask(fixtures.ids.task),
    /relation exceeds the inline reference limit/u,
  );
});

test("Notion Task operations reject pages outside the configured Tasks table", async () => {
  /** Transport serving a Task-shaped page from a foreign data source. */
  const transport = new fixtures.TaskBodyTransport(fixtures.ids.resources);
  /** Provider expected to reject every direct operation on the foreign page. */
  const provider = fixtures.lifecycleProvider(transport);
  await assert.rejects(
    provider.getTask(fixtures.ids.task),
    /outside the configured tasks table/u,
  );
  await assert.rejects(
    provider.setTaskStatus(
      fixtures.ids.task,
      "Planned",
      "version",
      "In review",
    ),
    /outside the configured tasks table/u,
  );
  await assert.rejects(
    provider.updateTaskBody(fixtures.ids.task, "original", "changed"),
    /outside the configured tasks table/u,
  );
  assert.equal(transport.patch, null);
});
