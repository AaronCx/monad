/**
 * @aaroncx/github: the GitHub side of monad, and nothing else.
 *
 * This package is a trigger and a renderer (decision record 0010). It reads
 * signed webhook payloads, resolves them to an intent, decides trust from
 * what GitHub signed, and renders a review the engine already produced into
 * GitHub's API shapes. It runs no checks, holds no policy, and never decides
 * what a session may execute; that lives in @aaroncx/engine and
 * @aaroncx/checks. It must not import from apps/.
 */

export {
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  DELIVERY_HEADER,
  EVENT_HEADER,
} from "./signature.ts";

export {
  createGitHubApp,
  normalizePrivateKey,
  readPrivateKey,
  DEFAULT_CACHE_ENTRIES,
  INSTALLATION_TOKEN_TTL_MS,
} from "./app.ts";
export type { GitHubApp, GitHubAppConfig, InstallationToken } from "./app.ts";
export type { OctokitLike, OctokitResponseLike } from "./octokit.ts";

export {
  parsePullRequest,
  resolveWebhookIntent,
  reviewPrInputFromPayload,
  parseMonadCommand,
  describeDelivery,
  COMMAND_PREFIX,
  MONAD_EVENTS,
  REVIEW_PR_ACTIONS,
} from "./events.ts";
export type {
  CommandIntent,
  DeliveryInput,
  DeliveryMeta,
  IgnoredIntent,
  MonadCommand,
  MonadEvent,
  NarrowedComment,
  NarrowedPullRequest,
  RecordIntent,
  RepoRef,
  ReviewIntent,
  WebhookIntent,
} from "./events.ts";

export {
  ACK_REACTION,
  DONE_REACTION,
  fetchPullRequest,
  postIssueComment,
  reactToComment,
  REACTIONS,
  REFUSED_REACTION,
  UNKNOWN_REACTION,
} from "./comments.ts";
export type { CommentRef, ReactionContent } from "./comments.ts";

export {
  commenterMayRunFix,
  hasWriteAccess,
  isForkPullRequest,
  resolveTrustFromIntent,
  resolveTrustFromPullRequest,
  WRITE_ASSOCIATIONS,
} from "./trust.ts";
export type { TrustDecision } from "./trust.ts";

export {
  annotationTruncationNote,
  clampSummary,
  completeCheckRun,
  createCheckRun,
  updateCheckRun,
  CHECK_RUN_NAME,
  MAX_ANNOTATIONS_PER_REQUEST,
  MAX_ANNOTATIONS_TOTAL,
  MAX_SUMMARY_LENGTH,
} from "./check-runs.ts";
export type {
  CheckRunConclusion,
  CheckRunOutput,
  CheckRunStatus,
  CompleteCheckRunParams,
  CompleteCheckRunResult,
  CreateCheckRunParams,
  UpdateCheckRunParams,
} from "./check-runs.ts";

export {
  checkRunConclusion,
  checkRunSummary,
  checkRunText,
  checkRunTitle,
  formatCheckFindings,
  inProgressCheckRunOutput,
  isUnstructuredReport,
  queuedCheckRunOutput,
  renderCompletedCheckRun,
  secretsWarning,
  sessionFooter,
  trustSummaryLine,
} from "./render.ts";
export type { CheckRunSummaryInput } from "./render.ts";

export {
  anchorableLines,
  anchorMap,
  buildReviewPayload,
  formatComment,
  formatReviewBody,
  hasMonadReviewForHead,
  octokitReviewTransport,
  planReviewPost,
  postReview,
  reviewMarker,
  REVIEW_MARKER_PREFIX,
} from "./review-post.ts";
export type {
  BuildPayloadInput,
  ExistingReview,
  PostPlan,
  PostReviewInput,
  PostReviewResult,
  ReviewBodyInput,
  ReviewComment,
  ReviewEvent,
  ReviewPayload,
  ReviewTransport,
} from "./review-post.ts";
