/**
 * Job board scanners - direct API calls to public job board feeds.
 * These don't need company datasets like ATS providers - they scan global feeds.
 */

import type { DiscoveredOffer, ExploreFilters } from "@/lib/explore";

const UA = { "User-Agent": "Mozilla/5.0 career-ops/1.0" };

type JobBoardResult = {
  title: string;
  url: string;
  company: string;
  location: string;
  postedAt?: string;
};

// Helper to filter results by keywords
function matchesFilters(job: JobBoardResult, filters: ExploreFilters): boolean {
  const title = job.title.toLowerCase();
  const location = job.location.toLowerCase();

  // Check positive keywords (if any)
  if (filters.positive.length > 0) {
    const hasMatch = filters.positive.some((k) => title.includes(k.toLowerCase()));
    if (!hasMatch) return false;
  }

  // Check negative keywords
  if (filters.negative.length > 0) {
    const hasNegative = filters.negative.some((k) => title.includes(k.toLowerCase()));
    if (hasNegative) return false;
  }

  // Check location filters
  if (filters.block.length > 0) {
    const isBlocked = filters.block.some((k) => location.includes(k.toLowerCase()));
    if (isBlocked) return false;
  }

  if (filters.allow.length > 0) {
    const isAllowed =
      filters.allow.some((k) => location.includes(k.toLowerCase())) ||
      filters.alwaysAllow.some((k) => location.includes(k.toLowerCase()));
    if (!isAllowed) return false;
  }

  return true;
}

// Convert to DiscoveredOffer format
function toOffer(job: JobBoardResult, source: string, filters: ExploreFilters): DiscoveredOffer {
  return {
    url: job.url,
    company: job.company,
    title: job.title,
    location: job.location,
    postedAt: job.postedAt || "",
    ats: source,
    source: source,
    matchedKeyword: filters.positive.find((k) => job.title.toLowerCase().includes(k.toLowerCase())),
  };
}

// ── RemoteOK ────────────────────────────────────────────────────────
async function fetchRemoteOK(): Promise<JobBoardResult[]> {
  try {
    const res = await fetch("https://remoteok.com/api", { headers: UA });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((j: any) => j && j.position && j.url)
      .map((j: any) => ({
        title: j.position,
        url: j.url,
        company: j.company || "RemoteOK",
        location: j.location || "Remote",
        postedAt: j.date ? j.date.split("T")[0] : "",
      }));
  } catch {
    return [];
  }
}

// ── Remotive ────────────────────────────────────────────────────────
async function fetchRemotive(): Promise<JobBoardResult[]> {
  try {
    const res = await fetch("https://remotive.com/api/remote-jobs", { headers: UA });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.jobs || !Array.isArray(data.jobs)) return [];
    return data.jobs.map((j: any) => ({
      title: j.title,
      url: j.url,
      company: j.company_name || "Remotive",
      location: j.candidate_required_location || "Remote",
      postedAt: j.publication_date ? j.publication_date.split("T")[0] : "",
    }));
  } catch {
    return [];
  }
}

// ── Himalayas ────────────────────────────────────────────────────────
async function fetchHimalayas(): Promise<JobBoardResult[]> {
  try {
    const res = await fetch("https://himalayas.app/jobs/api?limit=100", { headers: UA });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.jobs || !Array.isArray(data.jobs)) return [];
    return data.jobs.map((j: any) => ({
      title: j.title,
      url: `https://himalayas.app/jobs/${j.slug}`,
      company: j.companyName || "Himalayas",
      location: j.locationRestrictions?.join(", ") || "Remote",
      postedAt: j.pubDate ? j.pubDate.split("T")[0] : "",
    }));
  } catch {
    return [];
  }
}

// ── Jobicy ────────────────────────────────────────────────────────
async function fetchJobicy(): Promise<JobBoardResult[]> {
  try {
    const res = await fetch("https://jobicy.com/api/v2/remote-jobs?count=50", { headers: UA });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.jobs || !Array.isArray(data.jobs)) return [];
    return data.jobs.map((j: any) => ({
      title: j.jobTitle,
      url: j.url,
      company: j.companyName || "Jobicy",
      location: j.jobGeo || "Remote",
      postedAt: j.pubDate ? j.pubDate.split("T")[0] : "",
    }));
  } catch {
    return [];
  }
}

// ── Arbeitnow ────────────────────────────────────────────────────────
async function fetchArbeitnow(): Promise<JobBoardResult[]> {
  try {
    const res = await fetch("https://www.arbeitnow.com/api/job-board-api", { headers: UA });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) return [];
    return data.data.map((j: any) => ({
      title: j.title,
      url: j.url,
      company: j.company_name || "Arbeitnow",
      location: j.location || "Germany",
      postedAt: j.created_at ? j.created_at.split("T")[0] : "",
    }));
  } catch {
    return [];
  }
}

// ── HackerNews Who's Hiring ────────────────────────────────────────────
async function fetchHackerNews(): Promise<JobBoardResult[]> {
  try {
    // Search for recent "Who is hiring" threads
    const searchUrl = "https://hn.algolia.com/api/v1/search?query=who%20is%20hiring&tags=story&hitsPerPage=1";
    const searchRes = await fetch(searchUrl, { headers: UA });
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    if (!searchData.hits || !searchData.hits[0]) return [];

    const storyId = searchData.hits[0].objectID;
    const commentsUrl = `https://hn.algolia.com/api/v1/items/${storyId}`;
    const commentsRes = await fetch(commentsUrl, { headers: UA });
    if (!commentsRes.ok) return [];
    const commentsData = await commentsRes.json();

    const jobs: JobBoardResult[] = [];
    for (const comment of commentsData.children || []) {
      if (!comment.text) continue;
      // Parse first line as company | title | location
      const text = comment.text.replace(/<[^>]+>/g, " ").trim();
      const firstLine = text.split("\n")[0];
      const parts = firstLine.split("|").map((s: string) => s.trim());
      if (parts.length >= 2) {
        jobs.push({
          title: parts[1] || parts[0],
          url: `https://news.ycombinator.com/item?id=${comment.id}`,
          company: parts[0],
          location: parts[2] || "Remote",
          postedAt: comment.created_at ? comment.created_at.split("T")[0] : "",
        });
      }
    }
    return jobs.slice(0, 100);
  } catch {
    return [];
  }
}

// Map of board ID to fetch function
const BOARD_FETCHERS: Record<string, () => Promise<JobBoardResult[]>> = {
  remoteok: fetchRemoteOK,
  remotive: fetchRemotive,
  himalayas: fetchHimalayas,
  jobicy: fetchJobicy,
  arbeitnow: fetchArbeitnow,
  hackernews: fetchHackerNews,
};

export const SUPPORTED_BOARDS = Object.keys(BOARD_FETCHERS);

export async function scanJobBoards(
  boards: string[],
  filters: ExploreFilters,
  onOffer: (offer: DiscoveredOffer) => void,
): Promise<{ board: string; count: number }[]> {
  const results: { board: string; count: number }[] = [];
  const seen = new Set<string>();

  for (const board of boards) {
    const fetcher = BOARD_FETCHERS[board];
    if (!fetcher) continue;

    try {
      const jobs = await fetcher();
      let count = 0;
      for (const job of jobs) {
        if (seen.has(job.url)) continue;
        if (!matchesFilters(job, filters)) continue;
        seen.add(job.url);
        const offer = toOffer(job, board, filters);
        onOffer(offer);
        count++;
      }
      results.push({ board, count });
    } catch {
      results.push({ board, count: 0 });
    }
  }

  return results;
}
