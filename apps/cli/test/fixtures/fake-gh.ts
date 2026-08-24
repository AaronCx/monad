#!/usr/bin/env bun
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A recording stand-in for the gh binary, pointed at by MONAD_GH_BIN.
 *
 * Every invocation is appended to $FAKE_GH_DIR/calls.jsonl as
 * { args, stdin }. A POST of a review is stored in $FAKE_GH_DIR/reviews.json
 * so the next listing sees it, which is what makes the same-head idempotence
 * path testable without a network.
 */

const args = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR;
if (!dir) {
  console.error("fake-gh: FAKE_GH_DIR is required");
  process.exit(2);
}

const callsPath = join(dir, "calls.jsonl");
const reviewsPath = join(dir, "reviews.json");
const methodIndex = args.indexOf("-X");
const isPost = methodIndex !== -1 && args[methodIndex + 1] === "POST";
const stdin = isPost ? await Bun.stdin.text() : "";
await appendFile(callsPath, `${JSON.stringify({ args, stdin })}\n`);

interface StoredReview {
  id: number;
  body: string;
}

async function readReviews(): Promise<StoredReview[]> {
  try {
    return JSON.parse(await readFile(reviewsPath, "utf8")) as StoredReview[];
  } catch {
    return [];
  }
}

const reviews = await readReviews();
if (isPost) {
  const payload = JSON.parse(stdin) as { body: string };
  const stored: StoredReview = { id: reviews.length + 1, body: payload.body };
  reviews.push(stored);
  await writeFile(reviewsPath, JSON.stringify(reviews));
  console.log(JSON.stringify({ id: stored.id, state: "COMMENTED" }));
} else {
  console.log(JSON.stringify(reviews));
}
