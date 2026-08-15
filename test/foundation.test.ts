import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertAuthorizedPlan,
  canonicalize,
  compareWorkspaceSchema,
  finalizeMigrationPlan,
  parseEnvironmentConfig,
  ProviderRegistry,
} from "../src/index.js";

test("canonicalize sorts object keys recursively", () => {
  assert.equal(canonicalize({ z: 1, a: { y: true, b: null } }), '{"a":{"b":null,"y":true},"z":1}');
});

test("canonicalize normalizes strings and rejects normalized key collisions", () => {
  assert.equal(canonicalize("e\u0301"), JSON.stringify("é"));
  assert.throws(
    () => canonicalize({ "e\u0301": true, "é": false }),
    /collide after NFC normalization/,
  );
});

test("environment configuration permits missing tables only as null values", () => {
  const config = parseEnvironmentConfig({
    environmentId: "demo",
    provider: {
      bootstrapParent: "provider:parent",
      connection: {},
      tables: { errors: null, resources: null, subAgents: null, tasks: null },
      type: "memory",
    },
    schema: "agent-task-manager-environment-v1",
  });
  assert.equal(config.provider.tables.tasks, null);
});

test("environment configuration is closed and reports missing required fields", () => {
  assert.throws(
    () =>
      parseEnvironmentConfig({
        environmentId: "demo",
        provider: {
          bootstrapParent: null,
          connection: {},
          tables: { errors: null, resources: null, subAgents: null, tasks: null },
          type: "memory",
        },
        schema: "agent-task-manager-environment-v1",
        workflowStatus: "In Coding",
      }),
    /root\.workflowStatus is not allowed/,
  );
  assert.throws(
    () =>
      parseEnvironmentConfig({
        provider: {
          bootstrapParent: null,
          connection: {},
          tables: { errors: null, resources: null, subAgents: null, tasks: null },
          type: "memory",
        },
        schema: "agent-task-manager-environment-v1",
      }),
    /environmentId must be a non-empty string/,
  );
});

test("migration authorization rejects a different digest", () => {
  const plan = finalizeMigrationPlan({
    environmentId: "demo",
    mode: "bootstrap",
    observedSchemaDigest: "observed",
    parentIdentity: "parent",
    providerIdentity: "memory",
    steps: [],
    targetSchemaDigest: "target",
    targetSchemaVersion: "v1",
  });
  assert.throws(() => assertAuthorizedPlan(plan, "wrong"), /does not match/);
  assert.doesNotThrow(() => assertAuthorizedPlan(plan, plan.digest));
});

test("provider registry rejects duplicate registrations", () => {
  const registry = new ProviderRegistry();
  registry.register("memory", () => ({}) as never);
  assert.throws(() => registry.register("memory", () => ({}) as never), /already registered/);
});

test("schema comparison distinguishes bootstrap and incompatible drift", () => {
  const target = {
    digest: "target",
    providerType: "memory",
    tables: [
      {
        kind: "tasks" as const,
        managedRanges: [],
        properties: [
          {
            logicalName: "title",
            physicalName: "Task",
            required: true,
            targetTable: null,
            type: "title",
            writable: true,
          },
        ],
        title: "Tasks",
      },
    ],
    version: "v1",
  };
  const missing = compareWorkspaceSchema(
    { capturedAt: "2026-01-01T00:00:00.000Z", digest: "empty", providerIdentity: "memory", tables: [] },
    target,
  );
  assert.equal(missing.state, "needs_bootstrap");

  const incompatible = compareWorkspaceSchema(
    {
      capturedAt: "2026-01-01T00:00:00.000Z",
      digest: "observed",
      providerIdentity: "memory",
      tables: [
        {
          id: "tasks",
          kind: "tasks",
          managedRanges: [],
          properties: [
            { name: "Task", providerMetadata: {}, targetTableId: null, type: "text", writable: true },
          ],
          title: "Tasks",
          version: "1",
        },
      ],
    },
    target,
  );
  assert.equal(incompatible.state, "blocked_incompatible");
});
