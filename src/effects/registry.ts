/** Resolves exactly one trusted handler for each provider-defined intent kind. */
import type { ExternalEffectHandler } from "./contracts.js";

/** Implements external effect handler registry and its boundary checks. */
export class ExternalEffectHandlerRegistry {
  /** Handler registry keyed by effect kind. */
  readonly #handlers = new Map<string, ExternalEffectHandler>();

  /** Registers one uniquely identified adapter. */
  public register(handler: ExternalEffectHandler): void {
    if (handler.id === "" || handler.kind === "" || handler.version === "")
      throw new TypeError("External-effect handler identity is required");
    if (this.#handlers.has(handler.kind))
      throw new Error(
        `External-effect handler already exists for ${handler.kind}`,
      );
    this.#handlers.set(handler.kind, handler);
  }

  /** Returns the handler registered for an exact effect kind. */
  public get(kind: string): ExternalEffectHandler {
    /** Stores handler used by get. */
    const handler = this.#handlers.get(kind);
    if (handler === undefined)
      throw new Error(`External-effect handler is unavailable: ${kind}`);
    return handler;
  }

  /** Returns registered effect kinds in deterministic order. */
  public kinds(): readonly string[] {
    return [...this.#handlers.keys()].sort();
  }
}
