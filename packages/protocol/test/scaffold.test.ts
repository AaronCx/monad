import { expect, test } from "bun:test";
import { PROTOCOL_PACKAGE } from "../src/index.ts";

test("scaffold exports the package name", () => {
  expect(PROTOCOL_PACKAGE).toBe("@aaroncx/protocol");
});
