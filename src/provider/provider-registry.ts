/** Resolves provider implementations from trusted environment type identifiers. */
import type { ProviderEnvironment } from "../domain/provider.js";
import type { AgentTaskProvider } from "./agent-task-provider.js";

/** Defines the supported provider factory representation. */
export type ProviderFactory = (
  environment: ProviderEnvironment,
) => AgentTaskProvider;

/** Implements provider registry. */
export class ProviderRegistry {
  /** Contains factories for provider registry. */
  readonly #factories = new Map<string, ProviderFactory>();

  /** Registers one provider factory under a unique type identifier. */
  public register(type: string, factory: ProviderFactory): void {
    if (type.trim() === "")
      throw new TypeError("Provider type cannot be empty");
    if (this.#factories.has(type))
      throw new Error(`Provider already registered: ${type}`);
    this.#factories.set(type, factory);
  }

  /** Creates the provider selected by the environment type. */
  public create(environment: ProviderEnvironment): AgentTaskProvider {
    /** Holds the `factory` intermediate used by `create`. */
    const factory = this.#factories.get(environment.type);
    if (factory === undefined) {
      throw new Error(`Provider is not registered: ${environment.type}`);
    }
    return factory(environment);
  }

  /** Lists registered provider types in deterministic order. */
  public list(): readonly string[] {
    return [...this.#factories.keys()].sort();
  }
}
