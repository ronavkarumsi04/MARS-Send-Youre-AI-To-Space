# Browser worker (Milestone 2)

Background browser tasks for agent sessions: a durable control plane
(`packages/browser`, `@mars/browser`) and a bounded worker
(`packages/browser-worker`, `@mars/browser-worker`), wired into `mars serve`
the same way research is. It follows the master specification's browser
requirements (actions, observations, screenshots/extracted content and
artifacts; one browser session per task unless sharing is intentional) and the
source register's Browser Use adaptation notes (no competing agent loop,
positive action allowlist, bounded steps/time/artifacts, egress enforced
outside the library, owned browsers killed on cancellation).

## Flow

1. The coordinator calls `mars_browse` (`goal`, `start_url`, optional
   `actions` such as `"click e3"`, `allowed_actions`, `max_steps`,
   `session_key`). The host (`packages/workbench/src/browser-context.ts`) scopes
   it to the task's current durable revision, sizes its budget to half of the
   task's remaining shared allowance, and submits it.
2. `createBrowserService` validates the strict request, reserves the job's
   whole budget in the task's `budget_holds` ledger (`browser:<sha256>` key)
   and queues it. Admission refuses a request whose policy exceeds the host
   ceiling, whose budget exceeds the task's or the shared allowance, or whose
   task has no background slot (`max_concurrency` 1).
3. The claim loop leases a job, then acquires a task-wide
   `concurrency_slots` slot keyed per attempt (`browser:<sha256>:<attempt>`),
   so a stale attempt can never release its successor's slot. One slot is
   always left for the foreground run; a job without a slot returns to the
   queue unchanged. Leases and slots are renewed on heartbeat; losing either
   aborts the worker and requeues the job.
4. The worker opens one browser per attempt through a `BrowserEngine`, loads
   the shared session state only when the request names a `session_key`, and
   runs either the scripted actions or a planner loop (one action per model
   call, page text fenced as `<<<UNTRUSTED_WEB_CONTENT … UNTRUSTED_WEB_CONTENT>>>`,
   `UsageLedger` reservations so no call can overrun the job budget).
5. Every step and the final result are written through the worker context:
   screenshots and page text are captured as task artifacts first, and steps or
   results may only cite artifacts this attempt captured. Text is scrubbed of
   secrets and private roots; evidence containing a private root is refused.
6. `mars_browse_result` renders status, steps and the result as untrusted text,
   flagging results from an older task revision as stale.

## Security boundaries

- **Egress**: every request the page makes (documents, subresources,
  redirects, form posts) goes through `createGuardedBrowserFetch`: http(s)
  only, no URL credentials, allow/deny host lists, DNS resolved once per
  request with private, loopback, link-local and metadata addresses refused,
  and the connection pinned to that validated address (`createPinnedFetch`,
  node:http(s) with a fixed `lookup`; TLS still verifies the URL's hostname),
  so a second DNS answer cannot rebind it, manual redirects
  re-checked hop by hop, bounded bodies and timeouts, dangerous request
  headers stripped. The Playwright adapter routes all traffic through it and
  additionally starts Chromium with `--host-resolver-rules=MAP * ~NOTFOUND`
  so nothing bypasses the route; WebRTC non-proxied UDP, background
  networking, sync, extensions, component updates and telemetry are disabled,
  service workers are blocked and downloads refused.
- **Actions**: positive allowlist per request, bounded by the operator ceiling
  (`WorkbenchBrowserOptions.allowedActions`, `mars serve --browser-allow-input`).
  Both default to read-only (`navigate`, `click`, `scroll`, `back`,
  `screenshot`, `extract`); a request, and so the model, can never grant itself
  `type` or `press`. Disallowed actions are recorded as
  `blocked`, never run. The worker refuses to type text that looks like a
  secret or private path.
- **Isolation**: one browser process and context per attempt; session state is
  stored per `(scope, task, session_key)` and only loaded when the key is
  given; jobs sharing a key run one at a time so no save overwrites another.
  Captured evidence is owned by its task (`ownsEvidence`), so the host's
  artifact download serves it to that task only. Cancellation, deadline, lease loss and shutdown abort the worker,
  which kills the owned browser.
- **Budget**: one durable hold per job in `budget_holds`; usage is reported as
  it accrues (including late reports after lease loss), and reported usage
  over the job budget fails the job. Scripted runs report zero so they commit
  nothing. Failed planner calls are charged their whole reservation.

## Engines

`BrowserEngine` is the adapter boundary.

- `createPlaywrightEngine` (production): `playwright-core` 1.58.2 driving a
  local Chromium/Chrome executable. `playwright-core` ships no browser
  binaries and runs no install scripts, so CI stays offline; the opt-in test in
  `worker.test.ts` runs only with `MARS_BROWSER_CHROMIUM=/path/to/chrome`
  (verified locally with Chrome for Testing 156).
- `createFakeBrowserEngine` (tests): a deterministic in-process HTML engine
  that fetches through the same guarded fetch, so egress policy is exercised
  identically offline.

Browser Use itself (Python, pinned in `sources/manifest.json`) is not a runtime
dependency: its agent loop would compete with the MARS coordinator and it has
no TypeScript API. The worker reproduces its useful shape (indexed element
refs, one action per step, a `done` action) on top of Playwright, which Browser
Use also uses.

## Enabling

`mars serve --browser-chromium /abs/path/to/chrome [--browser-deny-host PATTERN]...`
enables the tools with the free default model as planner (scripted-only when
no free model is configured). `mars doctor` reports the browser section.
Programmatic hosts pass `WorkbenchServiceOptions.browser`.

## Acceptance status

Offline only: control-plane tests (`packages/browser/src/browser.test.ts`),
worker tests with the fake engine (`packages/browser-worker/src/worker.test.ts`)
and the `mars serve` end-to-end test
(`packages/workbench/src/browser-service.test.ts`). Live browsing of real sites
with a live planner model is **BLOCKED**: no live model key or paid service is
available on the build VM.
