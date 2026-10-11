import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionId, SessionRecord, SummaryPayload } from "@aaroncx/protocol";
import { HandoffScheduler } from "../src/handoff.ts";
import { LinkError } from "../src/service.ts";
import {
  accessEvents,
  agentChunk,
  type Harness,
  makeHarness,
  PLANTED_TOKEN,
  promptText,
  userPrompt,
  waitFor,
} from "./helpers.ts";

/**
 * The model-written summary (monad Link phase 3, decision record 0012): only
 * on an explicit call, run by a separate untrusted read-only session that
 * has no Link mount, over the quoted and redacted transcript, stored on the
 * target as a summary event.
 */

let harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses) {
    harness.close();
  }
  harnesses = [];
});

function harness(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(options);
  harnesses.push(h);
  return h;
}

/** The summarizer session the call created, once it exists. */
async function summarizerOf(h: Harness, known: SessionId[]): Promise<SessionRecord> {
  let found: SessionRecord | undefined;
  await waitFor(() => {
    found = h.store.list().find((record) => !known.includes(record.id));
    return found !== undefined && (h.backends.get(found.id)?.prompts.length ?? 0) === 1;
  }, "the summarizer's turn");
  return found as SessionRecord;
}

async function targetWithHistory(h: Harness): Promise<SessionRecord> {
  const target = await h.session();
  h.history(target.id, [
    ["prompt", userPrompt(target.id, `fix the scroll clamp; deploy with ${PLANTED_TOKEN}`)],
    ["update", agentChunk(target.id, "Clamped the status row in build 72.")],
    ["turn_ended", { stopReason: "end_turn" }],
  ]);
  return target;
}

