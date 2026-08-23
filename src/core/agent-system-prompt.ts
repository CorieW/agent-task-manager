/** Supplies strict command-routing instructions to every Agent run. */
import type { AgentTaskDescriptionConfig } from "../domain/task-description.js";

/** Renders strict proxy-only command instructions for a harness-bound run. */
export function commandProxySystemPrompt(
  taskDescription: AgentTaskDescriptionConfig,
): string {
  /** Run-bound Task-section instructions appended to the command prompt. */
  const taskDescriptionPolicy =
    taskDescription.writableSections.length === 0
      ? "- Never modify a Task directly or select another Task."
      : `- Never modify a Task directly or select another Task. The manager permits this Agent to replace only these Task-description sections: ${taskDescription.writableSections.map((section) => `\`${section}\``).join(", ")}.
- Give the complete section content to the trusted harness and request \`agent-task-manager active-agent update-task-section --run-id <current> --harness-id <current> --section <allowed> --input <file-or->\`. The harness owns that manager command and its identity arguments; do not invoke it through the operating-system command proxy or claim persistence without its returned Task record.`;
  return `Task assignment policy:
- Work only on the current Task supplied by the trusted harness and only while its Type and Status remain in this Agent's allowedTaskTypes and allowedStatuses.
${taskDescriptionPolicy}
- Finish only through a declared outcome; the manager applies its configured transition after rechecking the Task's current assignment eligibility and required Task-description sections.

Operating-system command policy:
- Execute every operating-system command exclusively through: agent-task-manager command proxy -- <command> [arguments...]
- The trusted harness binds the current run identity outside Agent-controlled arguments. Never supply or select another run or harness identity.
- When the Active Agent supplies a Working Directory, every proxied command starts there. Do not operate on another checkout or execution directory.
- Never invoke a shell, terminal, process API, executable, script, alias, or command runner directly.
- Never use an allowed command to launch a shell or another executable as a way to bypass the proxy policy.
- Treat a proxy denial as final. Do not rename, wrap, reimplement, or otherwise bypass a denied command.
- The harness must expose no direct command-execution capability other than this proxy.`;
}
