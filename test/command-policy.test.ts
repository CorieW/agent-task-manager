/** Command-policy parsing and command-system-prompt coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import { commandProxySystemPrompt } from "../src/core/agent-system-prompt.js";
import {
  commandIsAllowed,
  normalizeCommandName,
  parseAgentCommandPolicy,
} from "../src/domain/commands.js";
import { EMPTY_AGENT_TASK_DESCRIPTION } from "../src/domain/task-description.js";
import { parseAgentDefinition } from "../src/domain/records.js";

test("Agent command policies require exactly one normalized list", () => {
  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = {
    allowedStatuses: ["In review"],
    allowedTaskTypes: ["Feature"],
    enabled: true,
    id: "coder",
    inputResourceSelectors: ["agent-policy/review"],
    model: "gpt",
    promptResources: ["prompt/coder"],
    reasoning: "high",
    schema: "agent-definition-v1",
    transitions: { succeeded: "In review" },
  };
  /** Markdown supplied to "Agent command policies require exactly one normalized list". */
  const markdown = (commands: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify({ ...definition, commands })}\n\`\`\`\n`;
  assert.throws(
    () => parseAgentDefinition(markdown({ inclusion: ["git"], exclusion: [] })),
    /commands must define exactly one/u,
  );
  assert.deepEqual(
    parseAgentCommandPolicy({ inclusion: ["git.com"] }, "win32"),
    { inclusion: ["git"] },
  );
  assert.deepEqual(
    parseAgentCommandPolicy({ inclusion: ["git.exe.com..."] }, "win32"),
    { inclusion: ["git"] },
  );
  assert.throws(
    () =>
      parseAgentCommandPolicy(
        {
          inclusion: ["git", "git.com", "git.exe.com..."],
        },
        "win32",
      ),
    /contains duplicates/u,
  );
});

test("command identities follow host-platform executable semantics", () => {
  assert.equal(normalizeCommandName("Tool.EXE...", "win32"), "tool");
  assert.deepEqual(
    parseAgentCommandPolicy(
      { inclusion: ["Tool", "tool.exe", "tool."] },
      "linux",
    ),
    { inclusion: ["Tool", "tool.exe", "tool."] },
  );
  /** Upper case exercised by "command identities follow host-platform executable semantics". */
  const upper = parseAgentCommandPolicy({ inclusion: ["Safe"] }, "linux");
  assert.equal(commandIsAllowed(upper, "Safe", "linux"), true);
  assert.equal(commandIsAllowed(upper, "safe", "linux"), false);
  /** Suffixed case exercised by "command identities follow host-platform executable semantics". */
  const suffixed = parseAgentCommandPolicy(
    { inclusion: ["safe.exe"] },
    "linux",
  );
  assert.equal(commandIsAllowed(suffixed, "safe.exe", "linux"), true);
  assert.equal(commandIsAllowed(suffixed, "safe", "linux"), false);
});

test("command prompt leaves run identity to the trusted harness", () => {
  /** Prompt supplied to "command prompt leaves run identity to the trusted harness". */
  const prompt = commandProxySystemPrompt(EMPTY_AGENT_TASK_DESCRIPTION);
  assert.match(prompt, /command proxy -- <command>/u);
  assert.doesNotMatch(prompt, /--run-id|--harness-id/u);
});

test("command prompt delegates configured Task sections to the harness", () => {
  /** Prompt supplied to "command prompt delegates configured Task sections to the harness". */
  const prompt = commandProxySystemPrompt({
    requiredSectionsByOutcome: { succeeded: ["Planning"] },
    writableSections: ["Planning"],
  });
  assert.match(prompt, /only these Task-description sections: `Planning`/u);
  assert.match(prompt, /active-agent update-task-section/u);
  assert.match(prompt, /do not invoke it through the operating-system/u);
});
