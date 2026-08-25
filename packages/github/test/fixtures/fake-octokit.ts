import type { OctokitLike, OctokitResponseLike } from "../../src/octokit.ts";

/**
 * Octokit faked at the request layer, not per method.
 *
 * Every call records the route string and the parameter object exactly as
 * the code under test built them, so a test asserts the payload as it would
 * be sent. A per-method mock would assert only that a helper was called,
 * which is the thing that cannot regress on its own.
 */

export interface RecordedRequest {
  route: string;
  params: Record<string, unknown>;
}

export type Responder = (
  route: string,
  params: Record<string, unknown>,
) => OctokitResponseLike | undefined;

export interface FakeOctokit {
  octokit: OctokitLike;
  calls: RecordedRequest[];
  /** Calls whose route matches, in order. */
  matching(fragment: string): RecordedRequest[];
}

export function fakeOctokit(responder?: Responder): FakeOctokit {
  const calls: RecordedRequest[] = [];
  const octokit: OctokitLike = {
    request: async (route, params = {}) => {
      calls.push({ route, params });
      const answer = responder?.(route, params);
      if (answer !== undefined) {
        return answer;
      }
      return { status: 200, data: { id: 4242 } };
    },
  };
  return {
    octokit,
    calls,
    matching: (fragment: string) => calls.filter((call) => call.route.includes(fragment)),
  };
}
