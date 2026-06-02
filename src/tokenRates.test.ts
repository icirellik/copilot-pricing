import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeCost,
  getDisplayName,
  getRateCard,
  loadRateCard,
  normalizeModelId,
  resetRateCardForTesting,
  stripModelPrefix,
} from './tokenRates';

const FIXTURE = [
  { model: 'Test Model[^1]', provider: 'openai', input: '$2.00', cached_input: '$0.50', output: '$8.00' },
  { model: 'Claude Test', provider: 'anthropic', input: 3.0, cached_input: 0.3, output: 15.0, cache_write: 3.75 },
];

let ratePath: string;

beforeEach(() => {
  resetRateCardForTesting();
  const dir = mkdtempSync(join(tmpdir(), 'copilot-price-rates-'));
  ratePath = join(dir, 'models-and-pricing.json');
  writeFileSync(ratePath, JSON.stringify(FIXTURE));
  loadRateCard(ratePath, true);
});

afterEach(() => {
  resetRateCardForTesting();
});

describe('normalizeModelId', () => {
  it('strips footnotes, lowercases, and hyphenates', () => {
    expect(normalizeModelId('GPT-5.2 Codex[^1]')).toBe('gpt-5.2-codex');
  });
});

describe('stripModelPrefix', () => {
  it('removes known prefixes', () => {
    expect(stripModelPrefix('copilot/gpt-5.2')).toBe('gpt-5.2');
    expect(stripModelPrefix('claude-code/claude-test')).toBe('claude-test');
    expect(stripModelPrefix('plain-model')).toBe('plain-model');
  });
});

describe('getRateCard', () => {
  it('matches after stripping footnotes and prefixes (rates converted to AIC)', () => {
    const card = getRateCard('copilot/Test Model');
    expect(card).not.toBeNull();
    // $2.00 USD/1M → 200 AIC/1M
    expect(card?.input).toBeCloseTo(200);
    expect(card?.cachedInput).toBeCloseTo(50);
    expect(card?.output).toBeCloseTo(800);
    expect(card?.displayName).toBe('Test Model');
  });

  it('returns null for unknown models', () => {
    expect(getRateCard('no-such-model')).toBeNull();
  });
});

describe('computeCost', () => {
  it('prices input/output/cache-read in AIC', () => {
    // 1M input @200 + 1M output @800 + 1M cacheRead @50 = 1050 AIC
    const aic = computeCost('Test Model', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 0 });
    expect(aic).toBeCloseTo(1050);
  });

  it('falls back to the input rate for cache-creation when cache_write is absent', () => {
    const aic = computeCost('Test Model', { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 });
    expect(aic).toBeCloseTo(200); // uses input rate (200)
  });

  it('uses the explicit cache_write rate when present', () => {
    const aic = computeCost('Claude Test', { input: 0, output: 0, cacheRead: 0, cacheCreation: 1_000_000 });
    expect(aic).toBeCloseTo(375); // $3.75 → 375 AIC
  });

  it('returns 0 for unknown models', () => {
    expect(computeCost('no-such-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });
});

describe('getDisplayName', () => {
  it('returns the rate-card display name for known models', () => {
    expect(getDisplayName('copilot/Test Model')).toBe('Test Model');
  });

  it('falls back to the normalized id for unknown models', () => {
    expect(getDisplayName('copilot/Brand New Model')).toBe('brand-new-model');
  });
});
