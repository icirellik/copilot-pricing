import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, formatJson, formatReport } from './format';
import { loadRateCard, resetRateCardForTesting } from './tokenRates';

const MIDNIGHT = 1_780_000_000_000;
const FIXTURE = [{ model: 'gpt-test', provider: 'openai', input: '$1.00', cached_input: '$0.10', output: '$2.00' }];

beforeEach(() => {
  resetRateCardForTesting();
  const dir = mkdtempSync(join(tmpdir(), 'copilot-price-fmt-'));
  const ratePath = join(dir, 'models-and-pricing.json');
  writeFileSync(ratePath, JSON.stringify(FIXTURE));
  loadRateCard(ratePath, true);
});

afterEach(() => resetRateCardForTesting());

const aggregates = [
  { model: 'gpt-test', chats: 2, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
  { model: 'mystery', chats: 1, inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
];

describe('buildReport', () => {
  it('prices known models, flags unknown ones, and totals correctly', () => {
    const report = buildReport(aggregates, MIDNIGHT);
    // gpt-test: 1M input @100 + 1M output @200 = 300 AIC
    expect(report.rows[0].model).toBe('gpt-test');
    expect(report.rows[0].aic).toBeCloseTo(300);
    expect(report.totals.aic).toBeCloseTo(300);
    expect(report.totals.usd).toBeCloseTo(3);
    expect(report.totals.tokens).toBe(2_000_500);
    expect(report.unpricedModels).toEqual(['mystery']);
  });

  it('sorts rows by AIC descending', () => {
    const report = buildReport(aggregates, MIDNIGHT);
    expect(report.rows.map((r) => r.model)).toEqual(['gpt-test', 'mystery']);
  });
});

describe('formatReport', () => {
  it('renders a plain-text table with a total and unpriced note', () => {
    const out = formatReport(buildReport(aggregates, MIDNIGHT), false);
    expect(out).toContain('TOTAL');
    expect(out).toContain('300.00');
    expect(out).toContain('mystery *');
    expect(out).toContain('unpriced');
  });

  it('handles an empty report', () => {
    const out = formatReport(buildReport([], MIDNIGHT), false);
    expect(out).toContain('No Copilot chat usage');
  });
});

describe('formatJson', () => {
  it('emits valid JSON round-trippable to the report shape', () => {
    const parsed = JSON.parse(formatJson(buildReport(aggregates, MIDNIGHT)));
    expect(parsed.totals.aic).toBeCloseTo(300);
    expect(parsed.rows).toHaveLength(2);
  });
});
