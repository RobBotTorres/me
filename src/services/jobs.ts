import { ExternalJob } from '../types';

/**
 * Job search service that aggregates results from multiple free job board APIs.
 *
 * Supported sources:
 * - Remotive (free, no key needed) - remote jobs
 * - Arbeitnow (free, no key needed) - general jobs
 * - Adzuna (free tier, key required) - large job aggregator
 * - JSearch via RapidAPI (freemium, key required) - LinkedIn/Indeed/etc
 */

// --- Remotive (free, no API key) ---
async function searchRemotive(query: string): Promise<ExternalJob[]> {
  try {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=20`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = (await res.json()) as {
      jobs: Array<{
        id: number;
        title: string;
        company_name: string;
        candidate_required_location: string;
        description: string;
        url: string;
        salary: string;
        job_type: string;
        publication_date: string;
      }>;
    };

    return data.jobs.map((job) => ({
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location || 'Remote',
      description: stripHtml(job.description),
      url: job.url,
      remote: true,
      job_type: job.job_type || 'full-time',
      source: 'remotive',
      external_id: `remotive-${job.id}`,
      posted_at: job.publication_date,
    }));
  } catch {
    return [];
  }
}

// --- Arbeitnow (free, no API key) ---
async function searchArbeitnow(query: string): Promise<ExternalJob[]> {
  try {
    const url = `https://www.arbeitnow.com/api/job-board-api?search=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data: Array<{
        slug: string;
        title: string;
        company_name: string;
        location: string;
        description: string;
        url: string;
        remote: boolean;
        created_at: number;
        tags: string[];
      }>;
    };

    return data.data.slice(0, 20).map((job) => ({
      title: job.title,
      company: job.company_name,
      location: job.location || 'Not specified',
      description: stripHtml(job.description),
      url: job.url,
      remote: job.remote,
      source: 'arbeitnow',
      external_id: `arbeitnow-${job.slug}`,
      posted_at: new Date(job.created_at * 1000).toISOString(),
    }));
  } catch {
    return [];
  }
}

// --- Adzuna (requires free API key) ---
async function searchAdzuna(
  query: string,
  location: string,
  appId?: string,
  appKey?: string
): Promise<ExternalJob[]> {
  if (!appId || !appKey) return [];

  try {
    const country = 'us';
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${encodeURIComponent(query)}&where=${encodeURIComponent(location)}`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = (await res.json()) as {
      results: Array<{
        id: string;
        title: string;
        company: { display_name: string };
        location: { display_name: string };
        description: string;
        redirect_url: string;
        salary_min?: number;
        salary_max?: number;
        contract_type?: string;
        created: string;
      }>;
    };

    return data.results.map((job) => ({
      title: job.title,
      company: job.company.display_name,
      location: job.location.display_name,
      description: job.description,
      url: job.redirect_url,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      job_type: job.contract_type || 'full-time',
      source: 'adzuna',
      external_id: `adzuna-${job.id}`,
      posted_at: job.created,
    }));
  } catch {
    return [];
  }
}

// --- JSearch via RapidAPI (requires key) ---
async function searchJSearch(query: string, location: string, apiKey?: string): Promise<ExternalJob[]> {
  if (!apiKey) return [];

  try {
    const searchQuery = location ? `${query} in ${location}` : query;
    const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(searchQuery)}&num_pages=1`;
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      data: Array<{
        job_id: string;
        job_title: string;
        employer_name: string;
        job_city: string;
        job_state: string;
        job_description: string;
        job_apply_link: string;
        job_min_salary: number | null;
        job_max_salary: number | null;
        job_employment_type: string;
        job_is_remote: boolean;
        job_posted_at_datetime_utc: string;
      }>;
    };

    return (data.data || []).map((job) => ({
      title: job.job_title,
      company: job.employer_name,
      location: [job.job_city, job.job_state].filter(Boolean).join(', ') || 'Not specified',
      description: job.job_description,
      url: job.job_apply_link,
      salary_min: job.job_min_salary ?? undefined,
      salary_max: job.job_max_salary ?? undefined,
      job_type: job.job_employment_type?.toLowerCase() || 'full-time',
      remote: job.job_is_remote,
      source: 'jsearch',
      external_id: `jsearch-${job.job_id}`,
      posted_at: job.job_posted_at_datetime_utc,
    }));
  } catch {
    return [];
  }
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

  // Run all searches in parallel
  const [remotiveJobs, arbeitnowJobs, adzunaJobs, jsearchJobs] = await Promise.all([
    searchRemotive(query),
    searchArbeitnow(query),
    searchAdzuna(query, location, adzunaAppId, adzunaAppKey),
    searchJSearch(query, location, rapidApiKey),
  ]);

  let allJobs = [...remotiveJobs, ...arbeitnowJobs, ...adzunaJobs, ...jsearchJobs];

  if (remoteOnly) {
    allJobs = allJobs.filter((job) => job.remote);
  }

  // Deduplicate by title + company
  const seen = new Set<string>();
  allJobs = allJobs.filter((job) => {
    const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`;
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
