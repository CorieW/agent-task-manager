// Resolves exactly one trusted handler for each provider-defined intent kind.
import type { ExternalEffectHandler } from "./contracts.js";

export class ExternalEffectHandlerRegistry {
  readonly #handlers = new Map<string, ExternalEffectHandler>();

  public register(handler: ExternalEffectHandler): void {
    if (handler.id === "" || handler.kind === "" || handler.version === "") throw new TypeError("External-effect handler identity is required");
    if (this.#handlers.has(handler.kind)) throw new Error(`External-effect handler already exists for ${handler.kind}`);
    this.#handlers.set(handler.kind, handler);
  }

  public get(kind: string): ExternalEffectHandler {
    const handler = this.#handlers.get(kind);
    if (handler === undefined) throw new Error(`External-effect handler is unavailable: ${kind}`);
    return handler;
  }

  public kinds(): readonly string[] { return [...this.#handlers.keys()].sort(); }
}
