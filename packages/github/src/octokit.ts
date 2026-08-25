/**
 * The one shape this package needs from Octokit: request(route, params).
 *
 * Everything here talks to GitHub through this interface rather than through
 * the Octokit class, for two reasons. Tests fake it at the request layer, so
 * a route and its parameters are asserted exactly as they would be sent
 * instead of being hidden behind a per-method mock. And the App's token
 * handling stays in one place (src/app.ts) because no other module ever
 * constructs a client.
 *
 * The real Octokit satisfies this structurally; src/app.ts asserts that at
 * compile time.
 */

export interface OctokitResponseLike {
  status: number;
  data: any;
}

export interface OctokitLike {
  request(route: string, params?: Record<string, unknown>): Promise<OctokitResponseLike>;
}
