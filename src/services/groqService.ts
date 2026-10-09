/**
 * Groq Cloud inference service for the CoT Deep Review pipeline.
 *
 * Deliberately free of any `vscode` import so the module can be exercised
 * under plain Node with a mocked `fetch` (see test/groqService.test.ts).
 *
 * Responsibilities:
 *  - Strict Chain-of-Thought System/User prompt templates that force analysis
 *    of async race conditions, memory leaks (closures/event listeners), and
 *    unhandled promise rejection cascades.
 *  - Structured JSON output enforcement (executionTrace, vulnerabilityAnalysis,
 *    impactAssessment, refactoredCode).
 *  - Error handling for rate limits, network timeouts, auth failures, and
 *    JSON parsing failures.
 */

/** Groq OpenAI-compatible chat-completions endpoint. */
export const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Groq model used for the review. */
export const GROQ_MODEL = 'openai/gpt-oss-120b';

/** Default request timeout (the API typically answers in ~1-2s). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** The four mandatory JSON fields of the CoT review schema. */
export const REVIEW_FIELDS = [
  'executionTrace',
  'vulnerabilityAnalysis',
  'impactAssessment',
  'refactoredCode',
] as const;

export type ReviewField = (typeof REVIEW_FIELDS)[number];

/** Parsed, validated CoT review payload. */
export interface CoTReviewResult {
  executionTrace: string;
  vulnerabilityAnalysis: string;
  impactAssessment: string;
  refactoredCode: string;
}

export interface CoTReviewRequest {
  /** The highlighted source selection (C). */
  selectedText: string;
  /** The target language ID from the active document (L). */
  languageId: string;
  /** Groq developer API key. */
  apiKey: string;
}

export interface CoTReviewOptions {
  /** Per-request timeout in milliseconds (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type GroqErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'api'
  | 'parse'
  | 'empty';

/** Typed failure with a machine-readable kind for UI mapping. */
export class GroqServiceError extends Error {
  constructor(
    readonly kind: GroqErrorKind,
    message: string,
    readonly status?: number,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'GroqServiceError';
  }
}

/* ────────────────────────────── Prompt templates ────────────────────────── */

export const SYSTEM_PROMPT = `You are a principal-level async runtime analyst performing a deep Chain-of-Thought (CoT) code review. Before writing your final answer you reason step by step about event-loop semantics, promise scheduling, and resource lifetime for the given language.

Your review MUST specifically hunt for:
- Async race conditions: unordered promise resolution over shared mutable state, lost updates, check-then-act races, unsequenced concurrent I/O, stale data read after an await.
- Unintended concurrency in async/await loops: sequential intent executed in parallel, over-eager Promise.all/Settled, or needless serial awaits; missing in-flight request tracking.
- Unhandled promise rejection cascades: floating promises, missing try/catch around await, rejection handlers that swallow or rethrow into nothing, teardown failures masking the root cause.
- Memory leaks: closures retaining large object graphs, event listeners/timers/intervals never removed, unbounded buffers/queues, leaked subscriptions/AbortControllers, refs held after dispose.
- Ordering and lifecycle hazards: stale closures in callbacks, TOCTOU on flags, work started after dispose, promises resolving after their result became irrelevant.

STRICT OUTPUT RULES:
1. Work through the execution trace mentally first (chain-of-thought), then emit ONLY one raw JSON object as your entire response.
2. No markdown fences, no commentary, no prose before or after the JSON.
3. The object must match exactly this schema; all four keys present, all values JSON strings:
{
  "executionTrace": "Step-by-step trace of state mutations and event loop execution, including where each promise continuation runs relative to other tasks/microtasks.",
  "vulnerabilityAnalysis": "Identification of concurrency bottlenecks, race conditions, or unhandled rejections, each with its triggering sequence and severity.",
  "impactAssessment": "Architectural impact, memory footprint, and failure scenario analysis: what breaks, under what timing or load, and how far the failure spreads.",
  "refactoredCode": "Clean, refactored code block ready for replacement: complete, self-contained, preserving public signatures and exports."
}
4. refactoredCode must contain only the corrected source for the selected region (never a fenced block or prose) and must be directly usable as a drop-in replacement.`;

/** Compose the user message: target language + selection + field contract. */
export function buildUserPrompt(request: Pick<CoTReviewRequest, 'selectedText' | 'languageId'>): string {
  return `Target language: ${request.languageId}

Review the following selected code.

--- BEGIN SELECTION ---
${request.selectedText}
--- END SELECTION ---

Produce exactly the four JSON fields defined in the system instructions.
- executionTrace must be an actual tick-by-tick walk through this code (task/microtask order, each await point, each state mutation). If surrounding files are needed, state your assumptions explicitly inside executionTrace.
- refactoredCode must be the full corrected version of ONLY the selected region above, ready to paste back over the original selection.
Remember: respond with the raw JSON object only.`;
}

/* ──────────────────────── Parsing & validation ──────────────────────────── */

/** Strip fences/prose and parse the first balanced JSON object. */
function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();

