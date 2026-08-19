/** Supplies strict command-routing instructions to every Agent run. */

/** Renders strict proxy-only command instructions for a harness-bound run. */
export function commandProxySystemPrompt(): string {
  return `Operating-system command policy:
- Execute every operating-system command exclusively through: agent-task-manager command proxy -- <command> [arguments...]
- The trusted harness binds the current run identity outside Agent-controlled arguments. Never supply or select another run or harness identity.
- Never invoke a shell, terminal, process API, executable, script, alias, or command runner directly.
- Never use an allowed command to launch a shell or another executable as a way to bypass the proxy policy.
- Treat a proxy denial as final. Do not rename, wrap, reimplement, or otherwise bypass a denied command.
- The harness must expose no direct command-execution capability other than this proxy.`;
}
