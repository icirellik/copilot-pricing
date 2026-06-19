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

  it('prefers Copilot metered AIU and only estimates un-metered chats', () => {
    // 3 chats of gpt-test: 2 metered at 5 AIU total, 1 un-metered with token cost.
    // un-metered span: input 1M total = 1M fresh (no cache) → 1M@100 + 1M output@200 = 300 AIC.
    const metered = [
      {
        model: 'gpt-test',
        chats: 3,
        inputTokens: 3_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        meteredAiu: 5,
        meteredChats: 2,
        unmeteredInputTokens: 1_000_000,
        unmeteredOutputTokens: 1_000_000,
        unmeteredCacheReadTokens: 0,
        unmeteredCacheCreationTokens: 0,
      },
    ];
    const report = buildReport(metered, MIDNIGHT);
    expect(report.rows[0].meteredAiu).toBeCloseTo(5);
    expect(report.rows[0].estimatedAic).toBeCloseTo(300);
    expect(report.rows[0].aic).toBeCloseTo(305);
    expect(report.rows[0].estimatedUnpriced).toBe(false); // gpt-test IS in the card
    expect(report.totals.meteredChats).toBe(2);
    expect(report.totals.meteredAiu).toBeCloseTo(5);
    expect(report.unpricedModels).toEqual([]);
  });

  it('does not flag a fully-metered model that is absent from the rate card', () => {
    const report = buildReport(
      [
        {
          model: 'mystery',
          chats: 2,
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          meteredAiu: 1.5,
          meteredChats: 2,
          unmeteredInputTokens: 0,
          unmeteredOutputTokens: 0,
          unmeteredCacheReadTokens: 0,
          unmeteredCacheCreationTokens: 0,
        },
      ],
      MIDNIGHT,
    );
    expect(report.rows[0].aic).toBeCloseTo(1.5); // metered, even with no rate card
    expect(report.unpricedModels).toEqual([]);
  });
});

describe('formatReport', () => {
  it('renders a plain-text table with a total and un-metered/unpriced note', () => {
    const out = formatReport(buildReport(aggregates, MIDNIGHT), false);
    expect(out).toContain('TOTAL');
    expect(out).toContain('300.00');
    expect(out).toContain('mystery *');
    expect(out).toContain('counted as 0');
  });

  it('handles an empty report', () => {
    const out = formatReport(buildReport([], MIDNIGHT), false);
    expect(out).toContain('No Copilot chat usage');
  });

  it('renders a month-to-date headline when present', () => {
    const report = buildReport(aggregates, MIDNIGHT);
    report.monthToDate = { sinceMs: MIDNIGHT, aic: 1234.56, usd: 12.3456 };
    const out = formatReport(report, false);
    expect(out).toContain('Month to date: 1234.56 AIC');
    expect(out).toContain('$12.35');
  });

  it('shows month-to-date even when today is empty', () => {
    const report = buildReport([], MIDNIGHT);
    report.monthToDate = { sinceMs: MIDNIGHT, aic: 42, usd: 0.42 };
    const out = formatReport(report, false);
    expect(out).toContain('No Copilot chat usage');
    expect(out).toContain('Month to date: 42.00 AIC');
  });
});

describe('formatJson', () => {
  it('emits valid JSON round-trippable to the report shape', () => {
    const parsed = JSON.parse(formatJson(buildReport(aggregates, MIDNIGHT)));
    expect(parsed.totals.aic).toBeCloseTo(300);
    expect(parsed.rows).toHaveLength(2);
  });
});
