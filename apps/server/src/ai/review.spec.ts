import { createEdge, createNode, type ArchGraph } from '@keel/shared';
import { describe, expect, it } from 'vitest';
import { byNewestFirst, isRetryable, isReviewCapable, parseFindings, withRetry } from './gemini-provider.ts';
import type { ProviderResult, ReviewProvider } from './provider.ts';
import { ArchitectureReviewer, groundFindings } from './review.ts';
import { serializeGraph } from './serialize.ts';

const graph: ArchGraph = {
  nodes: [
    { ...createNode('gateway', 0, 0), id: 'n_api', label: 'API Gateway' },
    { ...createNode('datastore', 0, 0), id: 'n_db', label: 'Orders DB', hasBackup: true },
  ],
  edges: [{ ...createEdge('n_api', 'n_db'), id: 'e_1', timeoutMs: 500 }],
};

const finding = (overrides: Partial<Parameters<typeof groundFindings>[0][number]> = {}) => ({
  severity: 'warning' as const,
  title: 'A finding',
  detail: 'Some detail.',
  nodeIds: ['n_api'],
  edgeIds: [],
  ...overrides,
});

describe('groundFindings', () => {
  it('keeps findings that cite real ids', () => {
    expect(groundFindings([finding()], graph)).toHaveLength(1);
  });

  it('strips ids that do not exist in the diagram', () => {
    const result = groundFindings([finding({ nodeIds: ['n_api', 'n_hallucinated'] })], graph);

    expect(result[0]!.nodeIds).toEqual(['n_api']);
  });

  it('discards a finding left citing nothing real', () => {
    // The product claims every finding is clickable. A finding pointing at a
    // component that does not exist would break that claim silently, so it is
    // dropped rather than shown.
    expect(groundFindings([finding({ nodeIds: ['ghost'], edgeIds: ['ghost'] })], graph)).toEqual([]);
  });

  it('discards a finding that cites nothing at all', () => {
    expect(groundFindings([finding({ nodeIds: [], edgeIds: [] })], graph)).toEqual([]);
  });

  it('keeps a finding grounded only by an edge', () => {
    const result = groundFindings([finding({ nodeIds: [], edgeIds: ['e_1'] })], graph);

    expect(result).toHaveLength(1);
    expect(result[0]!.edgeIds).toEqual(['e_1']);
  });

  it('namespaces model findings so the UI can tell them from rule findings', () => {
    expect(groundFindings([finding()], graph)[0]!.ruleId).toBe('ai-review');
  });
});

describe('serializeGraph', () => {
  it('includes every id, since findings can only cite what it shows', () => {
    const text = serializeGraph(graph);

    expect(text).toContain('[n_api]');
    expect(text).toContain('[n_db]');
    expect(text).toContain('[e_1]');
  });

  it('surfaces the properties the reviewer is asked to reason about', () => {
    const text = serializeGraph(graph);

    expect(text).toContain('replicas=1');
    expect(text).toContain('backups=true');
    expect(text).toContain('timeout=500ms');
  });

  it('marks a missing timeout explicitly rather than omitting it', () => {
    // An absent field reads as "not mentioned"; the reviewer needs it to read as
    // "deliberately absent".
    const noTimeout: ArchGraph = { ...graph, edges: [{ ...graph.edges[0]!, timeoutMs: undefined }] };

    expect(serializeGraph(noTimeout)).toContain('timeout=none');
  });

  it('is stable across input ordering, so the prompt prefix stays cacheable', () => {
    const reversed: ArchGraph = { nodes: [...graph.nodes].reverse(), edges: graph.edges };

    expect(serializeGraph(reversed)).toBe(serializeGraph(graph));
  });
});

describe('provider selection and parsing', () => {
  it('drops a malformed Gemini reply instead of failing the request', () => {
    // The rule engine has already produced what the user depends on. Losing the
    // optional second opinion must not turn into an error response.
    expect(parseFindings('not json at all')).toEqual([]);
    expect(parseFindings(undefined)).toEqual([]);
    expect(parseFindings('{"findings":"wrong shape"}')).toEqual([]);
  });

  it('accepts a well-formed reply', () => {
    const text = JSON.stringify({
      findings: [
        {
          severity: 'warning',
          title: 'Something',
          detail: 'Because.',
          nodeIds: ['n_api'],
          edgeIds: [],
        },
      ],
    });

    expect(parseFindings(text)).toHaveLength(1);
  });

  it('rejects a finding missing required fields', () => {
    const text = JSON.stringify({ findings: [{ severity: 'warning', title: 'No detail' }] });

    expect(parseFindings(text)).toEqual([]);
  });
});

