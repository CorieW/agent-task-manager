// Provides the narrow, injectable HTTP boundary used by the Notion provider.
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { toJsonValue } from "../../domain/json.js";

export const NOTION_API_VERSION = "2026-03-11";

export interface NotionRequest {
  readonly body?: JsonValue;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, boolean | number | string | null>>;
  readonly signal?: AbortSignal;
}

export interface NotionTransport {
  request(request: NotionRequest): Promise<JsonObject>;
}

export interface NotionHttpTransportOptions {
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly token: string;
  readonly timeoutMilliseconds?: number;
}

export class NotionApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

export class NotionHttpTransport implements NotionTransport {
  readonly #apiVersion: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #token: string;
  readonly #timeoutMilliseconds: number;

  public constructor(options: NotionHttpTransportOptions) {
    if (options.token.trim() === "") throw new TypeError("Notion token must not be empty");
    this.#apiVersion = options.apiVersion ?? NOTION_API_VERSION;
    this.#baseUrl = (options.baseUrl ?? "https://api.notion.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#token = options.token;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds < 1) {
      throw new RangeError("Notion request timeout must be a positive integer");
    }
  }

  public async request(request: NotionRequest): Promise<JsonObject> {
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== null) url.searchParams.set(key, String(value));
    }

    const init: RequestInit = {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        "Notion-Version": this.#apiVersion,
      },
      method: request.method,
      signal: request.signal === undefined
        ? AbortSignal.timeout(this.#timeoutMilliseconds)
        : AbortSignal.any([request.signal, AbortSignal.timeout(this.#timeoutMilliseconds)]),
    };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted === true) {
        throw new NotionApiError(
          request.signal?.aborted === true ? "Notion request was aborted" : "Notion request timed out",
          0,
          request.signal?.aborted === true ? "request_aborted" : "request_timeout",
          null,
        );
      }
      throw error;
    }
    const raw: unknown = await response.json().catch(() => ({ message: "Non-JSON Notion response" }));
    const value = toJsonValue(raw);
    const object = asObject(value, "Notion response");
    if (!response.ok) {
      throw new NotionApiError(
        typeof object.message === "string" ? object.message : `Notion request failed (${response.status})`,
        response.status,
        typeof object.code === "string" ? object.code : null,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return object;
  }
}

export interface NotionPage<T extends JsonObject> {
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  readonly results: readonly T[];
}

export async function collectNotionPages<T extends JsonObject>(
  fetchPage: (cursor: string | null) => Promise<JsonObject>,
  maxResults = Number.POSITIVE_INFINITY,
): Promise<readonly T[]> {
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    if (cursor !== null && seen.has(cursor)) throw new Error("Notion pagination cursor repeated");
    if (cursor !== null) seen.add(cursor);
    const page: NotionPage<T> = parseNotionPage<T>(await fetchPage(cursor));
    results.push(...page.results);
    if (results.length > maxResults) throw new Error(`Notion pagination exceeded the ${maxResults} record scan limit`);
    if (page.has_more && page.next_cursor === null) {
      throw new Error("Notion pagination has_more response omitted next_cursor");
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor !== null);
  return results;
}

export function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function parseNotionPage<T extends JsonObject>(value: JsonObject): NotionPage<T> {
  if (!Array.isArray(value.results)) throw new TypeError("Notion list response omitted results");
  if (typeof value.has_more !== "boolean") throw new TypeError("Notion list response omitted has_more");
  const nextCursor = value.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new TypeError("Notion list response has invalid next_cursor");
  }
  return {
    has_more: value.has_more,
    next_cursor: nextCursor,
    results: value.results.map((result, index) => asObject(result, `Notion result ${index}`) as T),
  };
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
