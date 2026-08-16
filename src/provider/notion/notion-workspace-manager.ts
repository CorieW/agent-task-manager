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
import {
  ERROR_SEVERITY_OPTIONS,
  RESOURCE_KIND_OPTIONS,
  RESOURCE_STATE_OPTIONS,
} from "./notion-option-codec.js";

/** Table kinds in dependency-safe bootstrap order. */
const TABLE_ORDER: readonly TableKind[] = [
  "operations",
  "resources",
  "errors",
  "tasks",
  "agents",
];

/** Canonical workspace step record. */
interface WorkspaceStepRecord {
  /** Durable receipt proving the provider write. */
  readonly receipt: WriteReceipt | null;
  /** Wire-schema discriminator; always `agent-task-manager-workspace-step-v1`. */
  readonly schema: "agent-task-manager-workspace-step-v1";
  /** Lifecycle state used for workflow decisions. */
  readonly state: "applied" | "pending";
  /** Migration step represented by the journal record. */
  readonly step: WorkspaceMigrationStep;
  /** Binds workspace step record to canonical step content. */
  readonly stepDigest: string;
}

/** Canonical bootstrap session record. */
export interface BootstrapSessionRecord {
  /** Ordered completed step IDs for bootstrap session record. */
  readonly completedStepIds: readonly string[];
  /** Stable identifier for next step id. */
  readonly nextStepId: string | null;
  /** Immutable migration plan resumed by the bootstrap session. */
  readonly plan: WorkspaceMigrationPlan;
  /** Wire-schema discriminator; always `agent-task-manager-bootstrap-session-v1`. */
  readonly schema: "agent-task-manager-bootstrap-session-v1";
  /** Lifecycle state used for workflow decisions. */
  readonly state: "applying" | "complete";
}

/** Implements Notion workspace manager. */
export class NotionWorkspaceManager {
  /** Stable identifier for environment id. */
  readonly #resolved = new Map<TableKind, string>();

  /** Initializes Notion workspace manager. */
  public constructor(
    /** Stable identifier for environment id. */ private readonly environmentId: string,
    /** Environment callback invoked by Notion workspace manager. */ private readonly environment: ProviderEnvironment,
    /** Target callback invoked by Notion workspace manager. */ private readonly target: WorkspaceSchemaDescriptor,
    /** Transport callback invoked by Notion workspace manager. */ private readonly transport: NotionTransport,
    /** Now callback invoked by Notion workspace manager. */ private readonly now: () => Date = () =>
      new Date(),
  ) {}

