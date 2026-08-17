/** Resolves external-effect handlers only from the closed environment definition. */
import type { EnvironmentConfig } from "../config/environment.js";
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ExternalEffectHandler } from "./contracts.js";
import { ExternalEffectHandlerRegistry } from "./registry.js";

/** Trusted dependencies available to resolved external effect. */
export interface ResolvedExternalEffectEnvironment {
  /** SHA-256 digest binding the canonical content. */
  readonly digest: string;
  /** Handler registry keyed by effect kind. */
  readonly handlers: ExternalEffectHandlerRegistry;
  /** Validated settings for the selected effect kind. */
  readonly settings: Readonly<Record<string, JsonObject>>;
}

/** Resolves external effect environment from trusted configuration. */
export function resolveExternalEffectEnvironment(
  config: EnvironmentConfig,
  installed: readonly ExternalEffectHandler[],
): ResolvedExternalEffectEnvironment {
  /** Indexes by identity for deterministic lookup by resolve external effect environment. */
  const byIdentity = new Map(
    installed.map((handler) => [`${handler.kind}\0${handler.id}`, handler]),
  );
  if (byIdentity.size !== installed.length)
    throw new Error(
      "Installed external-effect handlers must have unique kind and adapter identities",
    );
  /** Stores handlers used by resolve external effect environment. */
  const handlers = new ExternalEffectHandlerRegistry();
  for (const [kind, adapterId] of Object.entries(config.effects.handlers).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    /** Stores handler used by resolve external effect environment. */
    const handler = byIdentity.get(`${kind}\0${adapterId}`);
    if (handler === undefined)
      throw new Error(
        `Configured external-effect handler is unavailable: ${kind} -> ${adapterId}`,
      );
    handlers.register(handler);
  }
  /** Stores identities used by resolve external effect environment. */
  const identities = handlers.kinds().map((kind) => {
    /** Stores handler used by resolve external effect environment. */
    const handler = handlers.get(kind);
    return { id: handler.id, kind, version: handler.version };
  });
  /** Stores settings used by resolve external effect environment. */
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
