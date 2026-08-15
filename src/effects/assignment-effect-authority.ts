/** Revalidates live role, assignment, Task, and lease authority before each effect. */
import type { ActivatedDefinition } from "../core/definition-activation.js";
import type { ActivationRuntime, AssignmentPromotion } from "../core/selection-coordinator.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { verifyLiveAssignment } from "../runtime/dispatcher.js";
import type { ExternalEffectAuthorityVerifier, ExternalEffectRequest } from "./contracts.js";

export class AssignmentEffectAuthority implements ExternalEffectAuthorityVerifier {
  public constructor(
    private readonly activated: ActivatedDefinition,
    private readonly activationRuntime: ActivationRuntime,
    private readonly promotion: AssignmentPromotion,
    private readonly provider: AgentTaskProvider,
  ) {}
  public async verify(request: ExternalEffectRequest): Promise<void> {
    if (request.source.runId !== this.promotion.ownerId || request.source.definitionDigest !== this.activated.resolved.digest || !this.activated.grant.allowedIntents.includes(request.kind)) throw new Error("External effect does not match its assigned role authority");
    await verifyLiveAssignment({ activated: this.activated, activationRuntime: this.activationRuntime, promotion: this.promotion, provider: this.provider });
  }
}
