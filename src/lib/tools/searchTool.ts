import { tool } from 'ai';
import { z } from 'zod';
import { getSettings } from '../storage/settingsStore';
import { MAX_COUNT, runSearch } from '../search/runSearch';
import { MAX_PLANNED_QUERIES } from '../search/planQueries';

/**
 * Web search as a first-class tool instead of "open a search engine and read
 * the page".
 *
 * The interface is the point. It takes the *information need*, not a query
 * string, because the failure this tool exists to fix is a model pasting the
 * user's sentence into a search box. Pagehand plans that need into several
 * keyword queries, runs them concurrently, and fuses the ranked lists — see
 * search/runSearch.ts for the ladder of backends underneath.
 */

const DEFAULT_COUNT = 8;

export const web_search = tool({
  description:
    'Searches the web and returns clean ranked results (title, url, snippet) as JSON. Pass the ' +
    'information need in plain language — Pagehand rewrites it into several keyword queries, runs ' +
    'them concurrently, and merges the rankings, so you do NOT need to guess keywords yourself. ' +
    'Override with `queries` only when you want specific phrasings (a site: filter, an exact ' +
    'quoted phrase, a language). If results are weak, call again with different `queries` rather ' +
    'than repeating the same need. Then navigate_page to a result url and extract_content to read it.',
  inputSchema: z.object({
    query: z
      .string()
      .describe('What you need to find out, in plain language — not a keyword string'),
    queries: z
      .array(z.string())
      .max(MAX_PLANNED_QUERIES)
      .optional()
      .describe('Exact search queries to run concurrently, skipping keyword planning'),
    count: z
      .number()
      .optional()
      .describe(`How many merged results to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT})`),
  }),
  execute: async ({ query, queries, count }, { abortSignal }) => {
    const settings = await getSettings();
    if (!settings) throw new Error('No model configured — open settings first.');

    const run = await runSearch(settings, query, {
      queries,
      count: count ?? DEFAULT_COUNT,
      signal: abortSignal,
    });

    return {
      // The planned queries go back to the model: when results disappoint, the
      // useful next move is to fix the phrasing, and it can only do that if it
      // can see what was asked.
      queries: run.queries,
      sources: run.sources,
      results: run.results,
      ...(run.note ? { note: run.note } : {}),
    };
  },
});
