/**
 * Unit tests for src/services/groqService.ts — run under plain Node with an
 * injected mock fetch (no network, no VS Code).
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import {
  GROQ_ENDPOINT,
  GROQ_MODEL,
  GroqServiceError,
  SYSTEM_PROMPT,
  buildUserPrompt,
  runCoTReview,
} from '../src/services/groqService';

const BASE_REQUEST = {
  selectedText: 'async function load() { const a = await fetchA(); const b = await fetchB(); return a + b; }',
  languageId: 'typescript',
  apiKey: 'gsk_test_key',
};

const GOOD_REVIEW = {
  executionTrace: '1. call fetchA…',
  vulnerabilityAnalysis: 'Race: await order not guaranteed…',
  impactAssessment: 'Stale UI under concurrency…',
  refactoredCode: 'async function load() { const [a, b] = await Promise.all([fetchA(), fetchB()]); return a + b; }',
};

function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function chatBody(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

interface Captured {
  url?: string;
  auth?: string | null;
  payload?: Record<string, unknown>;
}

type Case = { name: string; run: () => Promise<void> };

const cases: Case[] = [
  {
    name: 'success: fenced JSON parses into the 4-field schema with correct request envelope',
    run: async () => {
      const captured: Captured = {};
      const result = await runCoTReview(BASE_REQUEST, {
        fetchImpl: (url, init) => {
          captured.url = String(url);
          captured.auth = init?.headers ? (init.headers as Record<string, string>)['Authorization'] : null;
          captured.payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Promise.resolve(
            jsonReply(200, chatBody('```json\n' + JSON.stringify(GOOD_REVIEW) + '\n```'))
          );
        },
      });
      assert.equal(captured.url, GROQ_ENDPOINT);
      assert.equal(captured.auth, 'Bearer gsk_test_key');
      assert.equal(captured.payload?.model, GROQ_MODEL);
      const messages = captured.payload?.messages as Array<{ role: string; content: string }>;
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[0].content, SYSTEM_PROMPT);
      assert.ok(messages[0].content.includes('race conditions'));
      assert.ok(messages[0].content.includes('event listeners'));
      assert.ok(
        messages[0].content.toLowerCase().includes('unhandled promise rejection'),
        'system prompt must call out unhandled promise rejection cascades'
      );
      assert.equal(messages[1].content, buildUserPrompt(BASE_REQUEST));
      assert.ok(messages[1].content.includes(BASE_REQUEST.selectedText));
      assert.ok(messages[1].content.includes('typescript'));
      assert.deepEqual(result, GOOD_REVIEW);
    },
  },
  {
    name: 'success: raw JSON embedded in prose (no fences) still parses',
    run: async () => {
      const result = await runCoTReview(BASE_REQUEST, {
        fetchImpl: () =>
          Promise.resolve(jsonReply(200, chatBody('Here is your review: ' + JSON.stringify(GOOD_REVIEW)))),
      });
      assert.equal(result.refactoredCode, GOOD_REVIEW.refactoredCode);
    },
  },
  {
    name: 'rate-limit: HTTP 429 maps to kind "rate-limit" and surfaces Retry-After',
    run: async () => {
      await assert.rejects(
        runCoTReview(BASE_REQUEST, {
          fetchImpl: () => Promise.resolve(jsonReply(429, { error: 'rate limited' }, { 'retry-after': '12' })),
        }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'rate-limit');
          assert.equal(err.status, 429);
          assert.ok(err.message.includes('12'));
          return true;
        }
      );
    },
  },
  {
    name: 'auth: HTTP 401 maps to kind "auth"',
    run: async () => {
      await assert.rejects(
        runCoTReview(BASE_REQUEST, { fetchImpl: () => Promise.resolve(jsonReply(401, {})) }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'auth');
          return true;
        }
      );
    },
  },
  {
    name: 'timeout: hanging request aborts at timeoutMs with kind "timeout"',
    run: async () => {
      const started = Date.now();
      await assert.rejects(
        runCoTReview(BASE_REQUEST, {
          timeoutMs: 40,
          fetchImpl: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('This operation was aborted', 'AbortError'))
              );
            }),
        }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'timeout');
          return true;
        }
      );
      assert.ok(Date.now() - started < 5_000, 'timeout should fire quickly in tests');
    },
  },
  {
    name: 'network: connection failure maps to kind "network"',
    run: async () => {
      await assert.rejects(
        runCoTReview(BASE_REQUEST, {
          fetchImpl: () => Promise.reject(new Error('ECONNRESET: connection lost')),
        }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'network');
          assert.ok(err.message.includes('ECONNRESET'));
          return true;
        }
      );
    },
  },
  {
    name: 'parse: non-JSON content maps to kind "parse" with a snippet',
    run: async () => {
      await assert.rejects(
        runCoTReview(BASE_REQUEST, {
          fetchImpl: () => Promise.resolve(jsonReply(200, chatBody('Sorry, I cannot produce JSON today.'))),
        }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'parse');
          assert.ok(err.detail && err.detail.length > 0);
          return true;
        }
      );
    },
  },
  {
    name: 'parse: schema violation (missing refactoredCode) is rejected',
    run: async () => {
      const { refactoredCode: _dropped, ...incomplete } = GOOD_REVIEW;
      await assert.rejects(
        runCoTReview(BASE_REQUEST, {
          fetchImpl: () => Promise.resolve(jsonReply(200, chatBody(JSON.stringify(incomplete)))),
        }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'parse');
          assert.ok(err.message.includes('refactoredCode'));
          return true;
        }
      );
    },
  },
  {
    name: 'parse: whitespace-only refactoredCode is rejected',
    run: async () => {
      await assert.rejects(
        runCoTReview(BASE_REQUEST, {
          fetchImpl: () =>
            Promise.resolve(jsonReply(200, chatBody(JSON.stringify({ ...GOOD_REVIEW, refactoredCode: '   ' })))),
        }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'parse');
          return true;
        }
      );
    },
  },
  {
    name: 'empty: 200 with no choices maps to kind "empty"',
    run: async () => {
      await assert.rejects(
        runCoTReview(BASE_REQUEST, { fetchImpl: () => Promise.resolve(jsonReply(200, { choices: [] })) }),
        (err: unknown) => {
          assert.ok(err instanceof GroqServiceError);
          assert.equal(err.kind, 'empty');
          return true;
        }
      );
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const testCase of cases) {
    try {
      await testCase.run();
      console.log(`PASS  ${testCase.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${testCase.name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
