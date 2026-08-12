/** OpenRouter's OpenAI-compatible surface. Model ids are namespaced
 * (`openai/gpt-4.1-mini`, `anthropic/claude-sonnet-5`, …). */
export const ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Sent as `HTTP-Referer` / `X-Title`, which is how OpenRouter attributes spend
 * to an app on its dashboard. Per-user attribution rides on the `user` field. */
export const APP_URL = 'https://pagehand.app';
export const APP_TITLE = 'Pagehand';

/** A step carrying a full a11y snapshot plus resent history is large but not
 * unbounded. Anything past this is a bug or an attack, not a real turn. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Which models a hosted request may ask for.
 *
 * Not a pricing concern — the router reports cost per request, so anything it
 * serves can be billed. This is a plan gate and a blast-radius limit: without it
 * a Free user could route every step through the most expensive frontier model
 * on the catalogue.
 */
export function allowedModels(): Set<string> {
  const raw = process.env.HOSTED_MODEL_ALLOWLIST?.trim();
  const list = raw ? raw.split(',').map((m) => m.trim()).filter(Boolean) : [HOSTED_DEFAULT_MODEL];
  return new Set(list);
}

/**
 * DeepSeek, matching what the extension already defaults to for BYOK.
 *
 * Also the pragmatic choice for development: OpenRouter refuses OpenAI and
 * Anthropic models with "This model is not available in your region" when the
 * caller's IP is in mainland China, which is where the dev server runs. That
 * particular 403 would not appear in production — the proxy runs in a Vercel US
 * region there — but a default that only works on deployed infrastructure is a
 * default nobody can debug locally.
 */
export const HOSTED_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';

export function routerApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  return key;
}

/** Firecrawl's search API — JSON results instead of a scraped results page. */
export const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search';

/**
 * Optional, unlike the router key. Hosted search is an upgrade over the
 * extension's keyless Bing path, not a dependency of it: with this unset the
 * endpoint answers 503 and every client falls back on its own.
 */
export function firecrawlApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY?.trim();
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set');
  return key;
}
