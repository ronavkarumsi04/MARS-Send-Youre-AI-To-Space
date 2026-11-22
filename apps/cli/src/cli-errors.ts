import { NoEligibleModelError } from "@mars/execution/errors";

/**
 * A command-line mistake whose message is safe to print verbatim. Subclasses must keep it
 * that way: name flags, environment variable names and user-supplied paths only, never a
 * secret value or host-private configuration.
 */
export class CliUsageError extends Error {}

/** A `mars serve` configuration mistake; its message names flags and environment variable names only. */
export class ServeUsageError extends CliUsageError {}

/**
 * The single rule for what a failed `mars` command prints. Usage errors print verbatim.
 * Known model-selection failures print a fixed, configuration-free diagnostic.
 * Commands that pass `redactedFailure` (serve, team) print it in place of any other error,
 * because those may carry paths, tokens or configuration; the rest print `error.message`.
 */
export function cliErrorMessage(
  error: unknown,
  redactedFailure?: string,
): string {
  if (error instanceof CliUsageError) return error.message;
  if (error instanceof NoEligibleModelError)
    return new NoEligibleModelError().message;
  if (redactedFailure !== undefined) return redactedFailure;
  return error instanceof Error ? error.message : "MARS command failed";
}