  // 1. Whole response is fenced: ```json ... ```
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates: string[] = [];
  if (fenced) {
    candidates.push(fenced[1]);
  }
  candidates.push(trimmed);

  // 2. First "{" to last "}" (handles prose around the object).
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try next strategy
    }
  }
  throw new GroqServiceError(
    'parse',
    'The model response was not a parseable JSON object.',
    undefined,
    trimmed.slice(0, 400)
  );
}

/** Narrow the parsed object to the strict CoT schema. */
function validateReview(value: unknown): CoTReviewResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GroqServiceError('parse', 'The review payload is not a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const missing = REVIEW_FIELDS.filter((f) => typeof record[f] !== 'string');
  if (missing.length > 0) {
    throw new GroqServiceError(
      'parse',
      `The review payload failed schema validation (missing or non-string): ${missing.join(', ')}.`,
      undefined,
      JSON.stringify(value).slice(0, 400)
    );
  }
  const refactoredCode = (record.refactoredCode as string).trim();
  if (!refactoredCode) {
    throw new GroqServiceError('parse', 'The review payload contained no refactored code.');
  }
  return {
    executionTrace: record.executionTrace as string,
    vulnerabilityAnalysis: record.vulnerabilityAnalysis as string,
    impactAssessment: record.impactAssessment as string,
    refactoredCode: record.refactoredCode as string,
  };
}

/* ──────────────────────────── Inference call ────────────────────────────── */

/** Map a fetch/reader rejection to timeout vs network. */
function mapFetchRejection(err: unknown, aborted: boolean, timeoutMs: number): GroqServiceError {
  const name = err instanceof Error ? err.name : '';
  if (aborted || name === 'AbortError' || name === 'TimeoutError') {
    return new GroqServiceError(
      'timeout',
      `Groq request timed out after ${timeoutMs}ms. The API may be overloaded — retry shortly.`
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new GroqServiceError('network', `Could not reach the Groq API: ${message}`);
}

/**
 * Run the Chain-of-Thought deep review against the Groq API.
 *
 * @throws {GroqServiceError} with kind:
 *   'auth'       → 401/403 invalid or revoked API key
 *   'rate-limit' → 429 (message includes Retry-After when provided)
 *   'timeout'    → no response within timeoutMs
 *   'network'    → DNS/connection failure
 *   'api'        → other non-2xx or malformed API envelope
 *   'parse'      → response content failed JSON extraction/schema validation
 *   'empty'      → 200 with no usable message content
 */
export async function runCoTReview(
  request: CoTReviewRequest,
  options: CoTReviewOptions = {}
): Promise<CoTReviewResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(request) },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw mapFetchRejection(err, controller.signal.aborted, timeoutMs);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        throw new GroqServiceError(
          'auth',
          'Groq rejected the API key (invalid or revoked). Update cotReviewer.groqApiKey.',
          response.status
        );
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new GroqServiceError(
          'rate-limit',
          retryAfter
            ? `Groq rate limit hit — retry after ${retryAfter}s.`
            : 'Groq rate limit hit — wait a moment and retry.',
          response.status,
          text.slice(0, 400)
        );
      }
      throw new GroqServiceError(
        'api',
        `Groq API error (HTTP ${response.status}).`,
        response.status,
        text.slice(0, 400)
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw mapFetchRejection(err, controller.signal.aborted, timeoutMs);
    }

    const envelope = payload as { choices?: unknown; error?: { message?: unknown } };
    if (!Array.isArray(envelope.choices) || envelope.choices.length === 0) {
      const apiMessage =
        envelope.error && typeof envelope.error.message === 'string'
          ? envelope.error.message
          : undefined;
      throw new GroqServiceError(
        'empty',
        apiMessage ? `Groq returned no choices: ${apiMessage}` : 'Groq returned no choices.',
        undefined,
        JSON.stringify(payload).slice(0, 400)
      );
    }

    const message = (
      envelope.choices as Array<{ message?: { content?: unknown } }>
    )[0]?.message;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!content) {
      throw new GroqServiceError('empty', 'Groq returned an empty message content.');
    }

    return validateReview(extractJsonObject(content));
  } finally {
    clearTimeout(timer);
  }
}
