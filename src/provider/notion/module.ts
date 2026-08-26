/** Agent Task Manager provider-module entry point for Notion. */
import {
  AGENT_TASK_PROVIDER_MODULE_SCHEMA,
  type AgentTaskProviderModule,
} from "../provider-module.js";
import { parseNotionProviderOptions } from "./notion-environment.js";
import { NotionProvider } from "./notion-provider.js";
import { NotionHttpTransport } from "./notion-transport.js";

/** Dynamically loadable Notion provider adapter. */
export const agentTaskProviderModule: AgentTaskProviderModule = {
  /** Creates a Notion provider after resolving adapter-owned configuration and credentials. */
  async create(context) {
    /** Strict Notion settings decoded from opaque provider configuration. */
    const options = parseNotionProviderOptions(context.options);
    /** Host variable whose value is used as the Notion bearer token. */
    const tokenVariable =
      typeof options.connection.tokenEnv === "string"
        ? options.connection.tokenEnv
        : "NOTION_TOKEN";
    /** Secret resolved only inside the selected provider adapter. */
    const token = context.environmentVariables[tokenVariable];
    if (token === undefined || token.trim() === "")
      throw new Error(`Missing Notion token in ${tokenVariable}`);
    return new NotionProvider(options, new NotionHttpTransport({ token }));
  },
  schema: AGENT_TASK_PROVIDER_MODULE_SCHEMA,
  type: "notion",
};
