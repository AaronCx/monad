import { describe, test, expect } from "bun:test";
import { statusFromFindings } from "../status";
import type { FindingSeverity } from "../../types";

const fs = (...sevs: FindingSeverity[]) => sevs.map((s) => ({ severity: s }));

describe("statusFromFindings", () => {
  test("no findings → pass", () => {
    expect(statusFromFindings([], { severity: "fail" })).toBe("pass");
    expect(statusFromFindings([], { severity: "warn" })).toBe("pass");
  });

  test("high or critical finding respects cfg.severity", () => {
    expect(statusFromFindings(fs("high"), { severity: "fail" })).toBe("fail");
    expect(statusFromFindings(fs("critical"), { severity: "fail" })).toBe("fail");
    expect(statusFromFindings(fs("high"), { severity: "warn" })).toBe("warn");
    expect(statusFromFindings(fs("critical"), { severity: "warn" })).toBe("warn");
  });

  test("medium-only findings cap at warn even when severity=fail", () => {
    expect(statusFromFindings(fs("medium"), { severity: "fail" })).toBe("warn");
    expect(statusFromFindings(fs("medium", "medium"), { severity: "fail" })).toBe("warn");
  });

  test("low-only findings cap at warn even when severity=fail", () => {
    expect(statusFromFindings(fs("low"), { severity: "fail" })).toBe("warn");
  });

  test("mix of high + medium → respects cfg.severity (high drives status)", () => {
    expect(statusFromFindings(fs("high", "medium"), { severity: "fail" })).toBe("fail");
    expect(statusFromFindings(fs("high", "medium"), { severity: "warn" })).toBe("warn");
  });
});
