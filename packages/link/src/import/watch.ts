import { existsSync, type FSWatcher, watch } from "node:fs";
import type { ImportSummary } from "@aaroncx/protocol";
import type { Importer } from "./importer.ts";

/**
 * The opt-in import watcher (link.json `import.watch: true`, Link phase 4):
 * keeps imported sessions current while the vendor CLIs write their logs.
 *
 * - `fs.watch` (recursive) on every configured root that exists, debounced:
 *   a burst of writes (a vendor streams a turn line by line) becomes ONE
 *   import run, DEBOUNCE_MS after the last change to a .jsonl file.
 * - A full rescan every RESCAN_MS whatever the watchers saw, because file
 *   watching is best effort: a root created after the daemon started, an
 *   event the OS coalesced away, a network volume. Every run is incremental
 *   (one stat per unchanged file), so the rescan is cheap.
 *
 * Off by default: an import reads logs that may hold secrets into monad's
 * database (redacted in the index and in every Link output, but stored in the
 * log as read), and that should be something Aaron turned on, not something
 * the daemon does because it can.
 */

export const IMPORT_DEBOUNCE_MS = 2_000;
export const IMPORT_RESCAN_MS = 5 * 60 * 1000;

export interface ImportWatcherOptions {
  importer: Importer;
  debounceMs?: number;
  rescanMs?: number;
  /** Called with each run's summary (the daemon logs runs that changed something). */
  onRun?: (summary: ImportSummary) => void;
  onError?: (error: unknown) => void;
}

export class ImportWatcher {
  private readonly importer: Importer;
  private readonly debounceMs: number;
  private readonly rescanMs: number;
  private readonly onRun?: (summary: ImportSummary) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly watchers: FSWatcher[] = [];
  private debounce?: ReturnType<typeof setTimeout>;
  private rescan?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(options: ImportWatcherOptions) {
    this.importer = options.importer;
    this.debounceMs = options.debounceMs ?? IMPORT_DEBOUNCE_MS;
    this.rescanMs = options.rescanMs ?? IMPORT_RESCAN_MS;
    this.onRun = options.onRun;
    this.onError = options.onError;
  }

  /** Starts watching and runs one import at once (catching up whatever changed while monadd was down). */
  start(): void {
    for (const root of this.importer.roots()) {
      if (!existsSync(root)) {
        continue; // The rescan picks it up if it appears later.
      }
      try {
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (filename === null || String(filename).endsWith(".jsonl")) {
            this.schedule();
          }
        });
        watcher.on("error", (error) => this.onError?.(error));
        this.watchers.push(watcher);
      } catch (error) {
        this.onError?.(error);
      }
    }
    this.rescan = setInterval(() => this.runNow(), this.rescanMs);
    this.rescan.unref?.();
    this.runNow();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.debounce);
    clearInterval(this.rescan);
    for (const watcher of this.watchers.splice(0)) {
      watcher.close();
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.runNow(), this.debounceMs);
    this.debounce.unref?.();
  }

  private runNow(): void {
    if (this.stopped) {
      return;
    }
    this.importer.run().then(
      (summary) => this.onRun?.(summary),
      (error) => this.onError?.(error),
    );
  }
}
