/** Provides the single-attempt, deadline-bound HTTP boundary used by the Notion provider. */
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { toJsonValue } from "../../domain/json.js";

/** Defines the module-level `NOTION_API_VERSION` value. */
export const NOTION_API_VERSION = "2026-03-11";

/** Defines Notion request. */
export interface NotionRequest {
  /** Optionally contains body for Notion request. */
  readonly body?: JsonValue;
  /** Contains method for Notion request. */
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  /** Contains path for Notion request. */
  readonly path: string;
  /** Optionally contains query for Notion request. */
  readonly query?: Readonly<Record<string, boolean | number | string | null>>;
  /** Optionally contains signal for Notion request. */
  readonly signal?: AbortSignal;
}

/** Defines Notion transport. */
export interface NotionTransport {
  /** Executes one provider request. */
  request(request: NotionRequest): Promise<JsonObject>;
}

/** Defines Notion HTTP transport options. */
export interface NotionHttpTransportOptions {
  /** Selects the Notion API version. */
  readonly apiVersion?: string;
  /** Optionally contains base URL for Notion HTTP transport options. */
  readonly baseUrl?: string;
  /** Optionally contains fetch for Notion HTTP transport options. */
  readonly fetch?: typeof fetch;
  /** Contains token for Notion HTTP transport options. */
  readonly token: string;
  /** Optionally sets timeout in milliseconds for Notion HTTP transport options. */
  readonly timeoutMilliseconds?: number;
}

/** Represents a Notion API failure. */
export class NotionApiError extends Error {
  /** Initializes Notion API error. */
  public constructor(
    message: string,
    /** Records the status for Notion API error. */ public readonly status: number,
    /** Contains code for Notion API error. */ public readonly code:
      string | null,
    /** Contains Retry-After seconds when supplied by Notion. */ public readonly retryAfterSeconds:
      number | null,
  ) {
    super(message);
  }
}

/** Implements Notion HTTP transport. */
export class NotionHttpTransport implements NotionTransport {
  /** Contains API version for Notion HTTP transport. */
  readonly #apiVersion: string;
  /** Contains base URL for Notion HTTP transport. */
  readonly #baseUrl: string;
  /** Contains fetch for Notion HTTP transport. */
  readonly #fetch: typeof fetch;
  /** Contains token for Notion HTTP transport. */
  readonly #token: string;
  /** Sets timeout in milliseconds for Notion HTTP transport. */
  readonly #timeoutMilliseconds: number;

  /** Initializes Notion HTTP transport. */
  public constructor(options: NotionHttpTransportOptions) {
    if (options.token.trim() === "")
      throw new TypeError("Notion token must not be empty");
    this.#apiVersion = options.apiVersion ?? NOTION_API_VERSION;
    this.#baseUrl = (options.baseUrl ?? "https://api.notion.com").replace(
      /\/$/u,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
    this.#token = options.token;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    if (
      !Number.isSafeInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds < 1
    ) {
      throw new RangeError("Notion request timeout must be a positive integer");
    }
  }

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    /** Holds the `url` intermediate used by `request`. */
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== null) url.searchParams.set(key, String(value));
    }

    /** Holds the `init` intermediate used by `request`. */
    const init: RequestInit = {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        "Notion-Version": this.#apiVersion,
      },
      method: request.method,
      signal:
        request.signal === undefined
          ? AbortSignal.timeout(this.#timeoutMilliseconds)
          : AbortSignal.any([
              request.signal,
              AbortSignal.timeout(this.#timeoutMilliseconds),
            ]),
    };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    /** Captures `response` returned by `request`. */
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted === true) {
        throw new NotionApiError(
          request.signal?.aborted === true
            ? "Notion request was aborted"
            : "Notion request timed out",
          0,
          request.signal?.aborted === true
            ? "request_aborted"
            : "request_timeout",
          null,
        );
      }
      throw error;
    }
    /** Holds the `raw` intermediate used by `request`. */
    const raw: unknown = await response
      .json()
      .catch(() => ({ message: "Non-JSON Notion response" }));
    /** Holds the `value` intermediate used by `request`. */
    const value = toJsonValue(raw);
    /** Holds the `object` intermediate used by `request`. */
    const object = asObject(value, "Notion response");
    if (!response.ok) {
      throw new NotionApiError(
        typeof object.message === "string"
          ? object.message
          : `Notion request failed (${response.status})`,
        response.status,
        typeof object.code === "string" ? object.code : null,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return object;
  }
}

/** Defines Notion page. */
export interface NotionPage<T extends JsonObject> {
  /** Reports whether has more. */
  readonly has_more: boolean;
  /** Contains next cursor for Notion page. */
  readonly next_cursor: string | null;
  /** Contains results for Notion page. */
  readonly results: readonly T[];
}

/** Collects Notion pages. */
export async function collectNotionPages<T extends JsonObject>(
  fetchPage: (cursor: string | null) => Promise<JsonObject>,
  maxResults = Number.POSITIVE_INFINITY,
): Promise<readonly T[]> {
  /** Holds the `results` intermediate used by `collectNotionPages`. */
  const results: T[] = [];
  /** Tracks unique entries in `seen` for `collectNotionPages`. */
  const seen = new Set<string>();
  /** Holds the `cursor` intermediate used by `collectNotionPages`. */
  let cursor: string | null = null;
  do {
    if (cursor !== null && seen.has(cursor))
      throw new Error("Notion pagination cursor repeated");
    if (cursor !== null) seen.add(cursor);
    /** Holds the `page` intermediate used by `collectNotionPages`. */
    const page: NotionPage<T> = parseNotionPage<T>(await fetchPage(cursor));
    results.push(...page.results);
    if (results.length > maxResults)
      throw new Error(
        `Notion pagination exceeded the ${maxResults} record scan limit`,
      );
    if (page.has_more && page.next_cursor === null) {
      throw new Error(
        "Notion pagination has_more response omitted next_cursor",
      );
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor !== null);
  return results;
}

/** Returns a validated JSON object. */
export function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

/** Parses and validates Notion page. */
function parseNotionPage<T extends JsonObject>(
  value: JsonObject,
): NotionPage<T> {
  if (!Array.isArray(value.results))
    throw new TypeError("Notion list response omitted results");
  if (typeof value.has_more !== "boolean")
    throw new TypeError("Notion list response omitted has_more");
  /** Holds the `nextCursor` intermediate used by `parseNotionPage`. */
  const nextCursor = value.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== "string") {
    throw new TypeError("Notion list response has invalid next_cursor");
  }
  return {
    has_more: value.has_more,
    next_cursor: nextCursor,
    results: value.results.map(
      (result, index) => asObject(result, `Notion result ${index}`) as T,
    ),
  };
}

/** Parses and validates retry after. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  /** Holds the `seconds` intermediate used by `parseRetryAfter`. */
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
