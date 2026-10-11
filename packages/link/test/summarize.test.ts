import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SessionId, SessionRecord, SummaryPayload } from "@aaroncx/protocol";
import { HandoffScheduler } from "../src/handoff.ts";
import { LinkError, LinkService } from "../src/service.ts";
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

describe("a summarizer session is not a way around the target's log", () => {
  /** Summarizes the target as `caller` and returns the closed summarizer. */
  async function summarized(h: Harness, caller: { kind: "human" } | { kind: "session"; id: SessionId }, target: SessionId) {
    const before = h.store.list().map((record) => record.id);
    const pending = h.link.summarize(caller, target);
    const summarizer = await summarizerOf(h, before);
    h.backends.get(summarizer.id)?.hooks.onUpdate(agentChunk(summarizer.id, "A short summary."));
    h.backends.get(summarizer.id)?.endTurn();
    await pending;
    return summarizer;
  }

  test("another session cannot find, list, read or wait on it, and a search hits only the target", async () => {
    const h = harness();
    const asker = await h.session();
    const reader = await h.session();
    const target = await h.session();
    h.history(target.id, [
      ["prompt", userPrompt(target.id, "the zebra quokka plan: rotate zebra-quokka-42 tonight")],
      ["turn_ended", { stopReason: "end_turn" }],
    ]);
    const summarizer = await summarized(h, { kind: "session", id: asker.id }, target.id);
    const as = { kind: "session" as const, id: reader.id };
    const targetAccess = () => accessEvents(h.store, target.id).length;

    // The copy of the transcript is in the summarizer's log, and search
    // never returns it: every hit is on the target, so the access lands there.
    const before = targetAccess();
    const hits = h.link.search(as, "zebra quokka");
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((hit) => hit.sessionId))).toEqual(new Set([target.id]));
    expect(targetAccess()).toBe(before + 1);
    expect(h.link.search({ kind: "human" }, "zebra quokka").map((hit) => hit.sessionId)).not.toContain(summarizer.id);

    expect(h.link.list(as).map((s) => s.id)).not.toContain(summarizer.id);
    expect(h.link.list({ kind: "human" }).map((s) => s.id)).not.toContain(summarizer.id);
    expect(() => h.link.read(as, summarizer.id)).toThrow(`no session ${summarizer.id}`);
    await expect(h.link.wait(as, summarizer.id, "closed", 10)).rejects.toThrow(`no session ${summarizer.id}`);
    await expect(h.link.summarize(as, summarizer.id)).rejects.toThrow(`no session ${summarizer.id}`);
    expect(accessEvents(h.store, summarizer.id).filter((access) => access.by === reader.id)).toEqual([]);
  });

  test("the human may read one, and the target's log records that read", async () => {
    const h = harness();
    const target = await targetWithHistory(h);
    const summarizer = await summarized(h, { kind: "human" }, target.id);
    const page = h.link.read({ kind: "human" }, summarizer.id);
    expect(page.text).toContain("Clamped the status row in build 72.");
    expect(accessEvents(h.store, target.id).at(-1)).toMatchObject({
      op: "read",
      role: "target",
      by: "human",
      via: summarizer.id,
    });
  });

  test("touching an allowlisted repo does not make it visible to a scoped session", async () => {
    const h = harness();
    const target = await targetWithHistory(h);
    const summarizer = await summarized(h, { kind: "human" }, target.id);
    // A scoped daemon (link.json repos) sharing this store: the summarizer's
    // log names a path in the allowlisted repo, which tags it with that repo.
    const repo = join(h.dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    h.history(summarizer.id, [
      [
        "update",
        {
          sessionId: summarizer.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Read",
            kind: "read",
            locations: [{ path: join(repo, "README.md") }],
          },
        },
      ],
    ]);
    expect(h.store.reposFor(summarizer.id).map((r) => r.repoRoot)).toContain(realpathSync(repo));
    const scoped = new LinkService({
      manager: h.manager,
      store: h.store,
      config: { ...h.config, repos: [repo] },
      stateDir: h.dir,
    });
    const reader = await h.session(repo);
    const as = { kind: "session" as const, id: reader.id };
    expect(scoped.list(as).map((s) => s.id)).not.toContain(summarizer.id);
    expect(() => scoped.read(as, summarizer.id)).toThrow(`no session ${summarizer.id}`);
    expect(scoped.search(as, "Clamped").map((hit) => hit.sessionId)).not.toContain(summarizer.id);
  });
});

describe("what bounds the summaries a session can start", () => {
  /** The summarizer running for a target, once its turn has started. */
  async function runningFor(h: Harness, target: SessionId): Promise<SessionRecord> {
    let found: SessionRecord | undefined;
    await waitFor(() => {
      found = h.store
        .list()
        .find((record) => record.cwd === join(h.dir, "summaries", target) && record.status !== "closed");
      return found !== undefined && (h.backends.get(found.id)?.prompts.length ?? 0) === 1;
    }, `the summarizer of ${target}`);
    return found as SessionRecord;
  }

  function finish(h: Harness, summarizer: SessionRecord): void {
    h.backends.get(summarizer.id)?.hooks.onUpdate(agentChunk(summarizer.id, "Summary."));
    h.backends.get(summarizer.id)?.endTurn();
  }

  test("a daemon-wide cap on running summarizers refuses a session past it; the human is never refused", async () => {
    const h = harness({ config: { limits: { maxConcurrentSummaries: 2, messageBurst: 10, maxConcurrentSpawned: 1 } } });
    const caller = await h.session();
    const as = { kind: "session" as const, id: caller.id };
    const targets = [await targetWithHistory(h), await targetWithHistory(h), await targetWithHistory(h)];
    const [t0, t1, t2] = targets.map((t) => t.id) as [SessionId, SessionId, SessionId];

    const first = h.link.summarize(as, t0);
    const second = h.link.summarize({ kind: "human" }, t1);
    // Two are running (one the human's): a session's third is refused, and
    // no summarizer session is created for it.
    let third: unknown;
    try {
      await h.link.summarize(as, t2);
    } catch (error) {
      third = error;
    }
    expect(third).toBeInstanceOf(LinkError);
    expect((third as LinkError).message).toBe("2 summaries are already being written; the limit is 2");
    expect(h.store.list().some((record) => record.cwd === join(h.dir, "summaries", t2))).toBe(false);
    expect(accessEvents(h.store, caller.id).at(-1)).toMatchObject({
      op: "summarize",
      target: t2,
      refused: "2 summaries are already being written; the limit is 2",
    });
    // The human is never refused by it.
    const human = h.link.summarize({ kind: "human" }, t2);

    for (const target of [t0, t1, t2]) {
      finish(h, await runningFor(h, target));
    }
    await Promise.all([first, second, human]);
    // With the summarizers done, the session may start one again.
    const again = h.link.summarize(as, t2);
    finish(h, await runningFor(h, t2));
    expect((await again).text).toBe("Summary.");
  });
});
