import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

async function readStoreConfig() {
  const file = path.join(repoRoot, 'store.config.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function trimText(value, max = 220) {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function summarizeAssistant(result) {
  if (result.assistantReply) return result.assistantReply;
  if (result.conversationAction === 'search') {
    const count = Array.isArray(result.products) ? result.products.length : 0;
    if (result.products === null) return 'Fallback broad catalog handoff.';
    return `Found ${count} product${count === 1 ? '' : 's'}.`;
  }
  return 'No assistant reply.';
}

function makeProductUrl(storeConfig, slug) {
  const origin = storeConfig.site.origin.replace(/\/$/, '');
  const prefix = storeConfig.site.productPathPrefix.replace(/\/?$/, '/');
  return `${origin}${prefix}${slug}`;
}

function buildHistory(historyMessages) {
  return historyMessages.map((message) => `${message.role}: ${message.text}`).join('\n');
}

function buildScenarios() {
  return [
    {
      id: 'clear-eid-black-embroidered',
      label: 'Clear searchable: Eid black embroidered',
      turns: [
        { query: 'black embroidered dress for eid', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-office-blue-budget',
      label: 'Clear searchable: office blue under budget',
      turns: [
        { query: 'office wear in blue under 15000', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-casual-piece-count',
      label: 'Clear searchable: pink casual 2 piece',
      turns: [
        { query: 'pink 2 piece casual dress', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-lawn-summer',
      label: 'Clear searchable: unstitched lawn',
      turns: [
        { query: 'unstitched lawn for summer', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-wedding-guest',
      label: 'Clear searchable: wedding guest chiffon formal',
      turns: [
        { query: 'chiffon formal for wedding guest', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-roman-urdu-mehndi',
      label: 'Clear searchable: Roman Urdu mehndi',
      turns: [
        { query: 'mehndi ke liye yellow dress', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-roman-urdu-budget',
      label: 'Clear searchable: Roman Urdu budget lawn',
      turns: [
        { query: 'sasta lawn suit dikhao', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-teal-ceremony-sequence',
      label: 'Sequence: teal summer wear then ceremony',
      turns: [
        { query: 'teal colored shirts summer wear', clarity: 'ambiguous', expectedAction: 'clarify' },
        { query: 'highschool prize distribution ceremony', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-picnic-sequence',
      label: 'Sequence: picnic casual 3 piece',
      turns: [
        { query: '3-piece polka dots for outdoor picnic', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clarify-broad-nice',
      label: 'Broad request should clarify',
      turns: [
        { query: 'mujhe kuch acha chahiye', clarity: 'ambiguous', expectedAction: 'clarify' },
      ],
    },
    {
      id: 'clarify-style-only',
      label: 'Broad style-only request should clarify',
      turns: [
        { query: 'summer wear dikhao', clarity: 'ambiguous', expectedAction: 'clarify' },
      ],
    },
    {
      id: 'clear-refine-cheaper',
      label: 'Sequence: search then cheaper refinement',
      turns: [
        { query: 'black embroidered dress for eid under 25000', clarity: 'clear', expectedAction: 'search' },
        { query: 'cheaper', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-refine-color-switch',
      label: 'Sequence: search then green instead',
      turns: [
        { query: 'luxury pret in pastel colors', clarity: 'clear', expectedAction: 'search' },
        { query: 'green instead', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-negation',
      label: 'Sequence: negation should preserve search state',
      turns: [
        { query: 'blue embroidered formal dress', clarity: 'clear', expectedAction: 'search' },
        { query: 'not blue, something green', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'unsupported-menswear',
      label: 'Unsupported menswear request',
      turns: [
        { query: 'mens kurta', clarity: 'clear', expectedAction: 'unsupported' },
      ],
    },
    {
      id: 'unsupported-kidswear',
      label: 'Unsupported kidswear request',
      turns: [
        { query: 'kids frock', clarity: 'clear', expectedAction: 'unsupported' },
      ],
    },
    {
      id: 'clear-roman-urdu-office',
      label: 'Clear searchable: Roman Urdu office',
      turns: [
        { query: 'daftar ke liye decent outfit', clarity: 'clear', expectedAction: 'search' },
      ],
    },
    {
      id: 'clear-graduation',
      label: 'Clear searchable: graduation ceremony',
      turns: [
        { query: 'graduation ceremony ke liye kuch classy', clarity: 'clear', expectedAction: 'search' },
      ],
    },
  ];
}

async function sendTurn(serverBaseUrl, turn, state) {
  const payload = {
    text: turn.query,
    previousIntent: state.previousIntent,
    history: buildHistory(state.history),
  };

  const startedAt = Date.now();
  const response = await fetch(`${serverBaseUrl}/text-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const elapsedMs = Date.now() - startedAt;
  const body = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    elapsedMs,
    request: payload,
    response: body,
  };
}

function evaluateTurn(turn, result) {
  const response = result.response;
  const gotAction = response?.conversationAction ?? null;
  const actionMatches = gotAction === turn.expectedAction;
  const products = Array.isArray(response?.products) ? response.products : [];
  const repeatedClarify =
    turn.expectedAction === 'search' &&
    gotAction === 'clarify' &&
    typeof response?.assistantReply === 'string' &&
    /occasion|style/i.test(response.assistantReply);

  const issues = [];
  if (!result.ok) issues.push(`HTTP ${result.status}`);
  if (!actionMatches) issues.push(`expected ${turn.expectedAction}, got ${gotAction}`);
  if (turn.expectedAction === 'search' && gotAction === 'search' && response?.products !== null && products.length === 0) {
    issues.push('search returned zero products');
  }
  if (repeatedClarify) issues.push('asked for occasion/style again on a turn expected to resolve to search');

  return {
    actionMatches,
    repeatedClarify,
    productCount: products.length,
    issues,
  };
}

function buildAnalysisReport(flatTurns) {
  const total = flatTurns.length;
  const httpFailures = flatTurns.filter((item) => !item.ok).length;
  const actionMatches = flatTurns.filter((item) => item.evaluation.actionMatches).length;
  const repeatedClarify = flatTurns.filter((item) => item.evaluation.repeatedClarify).length;
  const searchTurns = flatTurns.filter((item) => item.turn.expectedAction === 'search');
  const searchWithProducts = searchTurns.filter(
    (item) =>
      item.response?.conversationAction === 'search' &&
      Array.isArray(item.response?.products) &&
      item.response.products.length > 0,
  ).length;
  const surfacedSaleProducts = flatTurns.reduce(
    (sum, item) => sum + ((Array.isArray(item.response?.products) ? item.response.products : []).filter((product) => product.onSale).length),
    0,
  );
  const surfacedOutOfStockProducts = flatTurns.reduce(
    (sum, item) => sum + ((Array.isArray(item.response?.products) ? item.response.products : []).filter((product) => product.inStock === false).length),
    0,
  );

  return {
    generatedAt: new Date().toISOString(),
    totalTurns: total,
    httpFailures,
    expectedActionMatchRate: total === 0 ? 0 : actionMatches / total,
    repeatedClarifyCount: repeatedClarify,
    searchTurnCount: searchTurns.length,
    searchTurnsWithProducts: searchWithProducts,
    surfacedSaleProducts,
    surfacedOutOfStockProducts,
  };
}

async function loadBaseline() {
  const baselinePath = process.env.EVAL_BASELINE_JSON || '';
  if (!baselinePath) return null;
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), baselinePath), 'utf8'));
  } catch {
    return null;
  }
}

function compareAnalyses(previous, current) {
  if (!previous?.analysis) return null;
  const baseline = previous.analysis;
  return {
    baselineGeneratedAt: previous.generatedAt || baseline.generatedAt || null,
    deltaExpectedActionMatchRate: current.expectedActionMatchRate - baseline.expectedActionMatchRate,
    deltaSearchTurnsWithProducts: current.searchTurnsWithProducts - baseline.searchTurnsWithProducts,
    deltaRepeatedClarifyCount: current.repeatedClarifyCount - baseline.repeatedClarifyCount,
    deltaSurfacedSaleProducts: (current.surfacedSaleProducts || 0) - (baseline.surfacedSaleProducts || 0),
    deltaSurfacedOutOfStockProducts: (current.surfacedOutOfStockProducts || 0) - (baseline.surfacedOutOfStockProducts || 0),
  };
}

function markdownReport(storeConfig, serverBaseUrl, scenarios, analysis, comparison) {
  const lines = [];
  lines.push(`# ${storeConfig.brandName} server query evaluation`);
  lines.push('');
  lines.push(`- Generated at: ${analysis.generatedAt}`);
  lines.push(`- Server: ${serverBaseUrl}`);
  lines.push(`- Brand: ${storeConfig.brandName}`);
  lines.push(`- Total turns: ${analysis.totalTurns}`);
  lines.push(`- HTTP failures: ${analysis.httpFailures}`);
  lines.push(`- Expected action match rate: ${(analysis.expectedActionMatchRate * 100).toFixed(1)}%`);
  lines.push(`- Search turns with products: ${analysis.searchTurnsWithProducts}/${analysis.searchTurnCount}`);
  lines.push(`- Repeated clarify count: ${analysis.repeatedClarifyCount}`);
  lines.push(`- Surfaced sale products: ${analysis.surfacedSaleProducts}`);
  lines.push(`- Surfaced out-of-stock products: ${analysis.surfacedOutOfStockProducts}`);
  if (comparison) {
    lines.push(`- Baseline compared: ${comparison.baselineGeneratedAt}`);
    lines.push(`- Δ action match rate: ${(comparison.deltaExpectedActionMatchRate * 100).toFixed(1)} pts`);
    lines.push(`- Δ search turns with products: ${comparison.deltaSearchTurnsWithProducts}`);
    lines.push(`- Δ repeated clarify count: ${comparison.deltaRepeatedClarifyCount}`);
    lines.push(`- Δ surfaced sale products: ${comparison.deltaSurfacedSaleProducts}`);
    lines.push(`- Δ surfaced out-of-stock products: ${comparison.deltaSurfacedOutOfStockProducts}`);
  }
  lines.push('');

  for (const scenario of scenarios) {
    lines.push(`## ${scenario.label}`);
    lines.push('');

    for (const turn of scenario.turns) {
      lines.push(`### ${turn.query}`);
      lines.push('');
      lines.push(`- Clarity: ${turn.clarity}`);
      lines.push(`- Expected action: ${turn.expectedAction}`);
      lines.push(`- HTTP: ${turn.result.status}`);
      lines.push(`- Latency: ${turn.result.elapsedMs} ms`);
      lines.push(`- Actual action: ${turn.response?.conversationAction ?? '(none)'}`);
      lines.push(`- Assistant reply: ${trimText(turn.response?.assistantReply || summarizeAssistant(turn.response), 400) || '(none)'}`);
      lines.push(`- Canonical intent: \`${JSON.stringify(turn.response?.canonicalIntent ?? null)}\``);
      lines.push(`- Issues: ${turn.evaluation.issues.length ? turn.evaluation.issues.join('; ') : 'none'}`);
      lines.push('');

      const products = Array.isArray(turn.response?.products) ? turn.response.products : [];
      if (products.length > 0) {
        lines.push(`| # | Product | Price | Sale | Stock | Sizes | URL |`);
        lines.push(`|---|---|---|---|---|---|---|`);
        for (const [index, product] of products.entries()) {
          lines.push(
            `| ${index + 1} | ${product.title.replace(/\|/g, '\\|')} | ${product.price.replace(/\|/g, '\\|')} | ${product.onSale ? `${product.salePercent || ''}% (${product.compareAtPrice || ''})` : '—'} | ${product.inStock === false ? 'out' : 'in'} | ${(product.availableSizes || []).join(', ').replace(/\|/g, '\\|') || '—'} | ${turn.productUrls[index]} |`,
          );
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

async function main() {
  const storeConfig = await readStoreConfig();
  const serverBaseUrl = process.env.EVAL_SERVER_BASE_URL || 'http://localhost:8787';
  const scenarios = buildScenarios();
  const runId = isoStamp();
  const outputDir = path.join(repoRoot, 'data', 'evals');
  await fs.mkdir(outputDir, { recursive: true });
  const baseline = await loadBaseline();

  const scenarioResults = [];

  for (const scenario of scenarios) {
    const state = { previousIntent: null, history: [] };
    const turns = [];

    for (const turn of scenario.turns) {
      const result = await sendTurn(serverBaseUrl, turn, state);
      const response = result.response;
      const products = Array.isArray(response?.products) ? response.products : [];
      const productUrls = products.map((product) => makeProductUrl(storeConfig, product.slug));
      const evaluation = evaluateTurn(turn, result);

      turns.push({
        ...turn,
        result,
        response,
        productUrls,
        evaluation,
      });

      state.previousIntent = response?.canonicalIntent ?? state.previousIntent;
      state.history.push({ role: 'user', text: turn.query });
      state.history.push({ role: 'assistant', text: summarizeAssistant(response) });
    }

    scenarioResults.push({
      id: scenario.id,
      label: scenario.label,
      turns,
    });
  }

  const flatTurns = scenarioResults.flatMap((scenario) =>
    scenario.turns.map((turn) => ({
      ok: turn.result.ok,
      turn,
      response: turn.response,
      evaluation: turn.evaluation,
    })),
  );

  const analysis = buildAnalysisReport(flatTurns);
  const comparison = compareAnalyses(baseline, analysis);
  const jsonOutput = {
    serverBaseUrl,
    brand: storeConfig.brandName,
    generatedAt: analysis.generatedAt,
    scenarios: scenarioResults,
    analysis,
    comparison,
  };

  const jsonPath = path.join(outputDir, `${storeConfig.brandKey}-server-eval-${runId}.json`);
  const mdPath = path.join(outputDir, `${storeConfig.brandKey}-server-eval-${runId}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(jsonOutput, null, 2));
  await fs.writeFile(mdPath, markdownReport(storeConfig, serverBaseUrl, scenarioResults, analysis, comparison));

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(JSON.stringify(analysis, null, 2));
}

await main();
