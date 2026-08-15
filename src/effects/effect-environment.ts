/** Resolves external-effect handlers only from the closed environment definition. */
import type { EnvironmentConfig } from "../config/environment.js";
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ExternalEffectHandler } from "./contracts.js";
import { ExternalEffectHandlerRegistry } from "./registry.js";

export interface ResolvedExternalEffectEnvironment {
  readonly digest: string;
  readonly handlers: ExternalEffectHandlerRegistry;
  readonly settings: Readonly<Record<string, JsonObject>>;
}

export function resolveExternalEffectEnvironment(
  config: EnvironmentConfig,
  installed: readonly ExternalEffectHandler[],
): ResolvedExternalEffectEnvironment {
  const byIdentity = new Map(
    installed.map((handler) => [`${handler.kind}\0${handler.id}`, handler]),
  );
  if (byIdentity.size !== installed.length)
    throw new Error(
      "Installed external-effect handlers must have unique kind and adapter identities",
    );
  const handlers = new ExternalEffectHandlerRegistry();
  for (const [kind, adapterId] of Object.entries(config.effects.handlers).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const handler = byIdentity.get(`${kind}\0${adapterId}`);
    if (handler === undefined)
      throw new Error(
        `Configured external-effect handler is unavailable: ${kind} -> ${adapterId}`,
      );
    handlers.register(handler);
  }
  const identities = handlers.kinds().map((kind) => {
    const handler = handlers.get(kind);
    return { id: handler.id, kind, version: handler.version };
  });
  const settings = structuredClone(config.effects.settings);
  return {
    digest: digestJson(
      toJsonValue({
        environmentId: config.environmentId,
        handlers: identities,
        settings,
      }),
    ),
    handlers,
    settings,
  };
}
