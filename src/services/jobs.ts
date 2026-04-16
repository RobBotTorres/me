import { ExternalJob } from '../types';

/**
 * Aggregates jobs from multiple free/freemium boards.
 * All sources run in parallel. Each source catches its own errors so a single failure doesn't kill the batch.
 */

// --- Remotive ---
async function searchRemotive(query: string): Promise<ExternalJob[]> {
  try {
    const res = await fetch(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=20`
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
    return data.data.slice(0, 20).map((j) => ({
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
    }).slice(0, 20);
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
    }).slice(0, 15);
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
      `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(query)}&ResultsPerPage=15${loc}`,
      {
        headers: {
          'User-Agent': 'job-search-agent (contact@example.com)',
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
    }).slice(0, 15);
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
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=comment,story_${storyId}&hitsPerPage=20`
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
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${encodeURIComponent(query)}&where=${encodeURIComponent(location)}`;
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

// --- Aggregated search ---
export interface SearchOptions {
  query: string;
  location?: string;
  remoteOnly?: boolean;
  rapidApiKey?: string;
  adzunaAppId?: string;
  adzunaAppKey?: string;
}

export async function searchJobs(options: SearchOptions): Promise<ExternalJob[]> {
  const { query, location = '', remoteOnly = false, rapidApiKey, adzunaAppId, adzunaAppKey } = options;

  const sources = await Promise.all([
    searchRemotive(query),
    searchArbeitnow(query),
    searchRemoteOK(query),
    searchTheMuse(query),
    searchUSAJobs(query, location),
    searchWorkingNomads(query),
    searchJobicy(query),
    searchHackerNews(query),
    searchAdzuna(query, location, adzunaAppId, adzunaAppKey),
    searchJSearch(query, location, rapidApiKey),
  ]);

  let allJobs = sources.flat();
  if (remoteOnly) allJobs = allJobs.filter((j) => j.remote);

  const seen = new Set<string>();
  allJobs = allJobs.filter((j) => {
    const key = `${j.title.toLowerCase()}|${j.company.toLowerCase()}`;
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
