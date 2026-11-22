import { describe, expect, test } from "bun:test";
import { NoEligibleModelError } from "@mars/execution";
import { CliUsageError, cliErrorMessage, ServeUsageError } from "./cli-errors";
import { CommandsUsageError } from "./commands";
import { TeamUsageError } from "./team";
import { VaultUsageError } from "./vault";

describe("cliErrorMessage", () => {
  test("known model-selection failures print only their fixed safe diagnostic", () => {
    const error = new NoEligibleModelError();
    const diagnostic = error.message;
    error.message = "/private/path api_key=secret";
    expect(cliErrorMessage(error, "redacted")).toBe(diagnostic);
    expect(
      cliErrorMessage(new Error(`${diagnostic} /private/path`), "redacted"),
    ).toBe("redacted");
  });
  test("every command's usage error is a CliUsageError printed verbatim", () => {
    for (const UsageError of [
      ServeUsageError,
      TeamUsageError,
      VaultUsageError,
      CommandsUsageError,
    ]) {
      const error = new UsageError("--flag is wrong.");
      expect(error).toBeInstanceOf(CliUsageError);
      expect(cliErrorMessage(error)).toBe("--flag is wrong.");
      expect(cliErrorMessage(error, "redacted")).toBe("--flag is wrong.");
    }
  });

  test("redacting commands hide every other error", () => {
    expect(cliErrorMessage(new Error("/private/path"), "redacted")).toBe(
      "redacted",
    );
    expect(cliErrorMessage("boom", "redacted")).toBe("redacted");
  });

  test("other commands print Error messages and a generic text otherwise", () => {
    expect(cliErrorMessage(new Error("bad input"))).toBe("bad input");
    expect(cliErrorMessage("boom")).toBe("MARS command failed");
  });
});