describe("sessions_summarize", () => {
  test("runs an untrusted review summarizer with no Link mount, and stores its answer on the target", async () => {
    const h = harness();
    const caller = await h.session();
    const target = await targetWithHistory(h);
    const before = h.store.list().map((record) => record.id);

    const pending = h.link.summarize({ kind: "session", id: caller.id }, target.id);
    const summarizer = await summarizerOf(h, before);

    // Untrusted and read-only: Link would never mount monad-sessions for it,
    // so whatever the quoted transcript says, it cannot reach a session.
    expect(summarizer).toMatchObject({ trust: "untrusted", mode: "review" });
    expect(h.link.mountAllowed(summarizer)).toBe(false);
    expect(h.link.toolsFor(summarizer.id)).toEqual([]);
    expect(summarizer.parentId).toBeUndefined();
    // An empty directory of its own under $MONAD_HOME/summaries.
    expect(summarizer.cwd).toBe(join(h.dir, "summaries", target.id));
    expect(readdirSync(summarizer.cwd)).toEqual([]);

    const prompt = promptText(h.backends.get(summarizer.id)?.prompts[0]);
    expect(prompt.split("\n")[0]).toBe(`Summarize monad session ${target.id} for a handoff.`);
    expect(prompt).toContain("[monad: quoted history from session");
    expect(prompt).toContain("Clamped the status row in build 72.");
    expect(prompt).not.toContain(PLANTED_TOKEN);

    const backend = h.backends.get(summarizer.id);
    backend?.hooks.onUpdate(agentChunk(summarizer.id, "Fixed the scroll clamp in build 72.\n\nNothing left."));
    backend?.endTurn();
    const result = await pending;

    expect(result).toMatchObject({ sessionId: target.id, summarizerSessionId: summarizer.id });
    const [event] = h.store.replayKinds(target.id, ["summary"]);
    expect(event?.seq).toBe(result.seq);
    expect(event?.payload as SummaryPayload).toEqual({
      text: "Fixed the scroll clamp in build 72.\n\nNothing left.",
      summarizerSessionId: summarizer.id,
      fromSeq: result.fromSeq,
      toSeq: result.toSeq,
    });
    expect(h.store.get(summarizer.id)?.status).toBe("closed");
    expect(h.store.search("Nothing left", { kinds: ["summary"] })).toHaveLength(1);
    // On the record, on both sides.
    expect(accessEvents(h.store, caller.id).at(-1)).toMatchObject({
      op: "summarize",
      role: "caller",
      target: target.id,
      summarizer: summarizer.id,
    });
    expect(accessEvents(h.store, target.id).at(-1)).toMatchObject({ op: "summarize", role: "target", by: caller.id });
  });

  test("a token the summarizer writes back is redacted before it is stored", async () => {
    const h = harness();
    const target = await targetWithHistory(h);
    const before = h.store.list().map((record) => record.id);
    const pending = h.link.summarize({ kind: "human" }, target.id);
    const summarizer = await summarizerOf(h, before);
    h.backends.get(summarizer.id)?.hooks.onUpdate(agentChunk(summarizer.id, `It deployed with ${PLANTED_TOKEN}.`));
    h.backends.get(summarizer.id)?.endTurn();
    const result = await pending;
    expect(result.text).not.toContain(PLANTED_TOKEN);
    expect(JSON.stringify(h.store.replayKinds(target.id, ["summary"]))).not.toContain(PLANTED_TOKEN);
  });

  test("the answer is the last run of text, after any tool call", async () => {
    const h = harness();
    const target = await targetWithHistory(h);
    const before = h.store.list().map((record) => record.id);
    const pending = h.link.summarize({ kind: "human" }, target.id);
    const summarizer = await summarizerOf(h, before);
    const hooks = h.backends.get(summarizer.id)?.hooks;
    hooks?.onUpdate(agentChunk(summarizer.id, "Let me look first."));
    hooks?.onUpdate({
      sessionId: summarizer.id,
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read", status: "completed" },
    });
    hooks?.onUpdate(agentChunk(summarizer.id, "The summary."));
    h.backends.get(summarizer.id)?.endTurn();
    expect((await pending).text).toBe("The summary.");
  });

  test("not offered to review sessions; refused for a second concurrent run and an empty session", async () => {
    const h = harness();
    const review = h.manager.createRecord({ cwd: h.dir, mode: "review", trust: "trusted" });
    const target = await targetWithHistory(h);
    expect(h.link.toolsFor(review.id)).not.toContain("sessions_summarize");
    await expect(h.link.summarize({ kind: "session", id: review.id }, target.id)).rejects.toThrow(
      "sessions_summarize is not available to a review session",
    );

    const before = h.store.list().map((record) => record.id);
    const first = h.link.summarize({ kind: "human" }, target.id);
    const summarizer = await summarizerOf(h, before);
    let second: unknown;
    try {
      await h.link.summarize({ kind: "human" }, target.id);
    } catch (error) {
      second = error;
    }
    expect(second).toBeInstanceOf(LinkError);
    expect((second as LinkError).message).toContain("already being written");
    h.backends.get(summarizer.id)?.hooks.onUpdate(agentChunk(summarizer.id, "done"));
    h.backends.get(summarizer.id)?.endTurn();
    await first;

    const empty = h.manager.createRecord({ cwd: h.dir, trust: "trusted" });
    await expect(h.link.summarize({ kind: "human" }, empty.id)).rejects.toThrow("nothing to summarize");
  });

  test("a summarizer that writes nothing stores nothing and is still closed", async () => {
    const h = harness();
    const target = await targetWithHistory(h);
    const before = h.store.list().map((record) => record.id);
    const pending = h.link.summarize({ kind: "human" }, target.id);
    const summarizer = await summarizerOf(h, before);
    h.backends.get(summarizer.id)?.endTurn();
    await expect(pending).rejects.toThrow("without writing a summary");
    expect(h.store.replayKinds(target.id, ["summary"])).toEqual([]);
    expect(h.store.get(summarizer.id)?.status).toBe("closed");
  });

  test("a summarizer that runs past its timeout is cancelled and closed", async () => {
    const h = harness({ link: { summaryTimeoutMs: 50 } });
    const target = await targetWithHistory(h);
    const before = h.store.list().map((record) => record.id);
    const pending = h.link.summarize({ kind: "human" }, target.id);
    const summarizer = await summarizerOf(h, before);
    await expect(pending).rejects.toThrow("no summary after");
    expect(h.store.get(summarizer.id)?.status).toBe("closed");
  });

  test("handoff --summarize writes a manual handoff, then the summary, and both are on the target's log", async () => {
    const h = harness();
    const target = await targetWithHistory(h);
    // The daemon's scheduler is running, so a close would normally write a
    // handoff; the summarizer is skipped because it runs in summaries/.
    const scheduler = new HandoffScheduler({
      manager: h.manager,
      store: h.store,
      write: (id, reason, stillValid) => h.link.writeHandoff(id, reason, stillValid),
      idleMs: 60_000,
      skip: (record) => h.link.isSummarizer(record),
    });
    scheduler.start();
    const before = h.store.list().map((record) => record.id);
    const pending = h.link.handoff({ kind: "human" }, target.id, { summarize: true });
    const summarizer = await summarizerOf(h, before);
    h.backends.get(summarizer.id)?.hooks.onUpdate(agentChunk(summarizer.id, "All done."));
    h.backends.get(summarizer.id)?.endTurn();
    const result = await pending;
    expect(result.handoff.kind).toBe("handoff");
    expect((result.handoff.payload as { reason: string }).reason).toBe("manual");
    expect(result.summary?.text).toBe("All done.");
    const kinds = h.store.replay(target.id).map((event) => event.kind);
    expect(kinds.indexOf("handoff")).toBeLessThan(kinds.indexOf("summary"));
    expect(accessEvents(h.store, target.id).map((access) => access.op)).toEqual(["handoff", "summarize"]);
    // The summarizer's own close wrote no handoff: it is a tool run, not work.
    expect(h.store.replayKinds(summarizer.id, ["handoff"])).toEqual([]);
    expect(h.store.get(summarizer.id)?.status).toBe("closed");
    scheduler.stop();
  });

  test("a manual handoff is the human's alone", async () => {
    const h = harness();
    const caller = await h.session();
    const target = await targetWithHistory(h);
    await expect(h.link.handoff({ kind: "session", id: caller.id }, target.id)).rejects.toThrow(
      "only the human at the CLI",
    );
  });
});
