/** Scoped Task-description configuration and Markdown update coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentTaskDescriptionConfig,
  taskDescriptionHasSection,
  upsertTaskDescriptionSection,
} from "../src/domain/task-description.js";

test("Task-description config binds writable sections to declared outcomes", () => {
  assert.deepEqual(
    parseAgentTaskDescriptionConfig(
      {
        requiredSectionsByOutcome: {
          needs_human: ["Planning"],
          succeeded: ["Planning"],
        },
        writableSections: ["Planning"],
      },
      { needs_human: "Human", succeeded: "Coding" },
    ),
    {
      requiredSectionsByOutcome: {
        needs_human: ["Planning"],
        succeeded: ["Planning"],
      },
      writableSections: ["Planning"],
    },
  );
  assert.throws(
    () =>
      parseAgentTaskDescriptionConfig(
        {
          requiredSectionsByOutcome: { unknown: ["Planning"] },
          writableSections: ["Planning"],
        },
        { succeeded: "Coding" },
      ),
    /unknown outcome/u,
  );
  assert.throws(
    () =>
      parseAgentTaskDescriptionConfig(
        {
          requiredSectionsByOutcome: { succeeded: ["Review"] },
          writableSections: ["Planning"],
        },
        { succeeded: "Coding" },
      ),
    /not writable/u,
  );
});

test("Task sections append and update in place without changing neighbours", () => {
  /** Original Markdown before the section upsert. */
  const initial = "## Context\n\nOriginal request.\n\n## Notes\n\nKeep me.\n";
  /** Markdown after appending the Planning section. */
  const appended = upsertTaskDescriptionSection(
    initial,
    "Planning",
    "### Scope\n\nFirst plan.",
  );
  assert.equal(
    appended,
    `${initial}\n## Planning\n\n### Scope\n\nFirst plan.\n`,
  );
  assert.equal(taskDescriptionHasSection(appended, "Planning"), true);
  /** Markdown after updating the existing Planning section. */
  const updated = upsertTaskDescriptionSection(
    appended,
    "Planning",
    "### Scope\n\nRevised plan.",
  );
  assert.equal(updated.match(/^## Planning$/gmu)?.length, 1);
  assert.match(updated, /## Notes\n\nKeep me\./u);
  assert.doesNotMatch(updated, /First plan/u);
  assert.match(updated, /Revised plan/u);
});

test("Task section boundaries ignore headings inside fenced code", () => {
  /** Markdown supplied to "Task section boundaries ignore headings inside fenced code". */
  const markdown =
    "## Context\n\n```\n## Planning\n```\n\n## Planning\n\nReal plan.\n";
  assert.equal(taskDescriptionHasSection(markdown, "Planning"), true);
  assert.match(
    upsertTaskDescriptionSection(markdown, "Planning", "Updated."),
    /```\n## Planning\n```/u,
  );
});

test("Task section updates reject escape headings, blanks, and duplicates", () => {
  assert.equal(
    taskDescriptionHasSection("## Context\n\nText.\n", "Planning"),
    false,
  );
  assert.throws(
    () => upsertTaskDescriptionSection("", "Planning", "## Injected"),
    /level-one or level-two/u,
  );
  assert.throws(
    () => upsertTaskDescriptionSection("", "Planning", "  "),
    /must not be empty/u,
  );
  assert.throws(
    () =>
      taskDescriptionHasSection(
        "## Planning\n\nOne.\n\n## Planning\n\nTwo.\n",
        "Planning",
      ),
    /duplicate section/u,
  );
});
