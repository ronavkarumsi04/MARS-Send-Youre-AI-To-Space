/**
 * The vLLM release MARS attaches to. Keep in sync with the `vllm` component
 * of `sources/manifest.json` (a test cross-checks the revision).
 */
export const VLLM_PIN = {
  repositoryUrl: "https://github.com/vllm-project/vllm",
  release: "v0.32.0",
  version: "0.32.0",
  revision: "5df63a7203cdb9328d824a27b682e77c7b9928be",
} as const;

/**
 * True for exactly the pinned release, optionally with a PEP 440 local label
 * (`0.32.0+cu130`). Dev, rc and post builds do not match.
 */
export function versionMatchesPin(version: string): boolean {
  const [release, local, ...rest] = version.split("+");
  if (rest.length > 0 || release !== VLLM_PIN.version) return false;
  return local === undefined || /^[a-z0-9]+(?:\.[a-z0-9]+)*$/i.test(local);
}
