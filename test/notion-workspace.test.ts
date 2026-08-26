/** Notion workspace validation and planning coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import { notionTable } from "../src/provider/notion/notion-schema.js";
import { propertyContractMismatch } from "../src/provider/notion/provider/values.js";
import * as fixtures from "./support/notion.js";

test("forward-only relations accept an unused reciprocal property", () => {
  /** Forward Dependencies descriptor whose reverse relation is not manager-owned. */
  const dependencies = notionTable("tasks").properties.find(
    (property) => property.name === "Dependencies",
  );
  assert.ok(dependencies !== undefined);
  assert.equal(
    propertyContractMismatch(
      dependencies,
      {
        relation: {
          data_source_id: fixtures.ids.tasks,
          dual_property: { synced_property_name: "Is Blocking" },
        },
        type: "relation",
      },
      {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
    ),
    null,
  );
});

test("workspace planning rejects property types found invalid by validation", async () => {
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
    },
    new fixtures.AgentBodyTransport({
      name: "Status",
      table: "tasks",
      type: "rich_text",
    }),
  );

  /** Workspace report establishing the same property mismatch as planning. */
  const report = await provider.validateWorkspace();
  assert.ok(
    report.issues.some(
      (entry) =>
        entry.code === "property_type" && entry.path === "Tasks.Status",
    ),
  );
  await assert.rejects(
    provider.planWorkspace("management-v2"),
    /Cannot plan incompatible property Tasks\.Status/u,
  );
});

test("workspace validation rejects incomplete relation and select contracts", async () => {
  /** Canonical environment shared by schema-contract fixtures. */
  const environment = {
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
  } as const;
  /** Validation report for a relation with the wrong target contract. */
  const relationReport = await new NotionProvider(
    environment,
    new fixtures.AgentBodyTransport({
      name: "Dependencies",
      table: "tasks",
      type: "relation",
    }),
  ).validateWorkspace();
  assert.ok(
    relationReport.issues.some((entry) => entry.path === "Tasks.Dependencies"),
  );
  /** Validation report for a select with incomplete canonical options. */
  const selectReport = await new NotionProvider(
    environment,
    new fixtures.AgentBodyTransport({
      name: "State",
      table: "resources",
      type: "select",
    }),
  ).validateWorkspace();
  assert.ok(
    selectReport.issues.some((entry) => entry.path === "Resources.State"),
  );
  /** Validation report for a missing required Active Agent property. */
  const requiredReport = await new NotionProvider(
    environment,
    new fixtures.AgentBodyTransport({
      name: "Finished At",
      table: "activeAgents",
      type: null,
    }),
  ).validateWorkspace();
  assert.ok(
    requiredReport.issues.some(
      (entry) => entry.path === "Active Agents.Finished At",
    ),
  );
});

test("workspace plans are bound to the configured Notion target", async () => {
  /** Shared managed-table mapping served by the deterministic transport. */
  const tables = {
    activeAgents: fixtures.ids.activeAgents,
    agents: fixtures.ids.agents,
    errors: fixtures.ids.errors,
    resources: fixtures.ids.resources,
    tasks: fixtures.ids.tasks,
  };
  /** Plan authorized for the first bootstrap parent. */
  const first = new NotionProvider(
    {
      bootstrapParent: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      connection: {},
      tables,
    },
    new fixtures.AgentBodyTransport(),
  );
  /** Provider with an otherwise identical schema but a different target parent. */
  const second = new NotionProvider(
    {
      bootstrapParent: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      connection: {},
      tables,
    },
    new fixtures.AgentBodyTransport(),
  );

  /** Plan bound to the first provider target. */
  const plan = await first.planWorkspace("management-v2");
  /** Plan independently bound to the second provider target. */
  const otherPlan = await second.planWorkspace("management-v2");
  assert.notEqual(plan.digest, otherPlan.digest);
  await assert.rejects(
    second.applyWorkspacePlan(plan),
    /Workspace plan target does not match the provider/u,
  );
});

test("workspace planning reuses a uniquely named bootstrap database", async () => {
  /** Provider configured before its Tasks data-source ID was persisted. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: null,
        agents: null,
        errors: null,
        resources: null,
        tasks: null,
      },
    },
    new fixtures.ExistingTableDiscoveryTransport(),
  );

  /** Plan expected to adopt rather than recreate the discovered Tasks table. */
  const plan = await provider.planWorkspace("management-v2");

  assert.equal(
    typeof plan.target.tables === "object" &&
      plan.target.tables !== null &&
      !Array.isArray(plan.target.tables)
      ? plan.target.tables.tasks
      : null,
    fixtures.ids.tasks,
  );
  assert.equal(
    plan.steps.some(
      (step) => step.kind === "create_table" && step.payload.table === "tasks",
    ),
    false,
  );
});
