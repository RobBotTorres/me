import { ParsedProfile } from '../types';

// Deterministic warm-path check: does any network contact's company match
// this job's company? Token-overlap based so "Snowflake" matches
// "Snowflake Inc" and "Figma" matches "Figma, Inc.".
export function findWarmPath(
  company: string,
  contacts: ParsedProfile['network_contacts'] | undefined
): string | null {
  if (!company || !contacts?.length) return null;
  const jobTokens = tokenize(company);
  if (jobTokens.length === 0) return null;

  const matches: string[] = [];
  for (const c of contacts) {
    if (!c.company) continue;
    const contactTokens = tokenize(c.company);
    if (contactTokens.length === 0) continue;
    const overlap =
      contactTokens.every((t) => jobTokens.includes(t)) ||
      jobTokens.every((t) => contactTokens.includes(t));
    if (overlap) matches.push(`${c.name} (${c.company})`);
  }
  return matches.length ? matches.join(', ') : null;
}

const STOPWORDS = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'company', 'the', 'group', 'labs']);

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}
