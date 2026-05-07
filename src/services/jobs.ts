import { ExternalJob } from '../types';

/**
 * Aggregates jobs from multiple free/freemium boards.
 * All sources run in parallel. Each source catches its own errors so a single failure doesn't kill the batch.
 */

// --- Remotive ---
async function searchRemotive(query: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=50`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      jobs: Array<{ id: number; title: string; company_name: string; candidate_required_location: string; description: string; url: string; job_type: string; publication_date: string }>;
    };
    return data.jobs.map((j) => ({
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      description: stripHtml(j.description),
      url: j.url,
      remote: true,
      job_type: j.job_type || 'full-time',
      source: 'remotive',
      external_id: `remotive-${j.id}`,
      posted_at: j.publication_date,
    }));
  } catch { return []; }
}

// --- Arbeitnow ---
async function searchArbeitnow(query: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(
      `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(query)}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data: Array<{ slug: string; title: string; company_name: string; location: string; description: string; url: string; remote: boolean; created_at: number }>;
    };
    return data.data.slice(0, 50).map((j) => ({
      title: j.title,
      company: j.company_name,
      location: j.location || 'Not specified',
      description: stripHtml(j.description),
      url: j.url,
      remote: j.remote,
      source: 'arbeitnow',
      external_id: `arbeitnow-${j.slug}`,
      posted_at: new Date(j.created_at * 1000).toISOString(),
    }));
  } catch { return []; }
}

// --- RemoteOK (free, no auth) ---
async function searchRemoteOK(query: string): Promise<ExternalJob[]> {
  try {
    // RemoteOK returns ALL jobs; we filter client-side. First element is metadata.
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'job-search-agent' },
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as unknown[];
    const jobs = raw.slice(1) as Array<{
      id: string; position: string; company: string; location: string;
      description: string; url: string; tags: string[]; date: string;
      salary_min?: number; salary_max?: number;
    }>;
    const q = query.toLowerCase();
    const matches = jobs.filter((j) => {
      const hay = `${j.position} ${(j.tags || []).join(' ')} ${j.description || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 50);
    return matches.map((j) => ({
      title: j.position,
      company: j.company,
      location: j.location || 'Remote',
      description: stripHtml(j.description || ''),
      url: j.url,
      remote: true,
      salary_min: j.salary_min,
      salary_max: j.salary_max,
      source: 'remoteok',
      external_id: `remoteok-${j.id}`,
      posted_at: j.date,
    }));
  } catch { return []; }
}

// --- The Muse (free, no auth) ---
async function searchTheMuse(query: string): Promise<ExternalJob[]> {
  try {
    // Muse doesn't do keyword search via URL param well; we fetch page 1 and filter.
    const res = await fetch(
      `https://www.themuse.com/api/public/jobs?page=1&descending=true`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results: Array<{
        id: number; name: string; contents: string; refs: { landing_page: string };
        company: { name: string }; locations: Array<{ name: string }>;
        categories: Array<{ name: string }>; publication_date: string;
      }>;
    };
    const q = query.toLowerCase();
    const matches = data.results.filter((j) => {
      const hay = `${j.name} ${(j.categories || []).map((c) => c.name).join(' ')} ${j.contents || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 40);
    return matches.map((j) => {
      const locName = j.locations?.[0]?.name || 'Not specified';
      const remote = /remote/i.test(locName);
      return {
        title: j.name,
        company: j.company.name,
        location: locName,
        description: stripHtml(j.contents || ''),
        url: j.refs.landing_page,
        remote,
        source: 'themuse',
        external_id: `themuse-${j.id}`,
        posted_at: j.publication_date,
      };
    });
  } catch { return []; }
}

// --- USAJobs (free, User-Agent required) ---
async function searchUSAJobs(query: string, location?: string): Promise<ExternalJob[]> {
  try {
    const loc = location ? `&LocationName=${encodeURIComponent(location)}` : '';
    const res = await fetch(
      `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(query)}&ResultsPerPage=50${loc}`,
      {
        headers: {
          'User-Agent': 'job-search-agent@cloudflare.workers',
          'Host': 'data.usajobs.gov',
        },
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      SearchResult: {
        SearchResultItems: Array<{
          MatchedObjectId: string;
          MatchedObjectDescriptor: {
            PositionTitle: string;
            OrganizationName: string;
            PositionLocationDisplay: string;
            QualificationSummary: string;
            UserArea?: { Details?: { JobSummary?: string } };
            PositionURI: string;
            PositionRemuneration?: Array<{ MinimumRange?: string; MaximumRange?: string }>;
            PublicationStartDate: string;
          };
        }>;
      };
    };
    return (data.SearchResult?.SearchResultItems || []).map((item) => {
      const d = item.MatchedObjectDescriptor;
      const rem = d.PositionRemuneration?.[0];
      return {
        title: d.PositionTitle,
        company: d.OrganizationName,
        location: d.PositionLocationDisplay,
        description: stripHtml(d.UserArea?.Details?.JobSummary || d.QualificationSummary || ''),
        url: d.PositionURI,
        salary_min: rem?.MinimumRange ? parseInt(rem.MinimumRange) : undefined,
        salary_max: rem?.MaximumRange ? parseInt(rem.MaximumRange) : undefined,
        remote: /remote|telework/i.test(d.PositionLocationDisplay),
        source: 'usajobs',
        external_id: `usajobs-${item.MatchedObjectId}`,
        posted_at: d.PublicationStartDate,
      };
    });
  } catch { return []; }
}

// --- Working Nomads (free, remote-only) ---
async function searchWorkingNomads(query: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch('https://www.workingnomads.com/api/exposed_jobs/');
    if (!res.ok) return [];
    const jobs = (await res.json()) as Array<{
      title: string; company_name: string; location: string; description: string;
      url: string; category_name: string; pub_date: string;
    }>;
    const q = query.toLowerCase();
    const matches = jobs.filter((j) => {
      const hay = `${j.title} ${j.category_name} ${j.description || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 40);
    return matches.map((j, i) => ({
      title: j.title,
      company: j.company_name,
      location: j.location || 'Remote',
      description: stripHtml(j.description || ''),
      url: j.url,
      remote: true,
      source: 'workingnomads',
      external_id: `workingnomads-${j.url || i}`,
      posted_at: j.pub_date,
    }));
  } catch { return []; }
}

