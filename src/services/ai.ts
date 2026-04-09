import { Env, AIAnalysis, MatchResult } from '../types';

/**
 * Workers AI service for resume analysis, job matching, and content generation.
 * Uses Cloudflare Workers AI models:
 * - @cf/meta/llama-3.1-70b-instruct for text generation
 * - @cf/baai/bge-base-en-v1.5 for embeddings
 */

const TEXT_MODEL = '@cf/meta/llama-3.1-70b-instruct' as const;
const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5' as const;

export async function analyzeResume(ai: Ai, resumeText: string): Promise<AIAnalysis> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content: `You are a resume analysis expert. Analyze the resume and extract structured data.
Return ONLY valid JSON with this exact format, no other text:
{"skills": ["skill1", "skill2"], "experience_years": 5, "summary": "Brief 2-sentence professional summary"}`
      },
      {
        role: 'user',
        content: `Analyze this resume:\n\n${resumeText}`
      }
    ],
    max_tokens: 1024,
  });

  const text = (response as { response: string }).response;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    return JSON.parse(jsonMatch[0]) as AIAnalysis;
  } catch {
    return {
      skills: [],
      experience_years: 0,
      summary: 'Unable to analyze resume. Please try again.',
    };
  }
}

export async function matchJobToResume(
  ai: Ai,
  resumeSkills: string[],
  resumeSummary: string,
  jobTitle: string,
  jobDescription: string
): Promise<MatchResult> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content: `You are a job matching expert. Compare the candidate's profile to the job posting.
Return ONLY valid JSON with this exact format, no other text:
{"score": 85, "explanation": "Why this is a good/bad match", "skills_matched": ["skill1"], "skills_missing": ["skill2"]}`
      },
      {
        role: 'user',
        content: `CANDIDATE SKILLS: ${resumeSkills.join(', ')}
CANDIDATE SUMMARY: ${resumeSummary}

JOB TITLE: ${jobTitle}
JOB DESCRIPTION: ${jobDescription}

Rate the match from 0-100 and explain why.`
      }
    ],
    max_tokens: 1024,
  });

  const text = (response as { response: string }).response;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    return JSON.parse(jsonMatch[0]) as MatchResult;
  } catch {
    return { score: 0, explanation: 'Unable to compute match.', skills_matched: [], skills_missing: [] };
  }
}

export async function generateCoverLetter(
  ai: Ai,
  resumeText: string,
  jobTitle: string,
  company: string,
  jobDescription: string
): Promise<string> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'You are an expert career coach. Write a concise, compelling cover letter tailored to the job. Keep it under 300 words. Be professional but personable.'
      },
      {
        role: 'user',
        content: `Write a cover letter for this application:

MY RESUME:
${resumeText}

JOB TITLE: ${jobTitle}
COMPANY: ${company}
JOB DESCRIPTION: ${jobDescription}`
      }
    ],
    max_tokens: 1024,
  });

  return (response as { response: string }).response;
}

export async function extractJobSkills(ai: Ai, jobDescription: string): Promise<string[]> {
  const response = await ai.run(TEXT_MODEL, {
    messages: [
      {
        role: 'system',
        content: 'Extract the required technical and professional skills from this job posting. Return ONLY a JSON array of strings, no other text. Example: ["Python", "SQL", "Leadership"]'
      },
      {
        role: 'user',
        content: jobDescription,
      }
    ],
    max_tokens: 512,
  });

  const text = (response as { response: string }).response;

  try {
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error('No array found');
    return JSON.parse(arrMatch[0]) as string[];
  } catch {
    return [];
  }
}

export async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const truncated = text.slice(0, 2000);
  const response = await ai.run(EMBEDDING_MODEL, {
    text: [truncated],
  });
  return (response as { data: number[][] }).data[0];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  return magnitude === 0 ? 0 : dot / magnitude;
}
