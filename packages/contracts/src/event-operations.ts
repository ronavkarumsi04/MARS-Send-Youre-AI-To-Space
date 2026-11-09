/**
 * `operation` values of the `tool.completed` payloads that producers
 * (`@mars/workbench`, `@mars/watch`, `@mars/knowledge-graph`) append and
 * `@mars/ui-core` projects into journal entries. Shared so a rename on either
 * side is compile-checked instead of silently falling back to a generic notice.
 */
export const EVENT_OPERATIONS = Object.freeze({
  runtimeResult: "runtime.result",
  hookCompleted: "hook.completed",
  childResult: "child.result",
  watchEvidence: "watch.evidence",
  graphBuild: "graph.build",
  graphQuery: "graph.query",
} as const);

export type EventOperation =
  (typeof EVENT_OPERATIONS)[keyof typeof EVENT_OPERATIONS];
