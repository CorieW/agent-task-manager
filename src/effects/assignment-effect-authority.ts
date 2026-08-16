/** Revalidates live role, assignment, Task, and lease authority before each effect. */
import type { ActivatedDefinition } from "../core/definition-activation.js";
import type {
  ActivationRuntime,
  AssignmentPromotion,
} from "../core/selection-coordinator.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { verifyLiveAssignment } from "../runtime/dispatcher.js";
import type {
  ExternalEffectAuthorityVerifier,
  ExternalEffectRequest,
} from "./contracts.js";

/** Implements assignment effect authority and its boundary checks. */
export class AssignmentEffectAuthority implements ExternalEffectAuthorityVerifier {
  /** Creates assignment effect authority with its required collaborators. */
  public constructor(
    /** Activated dependency consumed by assignment effect authority. */ private readonly activated: ActivatedDefinition,
    /** Activation runtime dependency consumed by assignment effect authority. */ private readonly activationRuntime: ActivationRuntime,
    /** Promotion dependency consumed by assignment effect authority. */ private readonly promotion: AssignmentPromotion,
    /** Provider boundary used for durable state reads and writes. */ private readonly provider: AgentTaskProvider,
  ) {}
  /** Verifies live assignment authority for an external-effect request. */
  public async verify(request: ExternalEffectRequest): Promise<void> {
    if (
      request.source.runId !== this.promotion.ownerId ||
      request.source.definitionDigest !== this.activated.resolved.digest ||
      !this.activated.grant.allowedIntents.includes(request.kind)
    )
      throw new Error(
        "External effect does not match its assigned role authority",
      );
    await verifyLiveAssignment({
      activated: this.activated,
      activationRuntime: this.activationRuntime,
      promotion: this.promotion,
      provider: this.provider,
    });
  }
}
