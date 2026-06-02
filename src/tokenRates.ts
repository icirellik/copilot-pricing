import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage, log } from './logger';

/**
 * Per-model rate card. All numeric rate fields are AIC per 1M tokens
 * (the bundled rate-card JSON ships USD per 1M tokens — converted from the
 * upstream YAML at build time; `loadRateCard` converts to AIC at load time
 * via the fixed 1 AIC = $0.01 identity).
 *
 * Ported from copilot-budget/src/tokenRates.ts; the only changes are the local
 * logger import and the rate-card location (bundled next to dist/index.mjs).
 */
export interface RateCard {
  input: number;
  cachedInput: number;
  output: number;
  cacheCreation?: number;
  provider: string;
  displayName: string;
}

const USD_TO_AIC = 100;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface RawRateEntry {
  model?: unknown;
  provider?: unknown;
  input?: unknown;
  cached_input?: unknown;
  output?: unknown;
  cache_write?: unknown;
}

const KNOWN_PREFIXES = ['copilot/', 'copilotcli/', 'claude-code/'];

let rateMap: Map<string, RateCard> | null = null;
let loadedFromPath: string | null = null;

function stripFootnotes(name: string): string {
  return name.replace(/\[\^[^\]]+\]/g, '');
}

export function normalizeModelId(rawName: string): string {
  return stripFootnotes(rawName).trim().toLowerCase().replace(/\s+/g, '-');
}

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^\$/, '');
    if (cleaned === '') {
      return null;
    }
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildRateMap(entries: RawRateEntry[]): Map<string, RateCard> {
  const map = new Map<string, RateCard>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const rawModel = typeof entry.model === 'string' ? entry.model : null;
    const provider = typeof entry.provider === 'string' ? entry.provider : null;
    const input = parsePrice(entry.input);
    const cachedInput = parsePrice(entry.cached_input);
    const output = parsePrice(entry.output);
    if (!rawModel || !provider || input === null || cachedInput === null || output === null) {
      log(`tokenRates: skipping entry missing required keys: ${JSON.stringify(entry)}`);
      continue;
    }
    const cacheCreation = parsePrice(entry.cache_write);
    const displayName = stripFootnotes(rawModel).trim();
    const key = normalizeModelId(rawModel);
    const card: RateCard = {
      input: input * USD_TO_AIC,
      cachedInput: cachedInput * USD_TO_AIC,
      output: output * USD_TO_AIC,
      provider,
      displayName,
    };
    if (cacheCreation !== null) {
      card.cacheCreation = cacheCreation * USD_TO_AIC;
    }
    map.set(key, card);
  }
  return map;
}

function defaultRatePath(): string {
  return path.join(__dirname, 'models-and-pricing.json');
}

/**
 * Load the rate card from a JSON file (pre-converted from the upstream YAML
 * at build time). Idempotent — subsequent calls return the cached map unless
 * `force` is true. Returns an empty map if the file is missing or unparseable;
 * the CLI still works, costs just resolve to 0.
 */
export function loadRateCard(ratePath: string = defaultRatePath(), force = false): Map<string, RateCard> {
  if (rateMap && loadedFromPath === ratePath && !force) {
    return rateMap;
  }
  try {
    const raw = fs.readFileSync(ratePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log(`tokenRates: expected JSON array at ${ratePath}, got ${typeof parsed}`);
      rateMap = new Map();
    } else {
      rateMap = buildRateMap(parsed as RawRateEntry[]);
      log(`tokenRates: loaded ${rateMap.size} rate cards from ${ratePath}`);
    }
  } catch (err: unknown) {
    log(`tokenRates: failed to load ${ratePath}: ${errorMessage(err)}`);
    rateMap = new Map();
  }
  loadedFromPath = ratePath;
  return rateMap;
}

function ensureLoaded(): Map<string, RateCard> {
  if (!rateMap) {
    return loadRateCard();
  }
  return rateMap;
}

export function stripModelPrefix(modelId: string): string {
  for (const prefix of KNOWN_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      return modelId.slice(prefix.length);
    }
  }
  return modelId;
}

/**
 * Look up a rate card by model id. Strips known prefixes (`copilot/`,
 * `copilotcli/`, `claude-code/`), lowercases, then checks the rate-card map
 * directly. Returns null when no match is found — callers should record
 * tokens but skip costing.
 */
export function getRateCard(modelId: string): RateCard | null {
  if (!modelId) {
    return null;
  }
  const map = ensureLoaded();
  const stripped = normalizeModelId(stripModelPrefix(modelId));
  return map.get(stripped) ?? null;
}

/**
 * Compute AIC cost for a model invocation. Unknown model → 0.
 * cacheCreation falls back to the input rate when the YAML lacks
 * `cache_write` (OpenAI/Gemini cache implicitly). Rate-card values
 * are already AIC per 1M tokens (converted at load time), so this
 * function emits AIC directly.
 */
export function computeCost(modelId: string, tokens: TokenCounts): number {
  const card = getRateCard(modelId);
  if (!card) {
    return 0;
  }
  const cacheCreationRate = card.cacheCreation ?? card.input;
  return (
    (tokens.input * card.input +
      tokens.cacheRead * card.cachedInput +
      tokens.cacheCreation * cacheCreationRate +
      tokens.output * card.output) /
    1_000_000
  );
}

/**
 * Returns the human-readable display name for a model. Falls back to the
 * stripped/normalized id when the model is unknown to the rate card.
 */
export function getDisplayName(modelId: string): string {
  const card = getRateCard(modelId);
  if (card) {
    return card.displayName;
  }
  return normalizeModelId(stripModelPrefix(modelId));
}

/** Reset cached state. Test helper. */
export function resetRateCardForTesting(): void {
  rateMap = null;
  loadedFromPath = null;
}
