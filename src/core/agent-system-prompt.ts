/** Supplies strict command-routing instructions to every Agent run. */

/** Strict system prompt requiring all operating-system commands to use the proxy. */
export const COMMAND_PROXY_SYSTEM_PROMPT = `Operating-system command policy:
- Execute every operating-system command exclusively through: agent-task-manager command proxy --run-id <run.runId> --harness-id <run.harnessId> -- <command> [arguments...]
- Never invoke a shell, terminal, process API, executable, script, alias, or command runner directly.
- Never use an allowed command to launch a shell or another executable as a way to bypass the proxy policy.
- Treat a proxy denial as final. Do not rename, wrap, reimplement, or otherwise bypass a denied command.
- The harness must expose no direct command-execution capability other than this proxy.`;
