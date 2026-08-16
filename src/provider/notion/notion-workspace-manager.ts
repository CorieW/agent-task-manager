/** Plans, applies, and reconciles additive Notion workspace bootstrap operations. */
import { canonicalize } from "../../core/canonical-json.js";
import { finalizeMigrationPlan } from "../../core/migration-plan.js";
import { compareWorkspaceSchema } from "../../core/schema-diff.js";
import { sha256 } from "../../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import {
  TABLE_KINDS,
  type ProviderEnvironment,
  type ReconciliationResult,
  type TableKind,
  type WriteReceipt,
} from "../../domain/provider.js";
import type {
  PropertyDescriptor,
  WorkspaceMigrationPlan,
  WorkspaceMigrationStep,
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../../domain/schema.js";
import { NotionPageStore } from "./notion-page-store.js";
import { parseWriteReceipt } from "../write-receipt-codec.js";
import {
  normalizeNotionIdentifier,
  notionSchemaDigest,
  NotionWorkspaceReader,
} from "./notion-workspace-reader.js";
import {
  collectNotionPages,
  type NotionTransport,
} from "./notion-transport.js";

/** Defines the module-level `TABLE_ORDER` value. */
const TABLE_ORDER: readonly TableKind[] = [
  "resources",
  "errors",
  "tasks",
  "subAgents",
];

/** Defines workspace step record. */
interface WorkspaceStepRecord {
  /** Contains receipt for workspace step record. */
  readonly receipt: WriteReceipt | null;
  /** Identifies the workspace step record wire schema. */
  readonly schema: "agent-task-manager-workspace-step-v1";
  /** Records the state for workspace step record. */
  readonly state: "applied" | "pending";
  /** Contains step for workspace step record. */
  readonly step: WorkspaceMigrationStep;
  /** Binds workspace step record to canonical step content. */
  readonly stepDigest: string;
}

/** Defines bootstrap session record. */
export interface BootstrapSessionRecord {
  /** Lists completed step IDs for bootstrap session record. */
  readonly completedStepIds: readonly string[];
  /** Identifies next step. */
  readonly nextStepId: string | null;
  /** Contains plan for bootstrap session record. */
  readonly plan: WorkspaceMigrationPlan;
  /** Identifies the bootstrap session record wire schema. */
  readonly schema: "agent-task-manager-bootstrap-session-v1";
  /** Records the state for bootstrap session record. */
  readonly state: "applying" | "complete";
}

/** Implements Notion workspace manager. */
export class NotionWorkspaceManager {
  /** Contains resolved for Notion workspace manager. */
  readonly #resolved = new Map<TableKind, string>();

  /** Initializes Notion workspace manager. */
  public constructor(
    /** Identifies environment. */ private readonly environmentId: string,
    /** Contains environment for Notion workspace manager. */ private readonly environment: ProviderEnvironment,
    /** Contains target for Notion workspace manager. */ private readonly target: WorkspaceSchemaDescriptor,
    /** Contains transport for Notion workspace manager. */ private readonly transport: NotionTransport,
    /** Contains now for Notion workspace manager. */ private readonly now: () => Date = () =>
      new Date(),
  ) {}

  /** Inspects workspace schema without mutation. */
  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    await this.resolveTables();
    /** Holds the `reader` intermediate used by `inspectWorkspaceSchema`. */
    const reader = new NotionWorkspaceReader(
      this.resolvedEnvironment(),
      this.target,
      this.transport,
      this.now,
    );
    return reader.inspectWorkspaceSchema();
  }

  /** Plans ordered additive workspace changes without applying them. */
  public async planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan> {
    if (request.environmentId !== this.environmentId)
      throw new Error("Workspace request environment does not match manager");
    if (request.target.digest !== this.target.digest)
      throw new Error(
        "Workspace request target does not match configured target",
      );
    /** Holds the `report` intermediate used by `planWorkspaceChanges`. */
    const report = compareWorkspaceSchema(request.observed, request.target);
    if (report.state === "blocked_incompatible")
      throw new Error("Cannot plan over an incompatible Notion workspace");
    /** Holds the `drafts` intermediate used by `planWorkspaceChanges`. */
    const drafts: Array<
      Pick<WorkspaceMigrationStep, "id" | "kind" | "payload">
    > = [];
    for (const kind of TABLE_ORDER) {
      /** Defines `expected` for comparison in `planWorkspaceChanges`. */
      const expected = tableDescriptor(this.target, kind);
      /** Defines `observed` for comparison in `planWorkspaceChanges`. */
      const observed = request.observed.tables.find(
        (table) => table.kind === kind,
      );
      if (observed === undefined) {
        drafts.push({
          id: `notion:${this.target.version}:create:${kind}`,
          kind: "create_table",
          payload: { kind },
        });
      } else {
        for (const property of expected.properties.filter(
          (item) => item.targetTable === null,
        )) {
          if (
            !observed.properties.some(
              (item) => item.name === property.physicalName,
            )
          ) {
            drafts.push({
              id: `notion:${this.target.version}:property:${kind}:${property.physicalName}`,
              kind: "add_property",
              payload: { kind, physicalName: property.physicalName },
            });
          }
        }
      }
    }
    for (const kind of TABLE_ORDER) {
      /** Defines `expected` for comparison in `planWorkspaceChanges`. */
      const expected = tableDescriptor(this.target, kind);
      /** Defines `observed` for comparison in `planWorkspaceChanges`. */
      const observed = request.observed.tables.find(
        (table) => table.kind === kind,
      );
      for (const property of expected.properties.filter(
        (item) => item.targetTable !== null,
      )) {
        if (
          observed === undefined ||
          !observed.properties.some(
            (item) => item.name === property.physicalName,
          )
        ) {
          drafts.push({
            id: `notion:${this.target.version}:relation:${kind}:${property.physicalName}`,
            kind: "add_relation",
            payload: { kind, physicalName: property.physicalName },
          });
        }
      }
    }
    if (drafts.length > 0) {
      drafts.push({
        id: `notion:${this.target.version}:schema-state`,
        kind: "record_schema_state",
        payload: {
          kind: "resources",
          targetDigest: this.target.digest,
          targetVersion: this.target.version,
        },
      });
    }

    /** Holds the `simulated` intermediate used by `planWorkspaceChanges`. */
    let simulated = request.observed;
    /** Holds the `steps` intermediate used by `planWorkspaceChanges`. */
    const steps: WorkspaceMigrationStep[] = [];
    for (const [index, draft] of drafts.entries()) {
      /** Holds the `next` intermediate used by `planWorkspaceChanges`. */
      const next = simulateWorkspaceStep(simulated, draft, this.target);
      steps.push({
        dependsOn: index === 0 ? [] : [requiredDraft(drafts[index - 1]).id],
        expectedPostSchemaDigest: next.digest,
        expectedPreSchemaDigest: simulated.digest,
        id: draft.id,
        kind: draft.kind,
        payload: draft.payload,
        reversibility: "additive",
      });
      simulated = next;
    }
    return finalizeMigrationPlan({
      environmentId: request.environmentId,
      mode: request.mode,
      observedSchemaDigest: request.observed.digest,
      parentIdentity: this.environment.bootstrapParent,
      providerIdentity: request.observed.providerIdentity,
      steps,
      targetSchemaDigest: request.target.digest,
      targetSchemaVersion: request.target.version,
    });
  }

  /** Applies workspace step. */
  public async applyWorkspaceStep(
    step: WorkspaceMigrationStep,
  ): Promise<WriteReceipt> {
    await this.resolveTables();
    if (this.#resolved.has("resources")) await this.ensureBootstrapRoot();
    /** Holds the `prior` intermediate used by `applyWorkspaceStep`. */
    const prior = await this.readStepRecord(step.id);
    if (prior !== null) {
      if (prior.stepDigest !== stepDigest(step))
        throw new Error(
          `Workspace step ${step.id} changed after it was journaled`,
        );
      if (prior.state === "applied" && prior.receipt !== null)
        return prior.receipt;
      /** Holds the `recovered` intermediate used by `applyWorkspaceStep`. */
      const recovered = await this.reconcileEffect(prior.step);
      if (recovered.state === "applied")
        return this.finalizeRecoveredStep(prior.step);
      if (recovered.state !== "not_applied")
        throw new Error(`Workspace step ${step.id} remains indeterminate`);
    } else if (
      step.id === `notion:${this.target.version}:create:resources` &&
      this.#resolved.has("resources")
    ) {
      /** Holds the `recovered` intermediate used by `applyWorkspaceStep`. */
      const recovered = await this.reconcileEffect(step);
      if (recovered.state === "applied")
        return this.finalizeRecoveredStep(step);
    }
    for (const dependency of step.dependsOn) {
      /** Holds the `record` intermediate used by `applyWorkspaceStep`. */
      const record = await this.readStepRecord(dependency);
      if (record?.state !== "applied")
        throw new Error(
          `Workspace step dependency is incomplete: ${dependency}`,
        );
    }
    /** Holds the `current` intermediate used by `applyWorkspaceStep`. */
    const current = await this.inspectWorkspaceSchema();
    if (current.digest !== step.expectedPreSchemaDigest)
      throw new Error(`Workspace precondition changed: ${step.id}`);
    if (this.#resolved.has("resources"))
      await this.writeStepRecord({
        receipt: null,
        schema: "agent-task-manager-workspace-step-v1",
        state: "pending",
        step,
        stepDigest: stepDigest(step),
      });

    if (step.kind === "create_table") await this.createTable(tableKind(step));
    else if (step.kind === "add_property" || step.kind === "add_relation")
      await this.addProperty(step);
    else if (step.kind === "record_schema_state")
      await this.recordSchemaState();
    else throw new Error(`Unsupported Notion workspace step: ${step.kind}`);

    /** Holds the `reconciliation` intermediate used by `applyWorkspaceStep`. */
    const reconciliation = await this.reconcileEffect(step);
    if (reconciliation.state !== "applied")
      throw new Error(`Workspace step post-verification failed: ${step.id}`);
    /** Holds the `verifiedSnapshot` intermediate used by `applyWorkspaceStep`. */
    const verifiedSnapshot = await this.inspectWorkspaceSchema();
    if (verifiedSnapshot.digest !== step.expectedPostSchemaDigest)
      throw new Error(`Workspace postcondition changed: ${step.id}`);
    /** Holds the `table` intermediate used by `applyWorkspaceStep`. */
    const table = tableKind(step);
    /** Holds the `tableId` intermediate used by `applyWorkspaceStep`. */
    const tableId = requiredResolved(this.#resolved, table);
    /** Defines `observed` for comparison in `applyWorkspaceStep`. */
    const observed = verifiedSnapshot.tables.find(
      (candidate) => candidate.kind === table,
    );
    if (observed === undefined)
      throw new Error(`Workspace step did not produce ${table}`);
    /** Captures `receipt` returned by `applyWorkspaceStep`. */
    const receipt: WriteReceipt = {
      idempotencyKey: step.id,
      observedVersion: observed.version,
      providerRecord: { id: tableId, table },
      writtenAt: this.now().toISOString(),
    };
    await this.writeStepRecord({
      receipt,
      schema: "agent-task-manager-workspace-step-v1",
      state: "applied",
      step,
      stepDigest: stepDigest(step),
    });
    return receipt;
  }

  /** Reconciles workspace step against provider state. */
  public async reconcileWorkspaceStep(
    stepId: string,
    supplied?: WorkspaceMigrationStep,
  ): Promise<ReconciliationResult> {
    await this.resolveTables();
    /** Holds the `stored` intermediate used by `reconcileWorkspaceStep`. */
    const stored = await this.readStepRecord(stepId);
    if (stored?.state === "applied" && stored.receipt !== null) {
      return {
        evidence: {
          receipt: toJsonValue(stored.receipt),
          stepDigest: stored.stepDigest,
        },
        state: "applied",
      };
    }
    /** Holds the `effective` intermediate used by `reconcileWorkspaceStep`. */
    const effective =
      supplied ?? stored?.step ?? this.knownUnjournaledStep(stepId);
    if (effective === null) return { evidence: {}, state: "not_applied" };
    /** Captures `result` returned by `reconcileWorkspaceStep`. */
    const result = await this.reconcileEffect(effective);
    if (stored?.state === "pending" && result.state === "applied") {
      /** Captures `receipt` returned by `reconcileWorkspaceStep`. */
      const receipt = await this.finalizeRecoveredStep(effective);
      return {
        evidence: {
          receipt: toJsonValue(receipt),
          stepDigest: stepDigest(effective),
        },
        state: "applied",
      };
    }
    return result;
  }

  /** Reconciles effect against provider state. */
  private async reconcileEffect(
    supplied: WorkspaceMigrationStep,
  ): Promise<ReconciliationResult> {
    await this.resolveTables();
    /** Holds the `kind` intermediate used by `reconcileEffect`. */
    const kind = tableKind(supplied);
    if (supplied.kind === "create_table") {
      return this.#resolved.has(kind)
        ? {
            evidence: { dataSourceId: requiredResolved(this.#resolved, kind) },
            state: "applied",
          }
        : { evidence: {}, state: "not_applied" };
    }
    if (supplied.kind === "add_property" || supplied.kind === "add_relation") {
      /** Holds the `physicalName` intermediate used by `reconcileEffect`. */
      const physicalName = requiredString(
        supplied.payload.physicalName,
        "Workspace property name",
      );
      /** Holds the `table` intermediate used by `reconcileEffect`. */
      const table = (await this.inspectWorkspaceSchema()).tables.find(
        (candidate) => candidate.kind === kind,
      );
      /** Defines `expected` for comparison in `reconcileEffect`. */
      const expected = tableDescriptor(this.target, kind).properties.find(
        (item) => item.physicalName === physicalName,
      );
      /** Defines `observed` for comparison in `reconcileEffect`. */
      const observed = table?.properties.find(
        (item) => item.name === physicalName,
      );
      /** Holds the `applied` intermediate used by `reconcileEffect`. */
      const applied =
        expected !== undefined &&
        observed !== undefined &&
        observed.type === expected.type &&
        observed.writable === expected.writable;
      return applied
        ? { evidence: { property: physicalName }, state: "applied" }
        : { evidence: {}, state: "not_applied" };
    }
    if (supplied.kind === "record_schema_state") {
      /** Holds the `state` intermediate used by `reconcileEffect`. */
      const state = await this.readSchemaState();
      return state?.targetDigest === this.target.digest &&
        state.targetVersion === this.target.version
        ? { evidence: state, state: "applied" }
        : { evidence: {}, state: "not_applied" };
    }
    return { evidence: {}, state: "failed" };
  }

  /** Finalizes recovered step. */
  private async finalizeRecoveredStep(
    step: WorkspaceMigrationStep,
  ): Promise<WriteReceipt> {
    /** Holds the `snapshot` intermediate used by `finalizeRecoveredStep`. */
    const snapshot = await this.inspectWorkspaceSchema();
    if (snapshot.digest !== step.expectedPostSchemaDigest)
      throw new Error(
        `Recovered workspace postcondition does not match: ${step.id}`,
      );
    /** Holds the `table` intermediate used by `finalizeRecoveredStep`. */
    const table = tableKind(step);
    /** Defines `observed` for comparison in `finalizeRecoveredStep`. */
    const observed = snapshot.tables.find(
      (candidate) => candidate.kind === table,
    );
    if (observed === undefined)
      throw new Error(`Recovered workspace step did not produce ${table}`);
    /** Captures `receipt` returned by `finalizeRecoveredStep`. */
    const receipt: WriteReceipt = {
      idempotencyKey: step.id,
      observedVersion: observed.version,
      providerRecord: { id: requiredResolved(this.#resolved, table), table },
      writtenAt: this.now().toISOString(),
    };
    await this.writeStepRecord({
      receipt,
      schema: "agent-task-manager-workspace-step-v1",
      state: "applied",
      step,
      stepDigest: stepDigest(step),
    });
    return receipt;
  }

  /** Recognizes unjournaled step. */
  private knownUnjournaledStep(stepId: string): WorkspaceMigrationStep | null {
    /** Defines `expectedId` for comparison in `knownUnjournaledStep`. */
    const expectedId = `notion:${this.target.version}:create:resources`;
    if (stepId !== expectedId) return null;
    return {
      dependsOn: [],
      expectedPostSchemaDigest: "unknown-without-authorized-plan",
      expectedPreSchemaDigest: notionSchemaDigest([]),
      id: expectedId,
      kind: "create_table",
      payload: { kind: "resources" },
      reversibility: "additive",
    };
  }

  /** Returns table patch. */
  public configuredTablePatch(): Readonly<Record<TableKind, string>> {
    return Object.fromEntries(
      TABLE_KINDS.map((kind) => [kind, requiredResolved(this.#resolved, kind)]),
    ) as unknown as Readonly<Record<TableKind, string>>;
  }

  /** Resolves table IDs. */
  public async resolveTableIds(): Promise<Partial<Record<TableKind, string>>> {
    await this.resolveTables();
    return Object.fromEntries(this.#resolved) as Partial<
      Record<TableKind, string>
    >;
  }

  /** Records environment patch. */
  public async recordEnvironmentPatch(
    startingFileDigest: string,
    state: "applied" | "pending_human",
  ): Promise<void> {
    await this.resolveTables();
    /** Holds the `tables` intermediate used by `recordEnvironmentPatch`. */
    const tables = this.configuredTablePatch();
    /** Holds the `key` intermediate used by `recordEnvironmentPatch`. */
    const key = `system/environment-patch/${sha256(this.environmentId)}`;
    /** Holds the `body` intermediate used by `recordEnvironmentPatch`. */
    const body = canonicalize(
      toJsonValue({
        environmentId: this.environmentId,
        schema: "agent-task-manager-environment-patch-v1",
        startingFileDigest,
        state,
        tables,
        targetSchemaDigest: this.target.digest,
      }),
    );
    await this.pageStore().createResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `${key}:${state}`,
      key,
      kind: "system/environment-patch",
      state: "active",
      version: "v1",
    });
  }

  /** Reads bootstrap session. */
  public async readBootstrapSession(
    mode: WorkspaceMigrationPlan["mode"],
  ): Promise<BootstrapSessionRecord | null> {
    await this.resolveTables();
    if (!this.#resolved.has("resources")) return null;
    /** Holds the `located` intermediate used by `readBootstrapSession`. */
    const located = await this.pageStore().findUniqueByTitle(
      "resources",
      "Resource",
      this.bootstrapSessionKey(mode),
    );
    if (located === null) return null;
    return parseBootstrapSession(
      toJsonValue(
        JSON.parse(
          await this.pageStore().managedText(located.id, "Resource body"),
        ),
      ),
    );
  }

  /** Records bootstrap session. */
  public async recordBootstrapSession(
    plan: WorkspaceMigrationPlan,
    completedStepIds: readonly string[],
  ): Promise<void> {
    await this.resolveTables();
    /** Tracks unique entries in `knownStepIds` for `recordBootstrapSession`. */
    const knownStepIds = new Set(plan.steps.map((step) => step.id));
    /** Tracks unique entries in `completed` for `recordBootstrapSession`. */
    const completed = [...new Set(completedStepIds)];
    if (completed.some((stepId) => !knownStepIds.has(stepId)))
      throw new Error("Bootstrap session contains an unknown completed step");
    /** Holds the `nextStep` intermediate used by `recordBootstrapSession`. */
    const nextStep = plan.steps.find((step) => !completed.includes(step.id));
    /** Holds the `record` intermediate used by `recordBootstrapSession`. */
    const record: BootstrapSessionRecord = {
      completedStepIds: completed,
      nextStepId: nextStep?.id ?? null,
      plan,
      schema: "agent-task-manager-bootstrap-session-v1",
      state: nextStep === undefined ? "complete" : "applying",
    };
    /** Holds the `body` intermediate used by `recordBootstrapSession`. */
    const body = canonicalize(toJsonValue(record));
    /** Holds the `key` intermediate used by `recordBootstrapSession`. */
    const key = this.bootstrapSessionKey(plan.mode);
    await this.pageStore().createResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `${key}:${sha256(body)}`,
      key,
      kind: "system/bootstrap-session",
      state: "active",
      version: "v1",
    });
  }

  /** Resolves tables. */
  private async resolveTables(): Promise<void> {
    for (const kind of TABLE_ORDER) {
      if (this.#resolved.has(kind)) continue;
      /** Holds the `configured` intermediate used by `resolveTables`. */
      const configured = this.environment.tables[kind];
      if (configured !== null) {
        /** Holds the `reader` intermediate used by `resolveTables`. */
        const reader = new NotionWorkspaceReader(
          this.environment,
          this.target,
          this.transport,
          this.now,
        );
        this.#resolved.set(kind, await reader.resolveDataSourceId(configured));
        continue;
      }
      /** Holds the `discovered` intermediate used by `resolveTables`. */
      const discovered = await this.discoverTable(kind);
      if (discovered !== null) this.#resolved.set(kind, discovered);
    }
  }

  /** Discovers table. */
  private async discoverTable(kind: TableKind): Promise<string | null> {
    if (this.environment.bootstrapParent === null) return null;
    /** Holds the `parentId` intermediate used by `discoverTable`. */
    const parentId = normalizeNotionIdentifier(
      this.environment.bootstrapParent,
    );
    /** Holds the `title` intermediate used by `discoverTable`. */
    const title = tableDescriptor(this.target, kind).title;
    /** Holds the `results` intermediate used by `discoverTable`. */
    const results = await collectNotionPages((cursor) =>
      this.transport.request({
        body: {
          filter: { property: "object", value: "data_source" },
          page_size: 100,
          query: title,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        },
        method: "POST",
        path: "/v1/search",
      }),
    );
    /** Tracks the `candidates` condition in `discoverTable`. */
    const candidates = results.filter(
      (source) =>
        source.object === "data_source" && richText(source.title) === title,
    );
    /** Holds the `matches` intermediate used by `discoverTable`. */
    const matches: JsonObject[] = [];
    for (const source of candidates) {
      /** Holds the `sourceParent` intermediate used by `discoverTable`. */
      const sourceParent = objectValue(
        source.parent,
        `${title} data source parent`,
      );
      /** Holds the `databaseId` intermediate used by `discoverTable`. */
      const databaseId = requiredString(
        sourceParent.database_id,
        `${title} parent database id`,
      );
      /** Holds the `database` intermediate used by `discoverTable`. */
      const database = await this.transport.request({
        method: "GET",
        path: `/v1/databases/${databaseId}`,
      });
      if (parentIdentity(database.parent) === parentId) matches.push(source);
    }
    if (matches.length > 1)
      throw new Error(`Bootstrap parent contains multiple ${title} databases`);
    /** Holds the `source` intermediate used by `discoverTable`. */
    const source = matches[0];
    return source === undefined
      ? null
      : requiredString(source.id, `${title} data source id`);
  }

  /** Creates table. */
  private async createTable(kind: TableKind): Promise<void> {
    if (this.#resolved.has(kind)) return;
    if (this.environment.bootstrapParent === null)
      throw new Error("Notion bootstrap requires provider.bootstrapParent");
    /** Holds the `descriptor` intermediate used by `createTable`. */
    const descriptor = tableDescriptor(this.target, kind);
    /** Holds the `properties` intermediate used by `createTable`. */
    const properties = Object.fromEntries(
      descriptor.properties
        .filter((property) => property.targetTable === null)
        .map((property) => [
          property.physicalName,
          propertySchema(property, kind),
        ]),
    );
    /** Captures `response` returned by `createTable`. */
    const response = await this.transport.request({
      body: {
        initial_data_source: { properties },
        parent: {
          page_id: normalizeNotionIdentifier(this.environment.bootstrapParent),
          type: "page_id",
        },
        title: richTextPayload(descriptor.title),
      },
      method: "POST",
      path: "/v1/databases",
    });
    /** Holds the `sources` intermediate used by `createTable`. */
    const sources = response.data_sources;
    if (!Array.isArray(sources) || sources.length !== 1)
      throw new Error(
        `Created ${descriptor.title} database did not expose one data source`,
      );
    this.#resolved.set(
      kind,
      requiredString(
        objectValue(requiredValue(sources[0]), "Created data source").id,
        "Created data source id",
      ),
    );
    if (kind === "resources") await this.ensureBootstrapRoot();
  }

  /** Adds property. */
  private async addProperty(step: WorkspaceMigrationStep): Promise<void> {
    /** Holds the `kind` intermediate used by `addProperty`. */
    const kind = tableKind(step);
    /** Holds the `name` intermediate used by `addProperty`. */
    const name = requiredString(
      step.payload.physicalName,
      "Workspace property name",
    );
    /** Holds the `descriptor` intermediate used by `addProperty`. */
    const descriptor = tableDescriptor(this.target, kind).properties.find(
      (property) => property.physicalName === name,
    );
    if (descriptor === undefined)
      throw new Error(`Unknown target property ${kind}.${name}`);
    await this.transport.request({
      body: {
        properties: {
          [name]: propertySchema(descriptor, kind, this.#resolved),
        },
      },
      method: "PATCH",
      path: `/v1/data_sources/${requiredResolved(this.#resolved, kind)}`,
    });
  }

  /** Ensures bootstrap root. */
  private async ensureBootstrapRoot(): Promise<void> {
    /** Holds the `resources` intermediate used by `ensureBootstrapRoot`. */
    const resources = requiredResolved(this.#resolved, "resources");
    /** Holds the `pages` intermediate used by `ensureBootstrapRoot`. */
    const pages = this.pageStore();
    /** Holds the `key` intermediate used by `ensureBootstrapRoot`. */
    const key = "system/bootstrap-root-v1";
    /** Holds the `body` intermediate used by `ensureBootstrapRoot`. */
    const body = canonicalize(
      toJsonValue({
        parentIdentity: this.environment.bootstrapParent,
        resourcesDataSourceId: resources,
        schema: "agent-task-manager-bootstrap-root-v1",
      }),
    );
    /** Holds the `existing` intermediate used by `ensureBootstrapRoot`. */
    const existing = await pages.findUniqueByTitle(
      "resources",
      "Resource",
      key,
    );
    if (existing !== null) {
      if ((await pages.managedText(existing.id, "Resource body")) !== body)
        throw new Error(
          "bootstrap-root-v1 conflicts with the configured workspace",
        );
      return;
    }
    await pages.createResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: key,
      key,
      kind: "system/bootstrap",
      state: "active",
      version: "v1",
    });
  }

  /** Records schema state. */
  private async recordSchemaState(): Promise<void> {
    /** Holds the `key` intermediate used by `recordSchemaState`. */
    const key = `system/schema/${this.target.version}`;
    /** Holds the `body` intermediate used by `recordSchemaState`. */
    const body = canonicalize(
      toJsonValue({
        schema: "agent-task-manager-schema-state-v1",
        targetDigest: this.target.digest,
        targetVersion: this.target.version,
      }),
    );
    await this.pageStore().createResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: key,
      key,
      kind: "system/schema",
      state: "active",
      version: "v1",
    });
  }

  /** Reads schema state. */
  private async readSchemaState(): Promise<JsonObject | null> {
    /** Holds the `key` intermediate used by `readSchemaState`. */
    const key = `system/schema/${this.target.version}`;
    /** Holds the `located` intermediate used by `readSchemaState`. */
    const located = await this.pageStore().findUniqueByTitle(
      "resources",
      "Resource",
      key,
    );
    if (located === null) return null;
    return objectValue(
      toJsonValue(
        JSON.parse(
          await this.pageStore().managedText(located.id, "Resource body"),
        ),
      ),
      "Schema state",
    );
  }

  /** Reads step record. */
  private async readStepRecord(
    stepId: string,
  ): Promise<WorkspaceStepRecord | null> {
    if (!this.#resolved.has("resources")) return null;
    /** Holds the `located` intermediate used by `readStepRecord`. */
    const located = await this.pageStore().findUniqueByTitle(
      "resources",
      "Resource",
      stepReceiptKey(stepId),
    );
    if (located === null) return null;
    return parseWorkspaceStepRecord(
      toJsonValue(
        JSON.parse(
          await this.pageStore().managedText(located.id, "Resource body"),
        ),
      ),
    );
  }

  /** Persists step record. */
  private async writeStepRecord(record: WorkspaceStepRecord): Promise<void> {
    /** Holds the `key` intermediate used by `writeStepRecord`. */
    const key = stepReceiptKey(record.step.id);
    /** Holds the `body` intermediate used by `writeStepRecord`. */
    const body = canonicalize(toJsonValue(record));
    await this.pageStore().createResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: key,
      key,
      kind: "system/workspace-step",
      state: "active",
      version: "v1",
    });
  }

  /** Builds a page store from the resolved workspace table IDs. */
  private pageStore(): NotionPageStore {
    /** Holds the `fallback` intermediate used by `pageStore`. */
    const fallback = "unresolved";
    return new NotionPageStore(
      {
        errors: this.#resolved.get("errors") ?? fallback,
        resources: requiredResolved(this.#resolved, "resources"),
        subAgents: this.#resolved.get("subAgents") ?? fallback,
        tasks: this.#resolved.get("tasks") ?? fallback,
      },
      this.transport,
      this.now,
    );
  }

  /** Builds session key. */
  private bootstrapSessionKey(mode: WorkspaceMigrationPlan["mode"]): string {
    return `system/bootstrap-session/${sha256(`${this.environmentId}\0${mode}\0${this.target.version}`)}`;
  }

  /** Builds environment. */
  private resolvedEnvironment(): ProviderEnvironment {
    return {
      ...this.environment,
      tables: Object.fromEntries(
        TABLE_KINDS.map((kind) => [kind, this.#resolved.get(kind) ?? null]),
      ) as unknown as ProviderEnvironment["tables"],
    };
  }
}

/** Converts a logical property descriptor to a Notion schema property. */
function propertySchema(
  property: PropertyDescriptor,
  table: TableKind,
  resolved?: ReadonlyMap<TableKind, string>,
): JsonObject {
  if (property.targetTable !== null) {
    if (resolved === undefined)
      throw new Error(
        `Relation ${property.physicalName} cannot be created before table resolution`,
      );
    return {
      relation: {
        data_source_id: requiredResolved(resolved, property.targetTable),
        single_property: {},
      },
    };
  }
  if (property.type === "title") return { title: {} };
  if (property.type === "rich_text") return { rich_text: {} };
  if (property.type === "number") return { number: { format: "number" } };
  if (property.type === "checkbox") return { checkbox: {} };
  if (property.type === "url") return { url: {} };
  if (property.type === "date") return { date: {} };
  if (property.type === "people") return { people: {} };
  if (property.type === "created_time") return { created_time: {} };
  if (property.type === "last_edited_time") return { last_edited_time: {} };
  if (property.type === "select")
    return {
      select: {
        options: selectOptions(table, property.physicalName).map((name) => ({
          name,
        })),
      },
    };
  if (property.type === "status")
    return {
      status: {
        options: selectOptions(table, property.physicalName).map((name) => ({
          name,
        })),
      },
    };
  throw new Error(`Unsupported Notion property type: ${property.type}`);
}

/** Simulates workspace step. */
function simulateWorkspaceStep(
  snapshot: WorkspaceSchemaSnapshot,
  step: Pick<WorkspaceMigrationStep, "kind" | "payload">,
  target: WorkspaceSchemaDescriptor,
): WorkspaceSchemaSnapshot {
  /** Holds the `kind` intermediate used by `simulateWorkspaceStep`. */
  const kind = tableKind({
    ...step,
    dependsOn: [],
    expectedPostSchemaDigest: "",
    expectedPreSchemaDigest: "",
    id: "simulation",
    reversibility: "additive",
  });
  /** Holds the `tables` intermediate used by `simulateWorkspaceStep`. */
  let tables = [...structuredClone(snapshot.tables)];
  if (step.kind === "create_table") {
    if (!tables.some((table) => table.kind === kind)) {
      /** Holds the `descriptor` intermediate used by `simulateWorkspaceStep`. */
      const descriptor = tableDescriptor(target, kind);
      tables.push({
        id: `planned:${kind}`,
        kind,
        managedRanges: [],
        properties: descriptor.properties
          .filter((property) => property.targetTable === null)
          .map((property) => ({
            name: property.physicalName,
            providerMetadata: {},
            targetTableId: null,
            type: property.type,
            writable: property.writable,
          })),
        title: descriptor.title,
        version: "planned",
      });
    }
  } else if (step.kind === "add_property" || step.kind === "add_relation") {
    /** Holds the `name` intermediate used by `simulateWorkspaceStep`. */
    const name = requiredString(
      step.payload.physicalName,
      "Workspace property name",
    );
    /** Holds the `descriptor` intermediate used by `simulateWorkspaceStep`. */
    const descriptor = tableDescriptor(target, kind).properties.find(
      (property) => property.physicalName === name,
    );
    if (descriptor === undefined)
      throw new Error(`Unknown target property ${kind}.${name}`);
    /** Holds the `targetId` intermediate used by `simulateWorkspaceStep`. */
    const targetId =
      descriptor.targetTable === null
        ? null
        : tables.find((table) => table.kind === descriptor.targetTable)?.id;
    if (descriptor.targetTable !== null && targetId === undefined)
      throw new Error(`Unresolved relation target ${descriptor.targetTable}`);
    tables = tables.map((table) =>
      table.kind !== kind ||
      table.properties.some((property) => property.name === name)
        ? table
        : {
            ...table,
            properties: [
              ...table.properties,
              {
                name,
                providerMetadata: {},
                targetTableId: targetId ?? null,
                type: descriptor.type,
                writable: descriptor.writable,
              },
            ],
          },
    );
  } else if (step.kind !== "record_schema_state") {
    throw new Error(`Unsupported simulated Notion step: ${step.kind}`);
  }
  return { ...snapshot, digest: notionSchemaDigest(tables), tables };
}

/** Builds options. */
function selectOptions(table: TableKind, property: string): readonly string[] {
  if (table === "resources" && property === "State")
    return ["active", "draft", "retired"];
  if (table === "resources" && property === "Kind")
    return [
      "prompt",
      "policy",
      "task-query",
      "json-schema",
      "invocation-schedule",
      "system/bootstrap",
      "system/schema",
      "system/workspace-step",
      "system/environment-patch",
      "system/bootstrap-session",
      "system/human-interaction-slot",
      "system/human-consumption",
      "system/external-effect-intent",
      "system/child-agent-node-intent",
      "system/workspace-ownership",
      "system/lease",
      "system/intent",
      "system/assignment-intent",
      "system/assignment-budget",
    ];
  if (table === "errors" && property === "Severity")
    return ["critical", "high", "medium", "low"];
  if (table === "errors" && property === "Status")
    return ["Not Fixed", "Fixing", "Fixed"];
  if (table === "subAgents" && property === "Status")
    return ["Online", "Offline"];
  return [];
}

/** Resolves descriptor. */
function tableDescriptor(target: WorkspaceSchemaDescriptor, kind: TableKind) {
  /** Holds the `table` intermediate used by `tableDescriptor`. */
  const table = target.tables.find((candidate) => candidate.kind === kind);
  if (table === undefined) throw new Error(`Target schema omits ${kind}`);
  return table;
}

/** Resolves kind. */
function tableKind(step: WorkspaceMigrationStep): TableKind {
  /** Holds the `kind` intermediate used by `tableKind`. */
  const kind = requiredString(step.payload.kind, "Workspace step table kind");
  if (!TABLE_KINDS.includes(kind as TableKind))
    throw new TypeError(`Invalid workspace table kind: ${kind}`);
  return kind as TableKind;
}

/** Builds digest. */
function stepDigest(step: WorkspaceMigrationStep): string {
  return sha256(canonicalize(toJsonValue(step)));
}
/** Builds receipt key. */
function stepReceiptKey(stepId: string): string {
  return `system/workspace-step/${sha256(stepId)}`;
}

/** Parses and validates workspace step record. */
function parseWorkspaceStepRecord(value: JsonValue): WorkspaceStepRecord {
  /** Holds the `object` intermediate used by `parseWorkspaceStepRecord`. */
  const object = objectValue(value, "Workspace step record");
  /** Defines `expectedKeys` for comparison in `parseWorkspaceStepRecord`. */
  const expectedKeys = ["receipt", "schema", "state", "step", "stepDigest"];
  if (Object.keys(object).sort().join("\0") !== expectedKeys.sort().join("\0"))
    throw new TypeError(
      "Workspace step record has unexpected or missing fields",
    );
  if (
    object.schema !== "agent-task-manager-workspace-step-v1" ||
    (object.state !== "pending" && object.state !== "applied")
  )
    throw new TypeError("Workspace step record schema or state is invalid");
  /** Captures `receipt` returned by `parseWorkspaceStepRecord`. */
  const receipt =
    object.receipt === null ? null : parseWriteReceipt(object.receipt ?? null);
  if ((object.state === "applied") !== (receipt !== null))
    throw new TypeError("Workspace step record state and receipt disagree");
  /** Holds the `step` intermediate used by `parseWorkspaceStepRecord`. */
  const step = parseWorkspaceStep(objectValue(object.step, "Workspace step"));
  /** Holds the `digest` intermediate used by `parseWorkspaceStepRecord`. */
  const digest = requiredString(object.stepDigest, "Workspace step digest");
  if (digest !== stepDigest(step))
    throw new TypeError("Workspace step record digest is invalid");
  return {
    receipt,
    schema: object.schema,
    state: object.state,
    step,
    stepDigest: digest,
  };
}

/** Parses and validates workspace step. */
function parseWorkspaceStep(value: JsonObject): WorkspaceMigrationStep {
  /** Defines `expectedKeys` for comparison in `parseWorkspaceStep`. */
  const expectedKeys = [
    "dependsOn",
    "expectedPostSchemaDigest",
    "expectedPreSchemaDigest",
    "id",
    "kind",
    "payload",
    "reversibility",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0"))
    throw new TypeError("Workspace step has unexpected or missing fields");
  /** Holds the `kind` intermediate used by `parseWorkspaceStep`. */
  const kind = requiredString(value.kind, "Workspace step kind");
  /** Holds the `allowedKinds` intermediate used by `parseWorkspaceStep`. */
  const allowedKinds: WorkspaceMigrationStep["kind"][] = [
    "add_managed_range",
    "add_option",
    "add_property",
    "add_relation",
    "create_table",
    "record_schema_state",
  ];
  if (!allowedKinds.includes(kind as WorkspaceMigrationStep["kind"]))
    throw new TypeError("Workspace step kind is invalid");
  /** Holds the `dependencies` intermediate used by `parseWorkspaceStep`. */
  const dependencies = value.dependsOn;
  if (
    !Array.isArray(dependencies) ||
    dependencies.some(
      (dependency) => typeof dependency !== "string" || dependency === "",
    )
  )
    throw new TypeError("Workspace step dependencies are invalid");
  if (value.reversibility !== "additive" && value.reversibility !== "manual")
    throw new TypeError("Workspace step reversibility is invalid");
  return {
    dependsOn: dependencies as string[],
    expectedPostSchemaDigest: requiredString(
      value.expectedPostSchemaDigest,
      "Workspace post digest",
    ),
    expectedPreSchemaDigest: requiredString(
      value.expectedPreSchemaDigest,
      "Workspace pre digest",
    ),
    id: requiredString(value.id, "Workspace step id"),
    kind: kind as WorkspaceMigrationStep["kind"],
    payload: objectValue(value.payload, "Workspace step payload"),
    reversibility: value.reversibility,
  };
}

/** Parses and validates bootstrap session. */
function parseBootstrapSession(value: JsonValue): BootstrapSessionRecord {
  /** Holds the `object` intermediate used by `parseBootstrapSession`. */
  const object = objectValue(value, "Bootstrap session");
  /** Defines `expectedKeys` for comparison in `parseBootstrapSession`. */
  const expectedKeys = [
    "completedStepIds",
    "nextStepId",
    "plan",
    "schema",
    "state",
  ];
  if (Object.keys(object).sort().join("\0") !== expectedKeys.sort().join("\0"))
    throw new TypeError("Bootstrap session has unexpected or missing fields");
  if (
    object.schema !== "agent-task-manager-bootstrap-session-v1" ||
    (object.state !== "applying" && object.state !== "complete")
  ) {
    throw new TypeError("Bootstrap session schema or state is invalid");
  }
  /** Holds the `completed` intermediate used by `parseBootstrapSession`. */
  const completed = stringArray(
    object.completedStepIds,
    "Bootstrap completed steps",
  );
  /** Holds the `plan` intermediate used by `parseBootstrapSession`. */
  const plan = parseWorkspacePlan(objectValue(object.plan, "Bootstrap plan"));
  /** Tracks unique entries in `known` for `parseBootstrapSession`. */
  const known = new Set(plan.steps.map((step) => step.id));
  if (
    completed.some((stepId) => !known.has(stepId)) ||
    new Set(completed).size !== completed.length
  ) {
    throw new TypeError("Bootstrap completed steps are invalid");
  }
  /** Holds the `nextStep` intermediate used by `parseBootstrapSession`. */
  const nextStep = plan.steps.find((step) => !completed.includes(step.id));
  /** Holds the `nextStepId` intermediate used by `parseBootstrapSession`. */
  const nextStepId =
    object.nextStepId === null
      ? null
      : requiredString(object.nextStepId, "Bootstrap next step");
  if (
    (nextStep?.id ?? null) !== nextStepId ||
    (nextStep === undefined) !== (object.state === "complete")
  ) {
    throw new TypeError("Bootstrap session progress is inconsistent");
  }
  return {
    completedStepIds: completed,
    nextStepId,
    plan,
    schema: object.schema,
    state: object.state,
  };
}

/** Parses and validates workspace plan. */
function parseWorkspacePlan(value: JsonObject): WorkspaceMigrationPlan {
  /** Defines `expectedKeys` for comparison in `parseWorkspacePlan`. */
  const expectedKeys = [
    "digest",
    "environmentId",
    "mode",
    "observedSchemaDigest",
    "parentIdentity",
    "providerIdentity",
    "steps",
    "targetSchemaDigest",
    "targetSchemaVersion",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0"))
    throw new TypeError("Workspace plan has unexpected or missing fields");
  if (value.mode !== "bootstrap" && value.mode !== "migration")
    throw new TypeError("Workspace plan mode is invalid");
  if (value.parentIdentity !== null && typeof value.parentIdentity !== "string")
    throw new TypeError("Workspace plan parent identity is invalid");
  if (!Array.isArray(value.steps))
    throw new TypeError("Workspace plan steps must be an array");
  /** Holds the `plan` intermediate used by `parseWorkspacePlan`. */
  const plan = finalizeMigrationPlan({
    environmentId: requiredString(
      value.environmentId,
      "Workspace plan environment",
    ),
    mode: value.mode,
    observedSchemaDigest: requiredString(
      value.observedSchemaDigest,
      "Workspace plan observed digest",
    ),
    parentIdentity: value.parentIdentity,
    providerIdentity: requiredString(
      value.providerIdentity,
      "Workspace plan provider identity",
    ),
    steps: value.steps.map((step) =>
      parseWorkspaceStep(objectValue(step, "Workspace plan step")),
    ),
    targetSchemaDigest: requiredString(
      value.targetSchemaDigest,
      "Workspace plan target digest",
    ),
    targetSchemaVersion: requiredString(
      value.targetSchemaVersion,
      "Workspace plan target version",
    ),
  });
  if (plan.digest !== requiredString(value.digest, "Workspace plan digest"))
    throw new TypeError("Workspace plan digest is invalid");
  return plan;
}

/** Validates array. */
function stringArray(value: JsonValue | undefined, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "")
  )
    throw new TypeError(`${label} must be non-empty strings`);
  return value as string[];
}

/** Converts text payload. */
function richTextPayload(text: string): JsonValue[] {
  return [{ text: { content: text }, type: "text" }];
}
/** Converts text. */
function richText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      /** Holds the `object` intermediate used by `richText`. */
      const object = objectValue(item, "Rich text item");
      return typeof object.plain_text === "string" ? object.plain_text : "";
    })
    .join("");
}

/** Resolves identity. */
function parentIdentity(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  /** Holds the `parent` intermediate used by `parentIdentity`. */
  const parent = objectValue(value, "Database parent");
  /** Holds the `id` intermediate used by `parentIdentity`. */
  const id = parent.page_id ?? parent.database_id;
  return typeof id === "string" ? normalizeNotionIdentifier(id) : null;
}

/** Returns a resolved table ID or throws when resolution is incomplete. */
function requiredResolved(
  values: ReadonlyMap<TableKind, string>,
  kind: TableKind,
): string {
  /** Holds the `value` intermediate used by `requiredResolved`. */
  const value = values.get(kind);
  if (value === undefined)
    throw new Error(`Notion ${kind} table is unresolved`);
  return value;
}

/** Returns a migration draft or throws when it is missing. */
function requiredDraft<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Migration draft is missing");
  return value;
}
/** Returns a JSON value or throws when it is missing. */
function requiredValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) throw new TypeError("Expected value is missing");
  return value;
}
/** Returns a validated JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}
/** Returns a required non-empty string or throws. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
