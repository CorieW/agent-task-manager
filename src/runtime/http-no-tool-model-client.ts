/** Invokes a trusted HTTPS model gateway without exposing tools or credentials to Agent code. */
import type { NoToolModelClient } from "./no-tool-adapters.js";

/** Configuration for the direct no-tool model gateway. */
export interface HttpNoToolModelClientOptions {
  /** Bearer credential retained only by the control-plane client. */
  readonly bearerToken: string;
  /** HTTPS endpoint accepting the closed model request body. */
  readonly endpoint: string;
  /** Optional fetch implementation used by constrained hosts and tests. */
  readonly fetch?: typeof fetch;
}

/** Streams a model gateway response through the existing no-tool runtime. */
export class HttpNoToolModelClient implements NoToolModelClient {
  /** Parsed and normalized gateway endpoint. */
  readonly #endpoint: URL;
  /** Fetch boundary used for the direct control-plane call. */
  readonly #fetch: typeof fetch;
  /** Bearer credential never included in the model request body. */
  readonly #token: string;

  /** Creates a single-attempt HTTPS model client. */
  public constructor(options: HttpNoToolModelClientOptions) {
    if (options.bearerToken === "")
      throw new TypeError("Model gateway bearer token is required");
    this.#endpoint = new URL(options.endpoint);
    if (this.#endpoint.protocol !== "https:")
      throw new TypeError("Model gateway endpoint must use HTTPS");
    if (this.#endpoint.username !== "" || this.#endpoint.password !== "")
      throw new TypeError(
        "Model gateway endpoint must not contain credentials",
      );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#token = options.bearerToken;
  }

  /** Sends one closed request and yields the raw Agent-result response bytes. */
  public async *stream(
    input: Parameters<NoToolModelClient["stream"]>[0],
  ): AsyncIterable<Uint8Array> {
    const response = await this.#fetch(this.#endpoint, {
      body: JSON.stringify({
        context: input.context,
        model: input.model,
        outputLimitBytes: input.outputLimitBytes,
        outputSchema: input.outputSchema,
        reasoning: input.reasoning,
        schema: "agent-model-request-v1",
      }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Model gateway request failed with status ${response.status}`,
      );
    }
    if (response.body === null)
      throw new Error("Model gateway response body is missing");
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        yield chunk.value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
