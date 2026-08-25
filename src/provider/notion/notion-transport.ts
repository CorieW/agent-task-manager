/** The single-attempt, deadline-bound HTTP boundary used by the Notion provider. */
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { toJsonValue } from "../../domain/json.js";

/** Pinned Notion API version sent with every request. */
export const NOTION_API_VERSION = "2026-03-11";

/** Inputs accepted by Notion. */
export interface NotionRequest {
  /** Optionally contains body for Notion request. */
  readonly body?: JsonValue;
  /** HTTP method used for the provider request. */
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  /** Provider-relative API path, including its leading slash. */
  readonly path: string;
  /** Optionally contains query for Notion request. */
  readonly query?: Readonly<Record<string, boolean | number | string | null>>;
  /** Optionally contains signal for Notion request. */
  readonly signal?: AbortSignal;
}

/** Provider-neutral Notion transport contract. */
export interface NotionTransport {
  /** Executes one provider request. */
  request(request: NotionRequest): Promise<JsonObject>;
}

/** Validates a complete page-Markdown response and returns normalized content. */
export function decodeCompletePageMarkdown(
  response: JsonObject,
  messages: {
    /** Error for absent or malformed completeness metadata. */
    readonly invalidMetadata: string;
    /** Error for a response known to omit page content. */
    readonly incomplete: string;
    /** TypeError for a non-string Markdown field. */
    readonly invalidMarkdown: string;
  },
): string {
  if (
    typeof response.truncated !== "boolean" ||
    !Array.isArray(response.unknown_block_ids) ||
    !response.unknown_block_ids.every((id) => typeof id === "string")
  )
    throw new Error(messages.invalidMetadata);
  if (response.truncated || response.unknown_block_ids.length !== 0)
    throw new Error(messages.incomplete);
  if (typeof response.markdown !== "string")
    throw new TypeError(messages.invalidMarkdown);
  return response.markdown.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** Inputs accepted by Notion HTTP transport. */
export interface NotionHttpTransportOptions {
  /** Selects the Notion API version. */
  readonly apiVersion?: string;
  /** Optionally contains base URL for Notion HTTP transport options. */
  readonly baseUrl?: string;
  /** Optionally contains fetch for Notion HTTP transport options. */
  readonly fetch?: typeof fetch;
  /** Secret bearer token used for Notion requests. */
  readonly token: string;
  /** Optionally sets timeout in milliseconds for Notion HTTP transport options. */
  readonly timeoutMilliseconds?: number;
}

/** Represents a Notion API failure. */
export class NotionApiError extends Error {
  /** Initializes Notion API error. */
  public constructor(
    message: string,
    /** HTTP response status, or zero for a local timeout/abort. */ public readonly status: number,
    /** Machine-readable outcome or failure code. */ public readonly code:
      string | null,
    /** Retry-After seconds when supplied by Notion. */ public readonly retryAfterSeconds:
      number | null,
  ) {
    super(message);
  }
}

/** Sends authenticated Notion API requests and decodes strict JSON responses. */
export class NotionHttpTransport implements NotionTransport {
  /** Notion API version sent with every request. */
  readonly #apiVersion: string;
  /** Base URL of the Notion API. */
  readonly #baseUrl: string;
  /** HTTP implementation used by the Notion transport. */
  readonly #fetch: typeof fetch;
  /** Secret bearer token used for Notion requests. */
  readonly #token: string;
  /** Request timeout in milliseconds for Notion HTTP transport. */
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
    /** Absolute request URL with all non-null query parameters applied. */
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== null) url.searchParams.set(key, String(value));
    }

    /** Fetch options that enforce authentication, API versioning, and timeout. */
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
    /** Untrusted response payload before strict JSON conversion. */
    const raw: unknown = await response
      .json()
      .catch(() => ({ message: "Non-JSON Notion response" }));
    /** Strict JSON response shared by success and error handling. */
    const value = toJsonValue(raw);
    /** Strict JSON object shared by success and provider-error handling. */
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

/** Provider-neutral Notion page contract. */
export interface NotionPage<T extends JsonObject> {
  /** Whether Notion has another result page after this response. */
  readonly has_more: boolean;
  /** Cursor required to request the next page, or null at completion. */
  readonly next_cursor: string | null;
  /** Ordered records returned by this page. */
  readonly results: readonly T[];
}

/** Collects Notion pages. */
export async function collectNotionPages<T extends JsonObject>(
  fetchPage: (cursor: string | null) => Promise<JsonObject>,
  maxResults = Number.POSITIVE_INFINITY,
): Promise<readonly T[]> {
  /** Records accumulated in provider page order. */
  const results: T[] = [];
  /** Tracks unique entries in `seen` for `collectNotionPages`. */
  const seen = new Set<string>();
  /** Cursor requested next, or null before the first and after the final page. */
  let cursor: string | null = null;
  do {
    if (cursor !== null && seen.has(cursor))
      throw new Error("Notion pagination cursor repeated");
    if (cursor !== null) seen.add(cursor);
    /** Strictly validated page returned for the current cursor. */
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
  /** Untrusted continuation cursor validated before it crosses the boundary. */
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
  /** Numeric retry delay accepted only when finite and non-negative. */
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