// --- Jobicy (free, remote, no auth) ---
async function searchJobicy(query: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(
      `https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(query)}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      jobs?: Array<{
        id: string | number; jobTitle: string; companyName: string;
        jobGeo?: string; jobExcerpt?: string; jobDescription?: string;
        url: string; pubDate?: string; annualSalaryMin?: number; annualSalaryMax?: number;
      }>;
    };
    return (data.jobs || []).slice(0, 25).map((j) => ({
      title: j.jobTitle,
      company: j.companyName,
      location: j.jobGeo || 'Remote',
      description: stripHtml(j.jobDescription || j.jobExcerpt || ''),
      url: j.url,
      remote: true,
      salary_min: j.annualSalaryMin,
      salary_max: j.annualSalaryMax,
      source: 'jobicy',
      external_id: `jobicy-${j.id}`,
      posted_at: j.pubDate,
    }));
  } catch { return []; }
}

// --- Jooble (free key, 140+ source meta-aggregator) ---
async function searchJooble(query: string, location: string, apiKey?: string): Promise<ExternalJob[]> {
  if (!apiKey) return [];
  try {
    const res = await fetch(`https://jooble.org/api/${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: query, location: location || '', page: 1, ResultOnPage: 50 }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      jobs?: Array<{
        id: string | number; title: string; company: string; location: string;
        snippet: string; salary?: string; type?: string; link: string; updated: string;
      }>;
    };
    return (data.jobs || []).map((j) => ({
      title: j.title,
      company: j.company || 'Unknown',
      location: j.location || 'Not specified',
      description: stripHtml(j.snippet || ''),
      url: j.link,
      job_type: (j.type || 'full-time').toLowerCase(),
      remote: /remote/i.test(j.location || ''),
      source: 'jooble',
      external_id: `jooble-${j.id}`,
      posted_at: j.updated,
    }));
  } catch { return []; }
}