  /** Inspects workspace schema without mutation. */
  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    await this.resolveTables();
    /** Result of `NotionWorkspaceReader`, retained for `inspectWorkspaceSchema`. */
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
    /** Result of `compareWorkspaceSchema`, retained for `planWorkspaceChanges`. */
    const report = compareWorkspaceSchema(request.observed, request.target);
    if (report.state === "blocked_incompatible")
      throw new Error("Cannot plan over an incompatible Notion workspace");
    /** Result of `tableDescriptor`, retained for `planWorkspaceChanges`. */
    const drafts: Array<
      Pick<WorkspaceMigrationStep, "id" | "kind" | "payload">
    > = [];
    for (const kind of TABLE_ORDER) {
      /** Target table descriptor used to plan scalar properties. */
      const expected = tableDescriptor(this.target, kind);
      /** Expected observed used to validate `planWorkspaceChanges`. */
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
      /** Target table descriptor used to plan relational properties. */
      const expected = tableDescriptor(this.target, kind);
      /** Expected observed used to validate `planWorkspaceChanges`. */
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
          kind: "operations",
          targetDigest: this.target.digest,
          targetVersion: this.target.version,
        },
      });
    }

    /** Result of `simulateWorkspaceStep`, retained for `planWorkspaceChanges`. */
    let simulated = request.observed;
    /** Result of `simulateWorkspaceStep`, retained for `planWorkspaceChanges`. */
    const steps: WorkspaceMigrationStep[] = [];
    for (const [index, draft] of drafts.entries()) {
      /** Result of `simulateWorkspaceStep`, retained for `planWorkspaceChanges`. */
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
    if (this.#resolved.has("operations")) await this.ensureBootstrapRoot();
    /** Result of `this.readStepRecord`, retained for `applyWorkspaceStep`. */
    const prior = await this.readStepRecord(step.id);
    if (prior !== null) {
      if (prior.stepDigest !== stepDigest(step))
        throw new Error(
          `Workspace step ${step.id} changed after it was journaled`,
        );
      if (prior.state === "applied" && prior.receipt !== null)
        return prior.receipt;
      /** Result of `this.reconcileEffect`, retained for `applyWorkspaceStep`. */
      const recovered = await this.reconcileEffect(prior.step);
      if (recovered.state === "applied")
        return this.finalizeRecoveredStep(prior.step);
      if (recovered.state !== "not_applied")
        throw new Error(`Workspace step ${step.id} remains indeterminate`);
    } else if (
      step.id === `notion:${this.target.version}:create:operations` &&
      this.#resolved.has("operations")
    ) {
      /** Result of `this.reconcileEffect`, retained for `applyWorkspaceStep`. */
      const recovered = await this.reconcileEffect(step);
      if (recovered.state === "applied")
        return this.finalizeRecoveredStep(step);
    }
    for (const dependency of step.dependsOn) {
      /** Result of `this.readStepRecord`, retained for `applyWorkspaceStep`. */
      const record = await this.readStepRecord(dependency);
      if (record?.state !== "applied")
        throw new Error(
          `Workspace step dependency is incomplete: ${dependency}`,
        );
    }
    /** Result of `this.inspectWorkspaceSchema`, retained for `applyWorkspaceStep`. */
    const current = await this.inspectWorkspaceSchema();
    if (current.digest !== step.expectedPreSchemaDigest)
      throw new Error(`Workspace precondition changed: ${step.id}`);
    if (this.#resolved.has("operations"))
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

    /** Result of `this.reconcileEffect`, retained for `applyWorkspaceStep`. */
    const reconciliation = await this.reconcileEffect(step);
    if (reconciliation.state !== "applied")
      throw new Error(`Workspace step post-verification failed: ${step.id}`);
    /** Result of `this.inspectWorkspaceSchema`, retained for `applyWorkspaceStep`. */
    const verifiedSnapshot = await this.inspectWorkspaceSchema();
    if (verifiedSnapshot.digest !== step.expectedPostSchemaDigest)
      throw new Error(`Workspace postcondition changed: ${step.id}`);
    /** Result of `tableKind`, retained for `applyWorkspaceStep`. */
    const table = tableKind(step);
    /** Result of `requiredResolved`, retained for `applyWorkspaceStep`. */
    const tableId = requiredResolved(this.#resolved, table);
    /** Expected observed used to validate `applyWorkspaceStep`. */
    const observed = verifiedSnapshot.tables.find(
      (candidate) => candidate.kind === table,
    );
    if (observed === undefined)
      throw new Error(`Workspace step did not produce ${table}`);
    /** Result of `applyWorkspaceStep`, retained for validation and reuse. */
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
    /** Result of `this.readStepRecord`, retained for `reconcileWorkspaceStep`. */
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
    /** Result of `this.reconcileEffect`, retained for `reconcileWorkspaceStep`. */
    const effective =
      supplied ?? stored?.step ?? this.knownUnjournaledStep(stepId);
    if (effective === null) return { evidence: {}, state: "not_applied" };
    /** Result of `reconcileWorkspaceStep`, retained for validation and reuse. */
    const result = await this.reconcileEffect(effective);
    if (stored?.state === "pending" && result.state === "applied") {
      /** Result of `reconcileWorkspaceStep`, retained for validation and reuse. */
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
    /** Result of `tableKind`, retained for `reconcileEffect`. */
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
      /** Result of `requiredString`, retained for `reconcileEffect`. */
      const physicalName = requiredString(
        supplied.payload.physicalName,
        "Workspace property name",
      );
      /** Result of `tableDescriptor`, retained for `reconcileEffect`. */
      const table = (await this.inspectWorkspaceSchema()).tables.find(
        (candidate) => candidate.kind === kind,
      );
      /** Target property descriptor used to verify observed semantics. */
      const expected = tableDescriptor(this.target, kind).properties.find(
        (item) => item.physicalName === physicalName,
      );
      /** Expected observed used to validate `reconcileEffect`. */
      const observed = table?.properties.find(
        (item) => item.name === physicalName,
      );
      /** Applied snapshot used consistently during `reconcileEffect`. */
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
      /** Result of `this.readSchemaState`, retained for `reconcileEffect`. */
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
    /** Result of `this.inspectWorkspaceSchema`, retained for `finalizeRecoveredStep`. */
    const snapshot = await this.inspectWorkspaceSchema();
    if (snapshot.digest !== step.expectedPostSchemaDigest)
      throw new Error(
        `Recovered workspace postcondition does not match: ${step.id}`,
      );
    /** Result of `tableKind`, retained for `finalizeRecoveredStep`. */
    const table = tableKind(step);
    /** Expected observed used to validate `finalizeRecoveredStep`. */
    const observed = snapshot.tables.find(
      (candidate) => candidate.kind === table,
    );
    if (observed === undefined)
      throw new Error(`Recovered workspace step did not produce ${table}`);
    /** Receipt reconstructed from the verified recovered schema state. */
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
    /** Sole bootstrap step allowed to predate the Operations journal. */
    const expectedId = `notion:${this.target.version}:create:operations`;
    if (stepId !== expectedId) return null;
    return {
      dependsOn: [],
      expectedPostSchemaDigest: "unknown-without-authorized-plan",
      expectedPreSchemaDigest: notionSchemaDigest([]),
      id: expectedId,
      kind: "create_table",
      payload: { kind: "operations" },
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

  /** Persists the environment patch required to adopt resolved table IDs. */
  public async recordEnvironmentPatch(
    startingFileDigest: string,
    state: "applied" | "pending_human",
  ): Promise<void> {
    await this.resolveTables();
    /** Result of `this.configuredTablePatch`, retained for `recordEnvironmentPatch`. */
    const tables = this.configuredTablePatch();
    /** Result of `canonicalize`, retained for `recordEnvironmentPatch`. */
    const key = `workspace/environment-patch/${sha256(this.environmentId)}`;
    /** Result of `canonicalize`, retained for `recordEnvironmentPatch`. */
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
    await this.pageStore().createOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `${key}:${state}`,
      key,
      kind: "workspace/environment-patch",
      state: "active",
      version: "v1",
    });
  }

  /** Reads bootstrap session. */
  public async readBootstrapSession(
    mode: WorkspaceMigrationPlan["mode"],
  ): Promise<BootstrapSessionRecord | null> {
    await this.resolveTables();
    if (!this.#resolved.has("operations")) return null;
    /** Unique persisted bootstrap-session Resource, if one exists. */
    const located = await this.pageStore().findUniqueByTitle(
      "operations",
      "Operation",
      this.bootstrapSessionKey(mode),
    );
    if (located === null) return null;
    return parseBootstrapSession(
      toJsonValue(
        JSON.parse(
          await this.pageStore().managedText(located.id, "Operation body"),
        ),
      ),
    );
  }

  /** Persists validated bootstrap progress for deterministic resumption. */
  public async recordBootstrapSession(
    plan: WorkspaceMigrationPlan,
    completedStepIds: readonly string[],
  ): Promise<void> {
    await this.resolveTables();
    /** Planned step IDs used to reject unknown completion claims. */
    const knownStepIds = new Set(plan.steps.map((step) => step.id));
    /** Deduplicated completed step IDs persisted in the session. */
    const completed = [...new Set(completedStepIds)];
    if (completed.some((stepId) => !knownStepIds.has(stepId)))
      throw new Error("Bootstrap session contains an unknown completed step");
    /** First planned step not yet marked complete. */
    const nextStep = plan.steps.find((step) => !completed.includes(step.id));
    /** Canonical bootstrap-session state derived from the plan and progress. */
    const record: BootstrapSessionRecord = {
      completedStepIds: completed,
      nextStepId: nextStep?.id ?? null,
      plan,
      schema: "agent-task-manager-bootstrap-session-v1",
      state: nextStep === undefined ? "complete" : "applying",
    };
    /** Canonical JSON body whose digest identifies this session state. */
    const body = canonicalize(toJsonValue(record));
    /** Stable Resource key for this bootstrap mode. */
    const key = this.bootstrapSessionKey(plan.mode);
    await this.pageStore().createOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `${key}:${sha256(body)}`,
      key,
      kind: "workspace/bootstrap-session",
      state: "active",
      version: "v1",
    });
  }

  /** Resolves tables. */
  private async resolveTables(): Promise<void> {
    for (const kind of TABLE_ORDER) {
      if (this.#resolved.has(kind)) continue;
      /** Environment-supplied table identifier, if configured. */
      const configured = this.environment.tables[kind];
      if (configured !== null && configured !== undefined) {
        /** Reader that normalizes and validates the configured identifier. */
        const reader = new NotionWorkspaceReader(
          this.environment,
          this.target,
          this.transport,
          this.now,
        );
        this.#resolved.set(kind, await reader.resolveDataSourceId(configured));
        continue;
      }
      /** Table identifier discovered beneath the bootstrap parent. */
      const discovered = await this.discoverTable(kind);
      if (discovered !== null) this.#resolved.set(kind, discovered);
    }
  }

  /** Discovers table. */
  private async discoverTable(kind: TableKind): Promise<string | null> {
    if (this.environment.bootstrapParent === null) return null;
    /** Normalized bootstrap-parent page identifier. */
    const parentId = normalizeNotionIdentifier(
      this.environment.bootstrapParent,
    );
    /** Canonical table title used for exact discovery. */
    const title = tableDescriptor(this.target, kind).title;
    /** Complete Notion search result set for the canonical title. */
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
    /** Data sources whose object type and title match exactly. */
    const candidates = results.filter(
      (source) =>
        source.object === "data_source" && richText(source.title) === title,
    );
    /** Candidates whose parent database belongs to the bootstrap parent. */
    const matches: JsonObject[] = [];
    for (const source of candidates) {
      /** Candidate data-source parent metadata. */
      const sourceParent = objectValue(
        source.parent,
        `${title} data source parent`,
      );
      /** Parent database ID used to verify workspace ancestry. */
      const databaseId = requiredString(
        sourceParent.database_id,
        `${title} parent database id`,
      );
      /** Parent database whose page ancestry is being verified. */
      const database = await this.transport.request({
        method: "GET",
        path: `/v1/databases/${databaseId}`,
      });
      if (parentIdentity(database.parent) === parentId) matches.push(source);
    }
    if (matches.length > 1)
      throw new Error(`Bootstrap parent contains multiple ${title} databases`);
    /** Sole table match after title and parent validation. */
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
    /** Target schema descriptor for the table being created. */
    const descriptor = tableDescriptor(this.target, kind);
    /** Non-relational properties valid before related tables exist. */
    const properties = Object.fromEntries(
      descriptor.properties
        .filter((property) => property.targetTable === null)
        .map((property) => [
          property.physicalName,
          propertySchema(property, kind),
        ]),
    );
    /** Notion response exposing the created database's data source. */
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
    /** Data sources returned for the newly created database. */
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
    if (kind === "operations") await this.ensureBootstrapRoot();
  }

  /** Adds property. */
  private async addProperty(step: WorkspaceMigrationStep): Promise<void> {
    /** Target table kind encoded by the migration step. */
    const kind = tableKind(step);
    /** Physical Notion property name encoded by the migration step. */
    const name = requiredString(
      step.payload.physicalName,
      "Workspace property name",
    );
    /** Target property descriptor matching the physical name. */
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
    /** Resolved Operations data-source identifier. */
    const operations = requiredResolved(this.#resolved, "operations");
    /** Page-store boundary used to verify or create the bootstrap root. */
    const pages = this.pageStore();
    /** Stable key of the bootstrap-root operation. */
    const key = "workspace/bootstrap-root";
    /** Canonical bootstrap identity bound to the parent and Operations table. */
    const body = canonicalize(
      toJsonValue({
        parentIdentity: this.environment.bootstrapParent,
        operationsDataSourceId: operations,
        schema: "agent-task-manager-bootstrap-root-v1",
      }),
    );
    /** Existing bootstrap-root operation, if one is already present. */
    const existing = await pages.findUniqueByTitle(
      "operations",
      "Operation",
      key,
    );
    if (existing !== null) {
      if ((await pages.managedText(existing.id, "Operation body")) !== body)
        throw new Error(
          "bootstrap-root-v1 conflicts with the configured workspace",
        );
      return;
    }
    await pages.createOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: key,
      key,
      kind: "workspace/bootstrap",
      state: "active",
      version: "v1",
    });
  }

  /** Persists the target schema version and digest after migration. */
  private async recordSchemaState(): Promise<void> {
    /** Stable operation key for the target schema version. */
    const key = `workspace/schema/${this.target.version}`;
    /** Canonical schema-state body bound to the target digest. */
    const body = canonicalize(
      toJsonValue({
        schema: "agent-task-manager-schema-state-v1",
        targetDigest: this.target.digest,
        targetVersion: this.target.version,
      }),
    );
    await this.pageStore().createOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: key,
      key,
      kind: "workspace/schema",
      state: "active",
      version: "v1",
    });
  }

  /** Reads schema state. */
  private async readSchemaState(): Promise<JsonObject | null> {
    /** Stable operation key for the target schema version. */
    const key = `workspace/schema/${this.target.version}`;
    /** Unique persisted schema-state operation, if one exists. */
    const located = await this.pageStore().findUniqueByTitle(
      "operations",
      "Operation",
      key,
    );
    if (located === null) return null;
    return objectValue(
      toJsonValue(
        JSON.parse(
          await this.pageStore().managedText(located.id, "Operation body"),
        ),
      ),
      "Schema state",
    );
  }

  /** Reads step record. */
  private async readStepRecord(
    stepId: string,
  ): Promise<WorkspaceStepRecord | null> {
    if (!this.#resolved.has("operations")) return null;
    /** Result of `this.pageStore`, retained for `readStepRecord`. */
    const located = await this.pageStore().findUniqueByTitle(
      "operations",
      "Operation",
      stepReceiptKey(stepId),
    );
    if (located === null) return null;
    return parseWorkspaceStepRecord(
      toJsonValue(
        JSON.parse(
          await this.pageStore().managedText(located.id, "Operation body"),
        ),
      ),
    );
  }

  /** Persists step record. */
  private async writeStepRecord(record: WorkspaceStepRecord): Promise<void> {
    /** Result of `stepReceiptKey`, retained for `writeStepRecord`. */
    const key = stepReceiptKey(record.step.id);
    /** Result of `canonicalize`, retained for `writeStepRecord`. */
    const body = canonicalize(toJsonValue(record));
    await this.pageStore().createOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: key,
      key,
      kind: "workspace/step",
      state: "active",
      version: "v1",
    });
  }

  /** Builds a page store from the resolved workspace table IDs. */
  private pageStore(): NotionPageStore {
    /** Fallback snapshot used consistently during `pageStore`. */
    const fallback = "unresolved";
    return new NotionPageStore(
      {
        errors: this.#resolved.get("errors") ?? fallback,
        operations: requiredResolved(this.#resolved, "operations"),
        resources: this.#resolved.get("resources") ?? fallback,
        agents: this.#resolved.get("agents") ?? fallback,
        tasks: this.#resolved.get("tasks") ?? fallback,
      },
      this.transport,
      this.now,
    );
  }

  /** Builds session key. */
  private bootstrapSessionKey(mode: WorkspaceMigrationPlan["mode"]): string {
    return `workspace/bootstrap-session/${sha256(`${this.environmentId}\0${mode}\0${this.target.version}`)}`;
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
  /** Result of `tableKind`, retained for `simulateWorkspaceStep`. */
  const kind = tableKind({
    ...step,
    dependsOn: [],
    expectedPostSchemaDigest: "",
    expectedPreSchemaDigest: "",
    id: "simulation",
    reversibility: "additive",
  });
  /** Result of `tableDescriptor`, retained for `simulateWorkspaceStep`. */
  let tables = [...structuredClone(snapshot.tables)];
  if (step.kind === "create_table") {
    if (!tables.some((table) => table.kind === kind)) {
      /** Result of `tableDescriptor`, retained for `simulateWorkspaceStep`. */
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
    /** Result of `requiredString`, retained for `simulateWorkspaceStep`. */
    const name = requiredString(
      step.payload.physicalName,
      "Workspace property name",
    );
    /** Result of `tableDescriptor`, retained for `simulateWorkspaceStep`. */
    const descriptor = tableDescriptor(target, kind).properties.find(
      (property) => property.physicalName === name,
    );
    if (descriptor === undefined)
      throw new Error(`Unknown target property ${kind}.${name}`);
    /** Resolved relation-target table ID, or null for scalar properties. */
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
  if ((table === "resources" || table === "operations") && property === "State")
    return RESOURCE_STATE_OPTIONS;
  if (table === "resources" && property === "Kind")
    return RESOURCE_KIND_OPTIONS;
  if (table === "errors" && property === "Severity")
    return ERROR_SEVERITY_OPTIONS;
  if (table === "errors" && property === "Status")
    return ["Not Fixed", "Fixing", "Fixed"];
  if (table === "agents" && property === "Status") return ["Online", "Offline"];
  return [];
}

/** Resolves descriptor. */
function tableDescriptor(target: WorkspaceSchemaDescriptor, kind: TableKind) {
  /** Result of `target.tables.find`, retained for `tableDescriptor`. */
  const table = target.tables.find((candidate) => candidate.kind === kind);
  if (table === undefined) throw new Error(`Target schema omits ${kind}`);
  return table;
}

/** Resolves kind. */
function tableKind(step: WorkspaceMigrationStep): TableKind {
  /** Result of `requiredString`, retained for `tableKind`. */
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
  return `workspace/step/${sha256(stepId)}`;
}

/** Parses and validates workspace step record. */
function parseWorkspaceStepRecord(value: JsonValue): WorkspaceStepRecord {
  /** Result of `objectValue`, retained for `parseWorkspaceStepRecord`. */
  const object = objectValue(value, "Workspace step record");
  /** Exact field set required by the workspace-step record schema. */
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
  /** Applied-step receipt; null while the journal entry is pending. */
  const receipt =
    object.receipt === null ? null : parseWriteReceipt(object.receipt ?? null);
  if ((object.state === "applied") !== (receipt !== null))
    throw new TypeError("Workspace step record state and receipt disagree");
  /** Result of `parseWorkspaceStep`, retained for `parseWorkspaceStepRecord`. */
  const step = parseWorkspaceStep(objectValue(object.step, "Workspace step"));
  /** Result of `requiredString`, retained for `parseWorkspaceStepRecord`. */
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
  /** Exact field set required by the workspace-step schema. */
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
  /** Result of `requiredString`, retained for `parseWorkspaceStep`. */
  const kind = requiredString(value.kind, "Workspace step kind");
  /** Allowed kinds snapshot used consistently during `parseWorkspaceStep`. */
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
  /** Dependency IDs awaiting element validation. */
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
  /** Result of `objectValue`, retained for `parseBootstrapSession`. */
  const object = objectValue(value, "Bootstrap session");
  /** Exact field set required by the bootstrap-session schema. */
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
  /** Result of `stringArray`, retained for `parseBootstrapSession`. */
  const completed = stringArray(
    object.completedStepIds,
    "Bootstrap completed steps",
  );
  /** Result of `parseWorkspacePlan`, retained for `parseBootstrapSession`. */
  const plan = parseWorkspacePlan(objectValue(object.plan, "Bootstrap plan"));
  /** Planned step IDs used to reject unknown completion claims. */
  const known = new Set(plan.steps.map((step) => step.id));
  if (
    completed.some((stepId) => !known.has(stepId)) ||
    new Set(completed).size !== completed.length
  ) {
    throw new TypeError("Bootstrap completed steps are invalid");
  }
  /** Result of `plan.steps.find`, retained for `parseBootstrapSession`. */
  const nextStep = plan.steps.find((step) => !completed.includes(step.id));
  /** Next step id snapshot used consistently during `parseBootstrapSession`. */
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
  /** Exact field set required by the workspace-plan schema. */
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
  /** Result of `finalizeMigrationPlan`, retained for `parseWorkspacePlan`. */
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
      /** Result of `objectValue`, retained for `richText`. */
      const object = objectValue(item, "Rich text item");
      return typeof object.plain_text === "string" ? object.plain_text : "";
    })
    .join("");
}

/** Resolves identity. */
function parentIdentity(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  /** Result of `objectValue`, retained for `parentIdentity`. */
  const parent = objectValue(value, "Database parent");
  /** Id snapshot used consistently during `parentIdentity`. */
  const id = parent.page_id ?? parent.database_id;
  return typeof id === "string" ? normalizeNotionIdentifier(id) : null;
}

/** Returns a resolved table ID or throws when resolution is incomplete. */
function requiredResolved(
  values: ReadonlyMap<TableKind, string>,
  kind: TableKind,
): string {
  /** Result of `values.get`, retained for `requiredResolved`. */
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