describe('ArchitectureReviewer', () => {
  /** Records calls so caching can be observed rather than assumed. */
  class StubProvider implements ReviewProvider {
    readonly name = 'stub';
    readonly model = 'stub-1';
    calls = 0;
    lastModel: string | undefined;

    async listModels(): Promise<string[]> {
      return ['stub-1', 'stub-2'];
    }

    async generate(_text: string, model?: string): Promise<ProviderResult> {
      this.calls += 1;
      this.lastModel = model;
      return {
        findings: [
          {
            severity: 'warning' as const,
            title: 'From the stub',
            detail: 'Detail.',
            nodeIds: ['n_api'],
            edgeIds: [],
          },
          // Cites nothing real, so grounding must discard it.
          {
            severity: 'error' as const,
            title: 'Invented',
            detail: 'Detail.',
            nodeIds: ['n_does_not_exist'],
            edgeIds: [],
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      };
    }
  }

  it('grounds findings regardless of which provider produced them', async () => {
    const provider = new StubProvider();
    const result = await new ArchitectureReviewer({ provider }).review(graph);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe('From the stub');
  });

  it('serves an unchanged diagram from cache without calling the provider again', async () => {
    const provider = new StubProvider();
    const reviewer = new ArchitectureReviewer({ provider });

    const first = await reviewer.review(graph);
    const second = await reviewer.review(graph);

    expect(provider.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('does not re-review a diagram whose boxes merely moved', async () => {
    const provider = new StubProvider();
    const reviewer = new ArchitectureReviewer({ provider });

    await reviewer.review(graph);
    await reviewer.review({
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, x: n.x + 400, y: n.y + 400 })),
    });

    expect(provider.calls).toBe(1);
  });

  it('re-reviews when the design actually changes', async () => {
    const provider = new StubProvider();
    const reviewer = new ArchitectureReviewer({ provider });

    await reviewer.review(graph);
    await reviewer.review({
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'n_api' ? { ...n, replicas: 9 } : n)),
    });

    expect(provider.calls).toBe(2);
  });

  it('reports which provider answered', async () => {
    const result = await new ArchitectureReviewer({ provider: new StubProvider() }).review(graph);

    expect(result.provider).toBe('stub');
    expect(result.model).toBe('stub-1');
  });

  it('passes a requested model through to the provider', async () => {
    const provider = new StubProvider();
    const result = await new ArchitectureReviewer({ provider }).review(graph, 'stub-2');

    expect(provider.lastModel).toBe('stub-2');
    expect(result.model).toBe('stub-2');
  });

  it('keys the cache by model, so switching models actually re-reviews', async () => {
    // Without the model in the key, picking a different model would silently
    // return the previous model's answer and make the picker a no-op.
    const provider = new StubProvider();
    const reviewer = new ArchitectureReviewer({ provider });

    await reviewer.review(graph, 'stub-1');
    await reviewer.review(graph, 'stub-2');
    expect(provider.calls).toBe(2);

    const repeat = await reviewer.review(graph, 'stub-1');
    expect(provider.calls).toBe(2);
    expect(repeat.cached).toBe(true);
  });

  it('lists the provider models', async () => {
    const reviewer = new ArchitectureReviewer({ provider: new StubProvider() });

    expect(await reviewer.listModels()).toEqual(['stub-1', 'stub-2']);
  });
});

describe('upstream retry', () => {
  const noSleep = async () => undefined;

  it('retries a 503 and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), { status: 503 });
        return 'ok';
      },
      3,
      noSleep,
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('busy'), { status: 503 });
        },
        3,
        noSleep,
      ),
    ).rejects.toThrow('busy');

    expect(calls).toBe(3);
  });

  it('does not retry a non-transient failure', async () => {
    // A bad API key is not going to fix itself, and retrying only delays the
    // error the operator needs to see.
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('bad key'), { status: 401 });
        },
        3,
        noSleep,
      ),
    ).rejects.toThrow('bad key');

    expect(calls).toBe(1);
  });

  it('treats 429 as retryable and 400 as not', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable(new Error('no status'))).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('model list filtering', () => {
  it('rejects models the list endpoint offers but the API will not serve', () => {
    // The 2.5 family is still listed while returning 404 "no longer available
    // to new users" on the first call. Offering it is worse than hiding it.
    expect(isReviewCapable('gemini-2.5-flash')).toBe(false);
    expect(isReviewCapable('gemini-2.5-pro')).toBe(false);
  });

  it('rejects models that cannot answer a text review at all', () => {
    for (const id of [
      'gemini-3.1-flash-image',
      'gemini-2.5-flash-preview-tts',
      'gemini-3.5-transcribe',
      'lyria-3-pro-preview',
      'nano-banana-pro-preview',
      'gemini-robotics-er-2-preview',
      'gemini-2.5-computer-use-preview-10-2025',
    ]) {
      expect(isReviewCapable(id), id).toBe(false);
    }
  });

  it('rejects presets shaped for a different job', () => {
    expect(isReviewCapable('gemma-4-31b-it')).toBe(false);
    expect(isReviewCapable('deep-research-max-preview-04-2026')).toBe(false);
    expect(isReviewCapable('antigravity-preview-05-2026')).toBe(false);
    // customtools expects a tool declaration this request does not send.
    expect(isReviewCapable('gemini-3.1-pro-preview-customtools')).toBe(false);
  });

  it('keeps current families and the moving aliases', () => {
    for (const id of [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-pro-latest',
      'gemini-flash-latest',
    ]) {
      expect(isReviewCapable(id), id).toBe(true);
    }
  });

  it('sorts the newest version first', () => {
    const sorted = ['gemini-3.1-flash-lite', 'gemini-3.7-flash', 'gemini-3.5-flash'].sort(
      byNewestFirst,
    );

    expect(sorted[0]).toBe('gemini-3.7-flash');
    expect(sorted.at(-1)).toBe('gemini-3.1-flash-lite');
  });
});