// --- Findwork.dev (free key, tech-focused aggregator) ---
async function searchFindwork(query: string, apiKey?: string): Promise<ExternalJob[]> {
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://findwork.dev/api/jobs/?search=${encodeURIComponent(query)}&sort_by=relevance`,
      { headers: { Authorization: `Token ${apiKey}` } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        id: number; role: string; company_name: string; location: string;
        remote: boolean; text: string; url: string; date_posted: string;
        employment_type: string; keywords: string[];
      }>;
    };
    return (data.results || []).slice(0, 50).map((j) => ({
      title: j.role,
      company: j.company_name,
      location: j.location || (j.remote ? 'Remote' : 'Not specified'),
      description: stripHtml(j.text || ''),
      url: j.url,
      remote: j.remote,
      job_type: (j.employment_type || 'full-time').toLowerCase(),
      source: 'findwork',
      external_id: `findwork-${j.id}`,
      posted_at: j.date_posted,
    }));
  } catch { return []; }
}

// --- Hacker News Who's Hiring (via Algolia, free, no auth) ---
async function searchHackerNews(query: string): Promise<ExternalJob[]> {
  try {
    // 1. Find the latest "Ask HN: Who is hiring?" thread
    const threadRes = await fetch(
      'https://hn.algolia.com/api/v1/search?query=who+is+hiring&tags=story,author_whoishiring&hitsPerPage=1'
    );
    if (!threadRes.ok) return [];
    const threadData = (await threadRes.json()) as {
      hits: Array<{ objectID: string; title: string }>;
    };
    const storyId = threadData.hits?.[0]?.objectID;
    if (!storyId) return [];

    // 2. Search comments in that thread
    const commentsRes = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment,story_${storyId}&hitsPerPage=50`
    );
    if (!commentsRes.ok) return [];
    const commentData = (await commentsRes.json()) as {
      hits: Array<{
        objectID: string; author: string; comment_text: string;
        created_at: string; story_id: number;
      }>;
    };

    return (commentData.hits || []).map((h) => {
      const text = stripHtml(h.comment_text || '');
      // First line usually has "Company | Role | Location | Remote/Onsite"
      const firstLine = text.split('\n')[0] || text.slice(0, 120);
      const parts = firstLine.split('|').map((p) => p.trim());
      const company = parts[0] || h.author || 'HN post';
      const title = parts[1] || firstLine.slice(0, 80);
      const locationGuess = parts.slice(2).join(' · ').slice(0, 100) || 'See post';
      return {
        title: title.slice(0, 150),
        company: company.slice(0, 100),
        location: locationGuess,
        description: text.slice(0, 4000),
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        remote: /remote/i.test(firstLine),
        source: 'hackernews',
        external_id: `hn-${h.objectID}`,
        posted_at: h.created_at,
      };
    });
  } catch { return []; }
}

// --- Adzuna (requires free API key) ---
async function searchAdzuna(
  query: string, location: string, appId?: string, appKey?: string
): Promise<ExternalJob[]> {
  if (!appId || !appKey) return [];
  try {
    // Adzuna US endpoint. Using current docs: /v1/api/jobs/{country}/search/{page}
    // https://developer.adzuna.com/docs/search
    const whereParam = location ? `&where=${encodeURIComponent(location)}` : '';
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=50&what=${encodeURIComponent(query)}${whereParam}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results: Array<{ id: string; title: string; company: { display_name: string }; location: { display_name: string }; description: string; redirect_url: string; salary_min?: number; salary_max?: number; contract_type?: string; created: string }>;
    };
    return data.results.map((j) => ({
      title: j.title,
      company: j.company.display_name,
      location: j.location.display_name,
      description: j.description,
      url: j.redirect_url,
      salary_min: j.salary_min,
      salary_max: j.salary_max,
      job_type: j.contract_type || 'full-time',
      source: 'adzuna',
      external_id: `adzuna-${j.id}`,
      posted_at: j.created,
    }));
  } catch { return []; }
}

// --- JSearch via RapidAPI (requires key) ---
async function searchJSearch(query: string, location: string, apiKey?: string): Promise<ExternalJob[]> {
  if (!apiKey) return [];
  try {
    const searchQuery = location ? `${query} in ${location}` : query;
    const res = await fetch(
      `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(searchQuery)}&num_pages=1`,
      { headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data: Array<{ job_id: string; job_title: string; employer_name: string; job_city: string; job_state: string; job_description: string; job_apply_link: string; job_min_salary: number | null; job_max_salary: number | null; job_employment_type: string; job_is_remote: boolean; job_posted_at_datetime_utc: string }>;
    };
    return (data.data || []).map((j) => ({
      title: j.job_title,
      company: j.employer_name,
      location: [j.job_city, j.job_state].filter(Boolean).join(', ') || 'Not specified',
      description: j.job_description,
      url: j.job_apply_link,
      salary_min: j.job_min_salary ?? undefined,
      salary_max: j.job_max_salary ?? undefined,
      job_type: j.job_employment_type?.toLowerCase() || 'full-time',
      remote: j.job_is_remote,
      source: 'jsearch',
      external_id: `jsearch-${j.job_id}`,
      posted_at: j.job_posted_at_datetime_utc,
    }));
  } catch { return []; }
}

// --- WeWorkRemotely RSS (free, no auth) ---
export async function searchWeWorkRemotely(query: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch('https://weworkremotely.com/remote-jobs.rss');
    if (!res.ok) return [];
    const xml = await res.text();
    // RSS items: <item><title>...</title><description>...</description><pubDate>...</pubDate><link>...</link><guid>...</guid></item>
    const items = xml.split('<item>').slice(1);
    const q = query.toLowerCase();
    const jobs: ExternalJob[] = [];
    for (const item of items) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
      const description = (item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '';
      const link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const guid = (item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || link;
      const hay = `${title} ${description}`.toLowerCase();
      if (!hay.includes(q)) continue;
      // Title format is usually "Company: Role Title"
      const parts = title.split(':').map((s) => s.trim());
      const company = parts.length > 1 ? parts[0] : 'Unknown';
      const jobTitle = parts.length > 1 ? parts.slice(1).join(': ') : title;
      jobs.push({
        title: jobTitle,
        company,
        location: 'Remote',
        description: stripHtml(description),
        url: link,
        remote: true,
        source: 'weworkremotely',
        external_id: `wwr-${guid}`,
        posted_at: pubDate ? new Date(pubDate).toISOString() : undefined,
      });
      if (jobs.length >= 40) break;
    }
    return jobs;
  } catch { return []; }
}

// --- Greenhouse public board (free, no auth) ---
export async function fetchGreenhouseJobs(slug: string, label?: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      jobs: Array<{
        id: number;
        title: string;
        absolute_url: string;
        content?: string;
        location: { name: string };
        updated_at: string;
        departments?: Array<{ name: string }>;
        offices?: Array<{ name: string; location?: string }>;
      }>;
    };
    return (data.jobs || []).slice(0, 50).map((j) => ({
      title: j.title,
      company: label || slug,
      location: j.location?.name || (j.offices?.[0]?.name) || 'Not specified',
      description: stripHtml(j.content || ''),
      url: j.absolute_url,
      remote: /remote/i.test(j.location?.name || '') || j.offices?.some((o) => /remote/i.test(o.name || '')) || false,
      source: 'greenhouse',
      external_id: `gh-${slug}-${j.id}`,
      posted_at: j.updated_at,
    }));
  } catch { return []; }
}

// --- Lever public board (free, no auth) ---
export async function fetchLeverJobs(slug: string, label?: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      id: string;
      text: string;
      hostedUrl: string;
      descriptionPlain?: string;
      description?: string;
      categories?: { commitment?: string; department?: string; location?: string; team?: string; allLocations?: string[] };
      createdAt?: number;
      workplaceType?: string;
    }>;
    return (data || []).slice(0, 50).map((j) => ({
      title: j.text,
      company: label || slug,
      location: j.categories?.location || (j.categories?.allLocations || []).join(', ') || 'Not specified',
      description: j.descriptionPlain || stripHtml(j.description || ''),
      url: j.hostedUrl,
      remote: j.workplaceType === 'remote' || /remote/i.test(j.categories?.location || ''),
      job_type: (j.categories?.commitment || 'full-time').toLowerCase(),
      source: 'lever',
      external_id: `lever-${slug}-${j.id}`,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
    }));
  } catch { return []; }
}

// --- Ashby public board (free, no auth) ---
export async function fetchAshbyJobs(slug: string, label?: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      jobs?: Array<{
        id: string;
        title: string;
        location?: string;
        secondaryLocations?: Array<{ location: string }>;
        employmentType?: string;
        descriptionHtml?: string;
        descriptionPlain?: string;
        jobUrl?: string;
        publishedAt?: string;
        isRemote?: boolean;
        compensation?: { compensationTierSummary?: string };
      }>;
    };
    return (data.jobs || []).slice(0, 50).map((j) => ({
      title: j.title,
      company: label || slug,
      location: j.location || j.secondaryLocations?.[0]?.location || 'Not specified',
      description: j.descriptionPlain || stripHtml(j.descriptionHtml || ''),
      url: j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      remote: j.isRemote || /remote/i.test(j.location || ''),
      job_type: (j.employmentType || 'full-time').toLowerCase(),
      source: 'ashby',
      external_id: `ashby-${slug}-${j.id}`,
      posted_at: j.publishedAt,
    }));
  } catch { return []; }
}

export async function fetchWatchedCompanyJobs(
  ats: string,
  slug: string,
  label?: string
): Promise<ExternalJob[]> {
  if (ats === 'greenhouse') return fetchGreenhouseJobs(slug, label);
  if (ats === 'lever') return fetchLeverJobs(slug, label);
  if (ats === 'ashby') return fetchAshbyJobs(slug, label);
  return [];
}

// --- Aggregated search ---
export interface SearchOptions {
  query: string;
  location?: string;
  remoteOnly?: boolean;
  usaOnly?: boolean;
  rapidApiKey?: string;
  adzunaAppId?: string;
  adzunaAppKey?: string;
  joobleApiKey?: string;
  findworkApiKey?: string;
}

const US_STATE_NAMES = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';

const US_CITIES = 'San Francisco|New York City|New York|Los Angeles|Chicago|Seattle|Boston|Austin|Miami|Atlanta|Denver|Portland|Philadelphia|Dallas|Houston|Phoenix|San Diego|Minneapolis|Detroit|Nashville|Charlotte|Raleigh|Pittsburgh|Silicon Valley|Bay Area|Washington DC|Washington D\\.C\\.|NYC|SF';

const US_STATE_ABBREVS = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

const US_REGEX = new RegExp(
  [
    '\\bUSA?\\b',
    '\\bU\\.S\\.(A\\.)?',
    '\\bUnited States\\b',
    '\\bUS-based\\b',
    '\\bAmericas\\b',
    '\\bNorth America\\b',
    `\\b(${US_STATE_NAMES})\\b`,
    `\\b(${US_CITIES})\\b`,
    'Remote[^a-z]{0,5}(US|USA|United States|North America)',
    'Anywhere in (the )?(US|USA|United States)',
  ].join('|'),
  'i'
);

// Avoid false positives on 2-letter abbrevs ("work IN our office"): require context
const STATE_ABBREV_IN_CONTEXT = new RegExp(
  `(,\\s*(${US_STATE_ABBREVS})\\b)|` +
  `(\\s(${US_STATE_ABBREVS})$)|` +
  `(\\s(${US_STATE_ABBREVS})\\s*(,|-|\\(|$))`,
  ''
);

const NON_US_REGEX = /\b(United Kingdom|\bUK\b|Great Britain|England|Scotland|Wales|Germany|Deutschland|Berlin|Munich|France|Paris|Spain|Madrid|Barcelona|Italy|Rome|Milan|Netherlands|Amsterdam|Sweden|Stockholm|Norway|Oslo|Denmark|Copenhagen|Finland|Helsinki|Portugal|Lisbon|Belgium|Brussels|Switzerland|Zurich|Austria|Vienna|Poland|Warsaw|Ireland|Dublin|Greece|Athens|Turkey|Istanbul|Russia|Ukraine|Kyiv|Canada|Toronto|Vancouver|Montreal|Mexico|Mexico City|India|Bangalore|Bengaluru|Mumbai|Delhi|Hyderabad|Pakistan|Philippines|Manila|Singapore|Malaysia|Kuala Lumpur|Indonesia|Jakarta|Thailand|Bangkok|Vietnam|Australia|Sydney|Melbourne|New Zealand|Auckland|Brazil|Sao Paulo|Argentina|Buenos Aires|Chile|Santiago|Colombia|Bogota|Japan|Tokyo|China|Beijing|Shanghai|Korea|Seoul|Taiwan|Taipei|Hong Kong|Israel|Tel Aviv|UAE|Dubai|\\bEurope\\b|\\bEU\\b|EMEA|APAC|LATAM)\b/i;

function isUSACompatible(job: ExternalJob): boolean {
  const loc = (job.location || '').trim();
  const desc = (job.description || '').slice(0, 800); // sample the top

  // Strong US signal in location → include
  if (US_REGEX.test(loc) || STATE_ABBREV_IN_CONTEXT.test(loc)) return true;

  // Strong non-US signal in location → exclude
  if (NON_US_REGEX.test(loc)) return false;

  // Remote/worldwide: default include, only exclude if description is clearly non-US-only
  const looksRemote = job.remote || /remote|anywhere|worldwide|global/i.test(loc);
  if (looksRemote) {
    // Description mentions non-US AND doesn't mention US → exclude
    if (NON_US_REGEX.test(desc) && !US_REGEX.test(desc)) return false;
    return true;
  }

  // Unknown/empty location → be permissive (default include)
  if (!loc || loc.toLowerCase() === 'not specified') return true;

  return false;
}

export async function searchJobs(options: SearchOptions): Promise<ExternalJob[]> {
  const {
    query, location = '', remoteOnly = false, usaOnly = false,
    rapidApiKey, adzunaAppId, adzunaAppKey, joobleApiKey, findworkApiKey,
  } = options;

  // Where supported, pass USA as location hint for richer results
  const locForAPI = usaOnly && !location ? 'United States' : location;

  const sources = await Promise.all([
    searchRemotive(query),
    searchArbeitnow(query),
    searchRemoteOK(query),
    searchTheMuse(query),
    searchUSAJobs(query, locForAPI),
    searchWorkingNomads(query),
    searchJobicy(query),
    searchHackerNews(query),
    searchWeWorkRemotely(query),
    searchAdzuna(query, locForAPI, adzunaAppId, adzunaAppKey),
    searchJSearch(query, locForAPI, rapidApiKey),
    searchJooble(query, locForAPI, joobleApiKey),
    searchFindwork(query, findworkApiKey),
  ]);

  let allJobs = sources.flat();
  if (remoteOnly) allJobs = allJobs.filter((j) => j.remote);
  if (usaOnly) allJobs = allJobs.filter(isUSACompatible);

  // Drop jobs missing essential fields to avoid null crashes
  allJobs = allJobs.filter((j) => j && j.title && j.company);

  const seen = new Set<string>();
  allJobs = allJobs.filter((j) => {
    const key = `${(j.title || '').toLowerCase()}|${(j.company || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return allJobs;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
}
