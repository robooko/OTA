// Competitor research from DataForSEO Labs (moved here from FORGE desktop's
// ClientSites.refreshCompetitors). Labs is DataForSEO's keyword database,
// refreshed about monthly, so a report is a snapshot, not a live rank check.
// Every call is paid, so the caller (controllers/property.js) saves each
// report and rate-limits refreshes.

const LABS = 'https://api.dataforseo.com/v3/dataforseo_labs/google';
// Each named competitor is one paid domain_intersection call.
const MAX_COMPETITORS = 5;
const KEYWORDS_PER_COMPETITOR = 50;

function isConfigured() {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

/** Bare domain (no scheme, `www.` or path) from a URL or domain, else null. */
function bareDomain(value) {
  const match = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|$)/.exec(String(value).trim().toLowerCase());
  return match ? match[1] : null;
}

/** One row per keyword at its best rank: DataForSEO repeats a keyword for each ranking URL. */
function uniqueKeywords(keywords) {
  const best = new Map();
  for (const each of keywords) {
    const seen = best.get(each.keyword);
    if (!seen || each.rank < seen.rank) best.set(each.keyword, each);
  }
  return [...best.values()];
}

const keywordRow = (data, serp) => ({
  keyword: data.keyword,
  volume: data.keyword_info?.search_volume ?? null,
  rank: serp.rank_absolute,
  url: serp.url ?? null,
});

// DataForSEO answers HTTP 200 even when the task failed, so the task's own
// status_code is what counts; a 4xx (no balance, unverified) explains itself
// in the body.
async function labs(endpoint, task, location) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  const res = await fetch(`${LABS}/${endpoint}/live`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ ...task, location_name: location, language_code: 'en' }]),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => null);
  const t = body?.tasks?.[0];
  if (t?.status_code !== 20000) {
    throw new Error(`DataForSEO ${endpoint}: ${t?.status_message ?? body?.status_message ?? `HTTP ${res.status}`}`);
  }
  return t.result?.[0]?.items ?? [];
}

/**
 * Who competes with `domain` and the keywords they rank for that it doesn't.
 * `competitors` are domains the caller names (from the site's brief); without
 * any, the top 3 discovered ones are compared. Throws with DataForSEO's own
 * message on failure.
 */
async function competitorReport({ domain, competitors = [], location = 'United Kingdom' }) {
  const named = [...new Set(competitors.map(bareDomain).filter((d) => d && d !== domain))];

  const discovered = (await labs('competitors_domain', { target: domain, limit: 11, exclude_top_domains: true }, location))
    .filter((each) => each.domain !== domain)
    .slice(0, 10)
    .map((each) => ({
      domain: each.domain,
      avgPosition: each.avg_position,
      sharedKeywords: each.intersections,
      keywords: each.full_domain_metrics?.organic?.count ?? 0,
      traffic: each.full_domain_metrics?.organic?.etv ?? 0,
    }));

  const targets = named.length ? named.slice(0, MAX_COMPETITORS) : discovered.slice(0, 3).map((each) => each.domain);
  const gaps = await Promise.all(
    targets.map(async (target) => {
      const items = await labs(
        'domain_intersection',
        { target1: target, target2: domain, intersections: false, limit: KEYWORDS_PER_COMPETITOR },
        location
      );
      return {
        domain: target,
        keywords: uniqueKeywords(items.map((item) => keywordRow(item.keyword_data, item.first_domain_serp_element))),
      };
    })
  );

  return { location, domain, discovered, competitors: gaps };
}

module.exports = { isConfigured, bareDomain, uniqueKeywords, competitorReport, MAX_COMPETITORS };

// node src/lib/dataForSeo.js -- checks the pure helpers.
if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(bareDomain('https://www.Example.co.uk/path'), 'example.co.uk');
  assert.strictEqual(bareDomain('jeevesbarber.co.uk'), 'jeevesbarber.co.uk');
  assert.strictEqual(bareDomain('not a domain'), null);
  assert.deepStrictEqual(
    uniqueKeywords([
      { keyword: 'barber', rank: 7 },
      { keyword: 'barber', rank: 3 },
      { keyword: 'fade', rank: 5 },
    ]),
    [{ keyword: 'barber', rank: 3 }, { keyword: 'fade', rank: 5 }]
  );
  console.log('dataForSeo ok');
}
