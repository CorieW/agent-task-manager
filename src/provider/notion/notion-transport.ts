// Provides the narrow, injectable HTTP boundary used by the Notion provider.
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { toJsonValue } from "../../domain/json.js";

export const NOTION_API_VERSION = "2026-03-11";

export interface NotionRequest {
  readonly body?: JsonValue;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, boolean | number | string | null>>;
}

export interface NotionTransport {
  request(request: NotionRequest): Promise<JsonObject>;
}

export interface NotionHttpTransportOptions {
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly token: string;
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

  public constructor(options: NotionHttpTransportOptions) {
    if (options.token.trim() === "") throw new TypeError("Notion token must not be empty");
    this.#apiVersion = options.apiVersion ?? NOTION_API_VERSION;
    this.#baseUrl = (options.baseUrl ?? "https://api.notion.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#token = options.token;
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
    };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    const response = await this.#fetch(url, init);
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
): Promise<readonly T[]> {
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    if (cursor !== null && seen.has(cursor)) throw new Error("Notion pagination cursor repeated");
    if (cursor !== null) seen.add(cursor);
    const page: NotionPage<T> = parseNotionPage<T>(await fetchPage(cursor));
    results.push(...page.results);
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
