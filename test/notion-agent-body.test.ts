/** Notion Agent-body loading and semantic validation coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import { NotionApiError } from "../src/provider/notion/notion-transport.js";
import * as fixtures from "./support/notion.js";

test("Notion Agent records derive configuration and Resources from the page body", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
      type: "notion",
    },
    new fixtures.AgentBodyTransport(),
  );

  /** Agent definition resolved for the current run. */
  const agent = await provider.getAgentByKey("code-reviewer");
  assert.ok(agent);
  assert.equal(agent.enabled, true);
  assert.equal(agent.model, "gpt-5.6-sol");
  assert.equal(agent.reasoning, "high");
  assert.deepEqual(agent.resourceIds, [
    fixtures.ids.prompt,
    fixtures.ids.policy,
    fixtures.ids.schema,
  ]);
  assert.deepEqual(agent.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
  assert.deepEqual(Object.keys(agent.properties), ["Name"]);
});

test("Notion records reject incomplete Markdown renderings", async () => {
  /** Provider whose Agent body is explicitly truncated by Notion. */
  const provider = fixtures.lifecycleProvider(
    new fixtures.TruncatedAgentBodyTransport(),
  );

  await assert.rejects(
    provider.getAgent(fixtures.ids.agent),
    /incomplete page Markdown/u,
  );
});

test("Notion Agent record lookup isolates unrelated malformed bodies", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
      type: "notion",
    },
    new fixtures.AgentBodyTransport(),
  );

  assert.equal(
    (await provider.getAgent(fixtures.ids.agent))?.key,
    "code-reviewer",
  );
  await assert.rejects(provider.getAgent(fixtures.ids.badAgent), TypeError);
  assert.equal(
    await provider.getAgent("88888888888888888888888888888888"),
    null,
  );
});

test("Notion page lookup treats only typed HTTP 404 as absence", async () => {
  /** Typed provider failure representing an absent page. */
  const missing = new NotionApiError("gone", 404, "object_not_found", null);
  /** Provider whose page lookup receives the typed absence. */
  const provider = fixtures.lifecycleProvider(
    new fixtures.FailingTransport(missing),
  );

  assert.equal(await provider.getTask(fixtures.ids.task), null);
});

test("Notion page lookup propagates every non-404 failure", async () => {
  /** Failures whose text must not be interpreted as page absence. */
  const failures = [
    new Error("not found"),
    new NotionApiError("not found", 500, "internal_error", null),
  ];

  for (const failure of failures) {
    /** Provider configured to throw the current failure unchanged. */
    const provider = fixtures.lifecycleProvider(
      new fixtures.FailingTransport(failure),
    );
    await assert.rejects(
      provider.getTask(fixtures.ids.task),
      (error) => error === failure,
    );
  }
});

test("Notion Agent loading retries a body and metadata torn read", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
      type: "notion",
    },
    new fixtures.TornAgentBodyTransport(),
  );

  /** Agent definition resolved for the current run. */
  const agent = await provider.getAgentByKey("code-reviewer");
  assert.match(agent?.version ?? "", /^[0-9a-f]{64}$/u);
  assert.deepEqual(agent?.restartCompatibleVersions, [
    "2026-08-17T13:00:00.000Z",
  ]);
});

test("Notion Agent versions bind same-timestamp command policy changes", async () => {
  /** Transport boundary exercised by "Notion Agent versions bind same-timestamp command policy changes". */
  const transport = new fixtures.SameTimestampAgentBodyTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
      type: "notion",
    },
    transport,
  );

  /** Restricted case exercised by "Notion Agent versions bind same-timestamp command policy changes". */
  const restricted = await provider.getAgentByKey("code-reviewer");
  transport.permissive = true;
  /** Permissive case exercised by "Notion Agent versions bind same-timestamp command policy changes". */
  const permissive = await provider.getAgentByKey("code-reviewer");

  assert.notEqual(restricted?.version, permissive?.version);
  assert.deepEqual(restricted?.commands, { inclusion: ["git"] });
  assert.deepEqual(permissive?.commands, { exclusion: [] });
});

test("Notion workspace validation reports malformed Agent bodies", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
      type: "notion",
    },
    new fixtures.AgentBodyTransport(),
  );

  /** Workspace report expected to contain the malformed Agent definition. */
  const report = await provider.validateWorkspace();
  assert.equal(report.valid, false);
  assert.ok(
    report.issues.some(
      (entry) =>
        entry.code === "agent_definition" &&
        entry.path === `Agents.${fixtures.ids.badAgent}`,
    ),
  );
});
