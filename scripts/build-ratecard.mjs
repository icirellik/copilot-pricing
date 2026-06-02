// Convert the YAML rate card to JSON at build time so the runtime bundle has no
// dependency on js-yaml. The YAML on disk stays the byte-identical upstream
// mirror (data/models-and-pricing.yml); only the bundled artifact is JSON.
//
// Pattern adapted from copilot-budget's esbuild.js buildRateCard().
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const yamlSrc = path.join(rootDir, 'data', 'models-and-pricing.yml');

if (!existsSync(yamlSrc)) {
  console.error(`build-ratecard: ${yamlSrc} not found`);
  process.exit(1);
}

const parsed = yaml.load(readFileSync(yamlSrc, 'utf-8'));
if (!Array.isArray(parsed)) {
  throw new Error(`models-and-pricing.yml: expected a YAML array, got ${typeof parsed}`);
}

mkdirSync(distDir, { recursive: true });
const jsonOut = path.join(distDir, 'models-and-pricing.json');
writeFileSync(jsonOut, JSON.stringify(parsed) + '\n');
console.log(`build-ratecard: ${path.basename(yamlSrc)} -> dist/${path.basename(jsonOut)} (${parsed.length} entries)`);
