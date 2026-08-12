import { AuthError, authenticate } from '@/lib/auth';
import { proxySearch } from '@/lib/search';

/**
 * One search is one upstream call, not a hundred — but it is a call we pay
 * credits for, so the ceiling is tight. Past this the client's own fallback
 * would have been the faster answer anyway.
 */
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  let caller;
  try {
    caller = await authenticate(request);
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    return Response.json(
      { error: { message: err.message, type: 'invalid_request_error', code: err.code } },
      { status: err.status },
    );
  }

  return proxySearch(request, {
    userId: caller.userId,
    // Credits are the search-side twin of the token ledger, and the number to
    // watch before this is opened past the preview list: the free allowance is
    // 1,000 credits a month and one search spends 2 per 10 results, so a single
    // enthusiastic user can exhaust it in an afternoon.
    onCredits: (credits, meta) => {
      console.log(
        '[search]',
        meta.userId,
        credits === null ? 'CREDITS MISSING' : `${credits} credits`,
        JSON.stringify(meta.query),
      );
    },
  });
}
