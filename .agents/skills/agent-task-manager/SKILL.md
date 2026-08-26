---
name: agent-task-manager
description: Operate Agent Task Manager as a trusted external harness by inspecting configured Tasks, Agents, and Resources and managing Active Agent lifecycles, task-section writes, heartbeats, retries, errors, and human checkpoints. Use when a repository provides agent-task-manager configuration or the user asks to run, diagnose, or integrate an agent-task-manager workflow. Do not use for ordinary task tracking that does not use this CLI.
---

# Agent Task Manager

Use the CLI as the trusted harness-side control boundary. Agent Task Manager validates and persists coordination state; it does not run models, own conversations, execute tools, manage repositories, or authorize external effects.

This skill applies to a trusted controller or harness regardless of its underlying model provider. Do not inject it into an ordinary managed Active Agent; managed Agents must follow the system prompt and Resources returned for their run. A model should receive this skill only when that model is itself operating the trusted harness.

## Prepare

- Locate the configuration through `AGENT_TASK_MANAGER_ENVIRONMENT` or the repository default. Preserve existing environment variables and never print secrets.
- Read [Configuration and CLI](../../../docs/getting-started.md) when configuring providers, lifecycle hooks, task sections, or resources.
- Read [Lifecycle and harness contract](../../../docs/lifecycle.md) before changing a harness, command broker, locks, leases, or recovery behavior.
- Read [Notion provider](../../../docs/notion-provider.md) when working with Notion-backed schemas or field mappings.
- Run `agent-task-manager validate` and inspect its JSON result before starting work.
- Identify the explicit Task and Agent. Do not select or mutate a different Task without authority from the user or returned lifecycle state.

## Run a Lifecycle

1. Fetch the Task, Agent, and Resources. Check dependency state plus the Agent's task-type, status, resource, and transition constraints.
2. Start with stable, unique run and harness IDs. Supply the parent run ID for a child. Treat the returned Task, Agent projection, Resources, system prompt, and working directory as authoritative. Repeating an identical start replays the same run; after an ambiguous timeout, query state before starting again.
3. Follow the returned prompt, policies, capabilities, and allowed transitions. Work only in the returned working directory.
4. Send heartbeats more frequently than the five-minute stale threshold, including while awaiting human input.
5. Write only sections authorized for the Active Agent. Pass the section body without level-one or level-two headings to `active-agent update-task-section`. The manager performs an exact-body compare-and-swap; require its returned current Task as proof of success.
6. Resolve running descendants before a terminal operation. Complete only with a declared outcome; use failure only for an actual run failure. After a transport timeout, inspect the Active Agent and Task before retrying.
7. Restart failed or stale subtrees through the lifecycle command instead of reconstructing conversations. The third failure for a retry key creates an Error that requires human resolution.

## Enforce Boundaries

- Invoke trusted harness lifecycle operations directly through the CLI.
- Route Agent-requested operating-system commands exclusively through `command proxy`. The harness, outside Agent-controlled arguments, must inject `AGENT_TASK_MANAGER_COMMAND_RUN_ID` and `AGENT_TASK_MANAGER_COMMAND_HARNESS_ID`. Never let an Agent choose its run identity or environment file.
- Treat returned capabilities as constraints, not authorization for GitHub, Notion, or other external mutations. Confirm user and human-checkpoint authority immediately before a material external action.
- Treat external effects as at-least-once. Make operations idempotent and read current external state before retrying an ambiguous mutation.
- Never place tokens or credentials in Task content, Resources, logs, errors, documentation, or command output.

## Handle Working Directories and Bootstrap

- Use the returned working directory and verify its repository, branch, and path before editing.
- A lifecycle hook may create a worktree without installing dependencies or generating artifacts. Inspect repository conventions when bootstrap state is missing.
- Fix bootstrap gaps with trusted repository commands or idempotent lifecycle hooks. Do not hard-code platform-specific junctions or change product code merely to compensate for harness setup.

## Recover Safely

- Expect environment mutations to be serialized by the coordination mutex. Command leases may outlive that mutex.
- When a CLI operation times out or a lock appears occupied, query state and wait for evidence; do not delete locks blindly.
- Remove an orphaned command lease only after independently proving that broker containment has stopped.
- Distinguish provider, network, harness, repository, and Agent failures from an Agent Task Manager defect. Reproduce and isolate the failing layer before editing or rebuilding the package.

## Collect Completion Evidence

Before reporting success, confirm the relevant evidence:

- current Task status and required section content;
- terminal Active Agent record and descendant state;
- external identifiers such as a pull-request URL or commit SHA, when applicable;
- validation, build, and test results required by the task; and
- unresolved Errors or human checkpoints.

Report failures by layer and include the command or lifecycle stage that exposed them. Leave repository edits uncommitted unless the user asks for a commit.

## CLI Quick Reference

All commands emit JSON. Use IDs and values returned by earlier commands rather than guessing them.

```text
agent-task-manager validate
agent-task-manager providers
agent-task-manager task list
agent-task-manager task get --id <task-id>
agent-task-manager agent list
agent-task-manager agent get --key <agent-key>
agent-task-manager resource list
agent-task-manager resource get --key <resource-key>

agent-task-manager active-agent start --run-id <run-id> --task-id <task-id> --agent-key <agent-key> --harness-id <harness-id>
agent-task-manager active-agent get --run-id <run-id>
agent-task-manager active-agent heartbeat --run-id <run-id> --harness-id <harness-id>
agent-task-manager active-agent update-task-section --run-id <run-id> --harness-id <harness-id> --section <section> --input <file-or->
agent-task-manager active-agent complete --run-id <run-id> --harness-id <harness-id> --outcome <outcome>
agent-task-manager active-agent fail --run-id <run-id> --harness-id <harness-id> --summary <summary>
agent-task-manager active-agent sweep
agent-task-manager active-agent restart --restart-of-run-id <old-run-id> --run-id <new-run-id> --harness-id <harness-id>

agent-task-manager command proxy -- <command> [args...]
agent-task-manager error list
agent-task-manager error get --key <error-key>
agent-task-manager error report --input <file-or->
agent-task-manager error resolve --key <error-key> --resolution <resolution>

agent-task-manager init --plan
agent-task-manager init --apply --expected-plan-digest <sha256>
```

Consult `--help` for the installed version's exact required flags before issuing a mutation.
