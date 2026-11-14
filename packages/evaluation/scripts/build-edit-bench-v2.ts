/**
 * Builds fixtures/edit-benchmark/v2 from pinned, permissively licensed public
 * repositories. Each task copies one real source file (`before/`) and applies
 * one fully specified, mechanical edit to produce `after/`; the instruction
 * states exactly what to change, so the outcome is checkable byte for byte.
 * Selection is deterministic (sha256 of the source, file and generator), so
 * re-running against the same commits reproduces the suite.
 *
 *   bun packages/evaluation/scripts/build-edit-bench-v2.ts --sources DIR
 *
 * DIR holds checkouts named by `checkout` below, at the pinned commits.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface Source {
  slug: string;
  repository: string;
  commit: string;
  license: string;
  licenseFile: string;
  checkout: string;
  language: string;
  extensions: string[];
}

const SOURCES: Source[] = [
  {
    slug: "click",
    repository: "https://github.com/pallets/click",
    commit: "e38188e9e205005d5af5f9e59df51904c984586a",
    license: "BSD-3-Clause",
    licenseFile: "LICENSE.txt",
    checkout: "click",
    language: "python",
    extensions: [".py"],
  },
  {
    slug: "requests",
    repository: "https://github.com/psf/requests",
    commit: "3c7baaa05ab4aa49cc819ce3a819d260de19c157",
    license: "Apache-2.0",
    licenseFile: "LICENSE",
    checkout: "requests",
    language: "python",
    extensions: [".py"],
  },
  {
    slug: "express",
    repository: "https://github.com/expressjs/express",
    commit: "43fca52d28a422c8be48fd489cbd4f2d6152bab6",
    license: "MIT",
    licenseFile: "LICENSE",
    checkout: "express",
    language: "javascript",
    extensions: [".js"],
  },
  {
    slug: "ky",
    repository: "https://github.com/sindresorhus/ky",
    commit: "3541888878c4d303a8bc2ad61815f4e048f55a5d",
    license: "MIT",
    licenseFile: "license",
    checkout: "ky",
    language: "typescript",
    extensions: [".ts"],
  },
  {
    slug: "cobra",
    repository: "https://github.com/spf13/cobra",
    commit: "adbc8813901bba65827259daa8e22ff94ec1f30e",
    license: "Apache-2.0",
    licenseFile: "LICENSE.txt",
    checkout: "cobra",
    language: "go",
    extensions: [".go"],
  },
  {
    slug: "toml",
    repository: "https://github.com/BurntSushi/toml",
    commit: "d733fc535e4a9f3c454e421a87b90ade5d49bf31",
    license: "MIT",
    licenseFile: "COPYING",
    checkout: "toml",
    language: "go",
    extensions: [".go"],
  },
  {
    slug: "walkdir",
    repository: "https://github.com/BurntSushi/walkdir",
    commit: "6fd031c82ba5a4204b4ce6eae73dacb00dc072ec",
    license: "MIT OR Unlicense",
    licenseFile: "LICENSE-MIT",
    checkout: "walkdir",
    language: "rust",
    extensions: [".rs"],
  },
  {
    slug: "sds",
    repository: "https://github.com/antirez/sds",
    commit: "5347739b1581fcba74fd5cab1fc21d2aef317d71",
    license: "BSD-2-Clause",
    licenseFile: "LICENSE",
    checkout: "sds",
    language: "c",
    extensions: [".c", ".h"],
  },
];

const PER_SOURCE = {
  multi_site: 5,
  whitespace_sensitive: 5,
  large_file: 4,
  repeated_lines: 4,
} as const;
type Category = keyof typeof PER_SOURCE;
const CREATED = "2026-11-14";
const MAX_BYTES = 120_000;
const LARGE_LINES = 500;
const MARKER = "mars-bench: reviewed";
const KEYWORDS = new Set(
  "self this true false null None True False return function const class import from export default async await yield while break continue struct impl match where type interface package func string error bool byte uint8 int64 uint64 float64 static unsigned signed char void size_t sizeof include define endif ifdef ifndef else elif except raise pass with lambda global assert".split(
    " ",
  ),
);

interface Task {
  task_id: string;
  category: Category;
  complexity: "light" | "medium" | "heavy";
  instruction: string;
  path: string;
  before: string;
  after: string;
  notes: string;
}

const digest = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\0")).digest("hex");
const order = <T>(items: T[], key: (item: T) => string, salt: string) =>
  [...items].sort((a, b) =>
    digest(salt, key(a)).localeCompare(digest(salt, key(b))),
  );
const comment = (language: string) => (language === "python" ? "#" : "//");
// Lines where inserting/appending a line comment is safe: not inside or next
// to string/comment blocks, continuations or preprocessor directives.
const plainLine = (line: string) => {
  const t = line.trim();
  return (
    t.length >= 8 &&
    t.length <= 120 &&
    !/["'`\\]/.test(t) &&
    !/\/\*|\*\/|^\*|^#|^\/\/|^@|^\)|^\]|^}|^\.|,$|\($|\[$|\\$|^(else|elif|except|finally|case|default)\b/.test(
      t,
    ) &&
    !t.includes("//") &&
    !t.includes("#")
  );
};

function insideBlockString(lines: string[], index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i += 1) {
    const count = (lines[i]?.match(/"""|'''|`/g) ?? []).length;
    if (count % 2 === 1) open = !open;
  }
  return open;
}

function renameTask(
  src: Source,
  path: string,
  text: string,
  n: number,
): Task | null {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(
    /(?<![A-Za-z0-9_$.])[a-z_][A-Za-z0-9_]{4,}(?![A-Za-z0-9_$])/g,
  ))
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const candidates = [...counts]
    .filter(
      ([name, count]) =>
        count >= 3 &&
        count <= 12 &&
        !KEYWORDS.has(name) &&
        !name.startsWith("__"),
    )
    .map(([name]) => name);
  for (const name of order(
    candidates,
    (c) => c,
    `rename:${src.slug}:${path}:${n}`,
  )) {
    const renamed =
      src.language === "python" ||
      src.language === "rust" ||
      src.language === "c"
        ? `${name}_v2`
        : `${name}V2`;
    const word = new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, "g");
    if (text.includes(renamed)) continue;
    // Skip names that also appear as part of a dotted/qualified access from other modules.
    if (new RegExp(`\\.${name}(?![A-Za-z0-9_$])`).test(text)) continue;
    const after = text.replace(word, renamed);
    const sites = text.match(word)?.length ?? 0;
    return {
      task_id: "",
      category: "multi_site",
      complexity: sites > 6 ? "medium" : "light",
      instruction: `In \`${path}\`, rename the identifier \`${name}\` to \`${renamed}\` at every whole-word occurrence in the file (${sites} occurrences, including any in comments or strings). Change nothing else.`,
      path,
      before: text,
      after,
      notes: `Whole-word rename of \`${name}\` at ${sites} sites in one real file.`,
    };
  }
  return null;
}

function whitespaceTask(
  src: Source,
  path: string,
  text: string,
  n: number,
): Task | null {
  const lines = text.split("\n");
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        /^(\t+| {4,})\S/.test(line) &&
        plainLine(line) &&
        lines.indexOf(line) === lines.lastIndexOf(line) &&
        plainLine(lines[index - 1] ?? "") &&
        !insideBlockString(lines, index),
    );
  const [pick] = order(
    candidates,
    (c) => String(c.index),
    `ws:${src.slug}:${path}:${n}`,
  );
  if (!pick) return null;
  const indent = /^\s*/.exec(pick.line)?.[0] ?? "";
  const kind = indent.startsWith("\t")
    ? `${indent.length} tab(s)`
    : `${indent.length} spaces`;
  const inserted = `${indent}${comment(src.language)} ${MARKER}`;
  const after = [
    ...lines.slice(0, pick.index),
    inserted,
    ...lines.slice(pick.index),
  ].join("\n");
  return {
    task_id: "",
    category: "whitespace_sensitive",
    complexity: "light",
    instruction: `In \`${path}\`, insert a new line containing the comment \`${comment(src.language)} ${MARKER}\` immediately before line ${pick.index + 1} (\`${pick.line.trim()}\`). Indent the new line with exactly the same leading whitespace as line ${pick.index + 1} (${kind}). Change nothing else.`,
    path,
    before: text,
    after,
    notes: `Indentation-exact insertion (${kind}) in a ${src.language} file.`,
  };
}

function largeTask(
  src: Source,
  path: string,
  text: string,
  n: number,
): Task | null {
  const lines = text.split("\n");
  if (lines.length < LARGE_LINES) return null;
  const candidates = lines
    .map((line, index) => {
      const m = /(["'])([A-Za-z][A-Za-z0-9 _.:-]{2,30})\1/.exec(line);
      return { line, index, quote: m?.[1] ?? '"', literal: m?.[2] };
    })
    .filter(
      (c) =>
        c.literal &&
        c.index > lines.length * 0.4 &&
        lines.indexOf(c.line) === lines.lastIndexOf(c.line) &&
        !insideBlockString(lines, c.index) &&
        !c.line.includes("\\"),
    );
  const [pick] = order(
    candidates,
    (c) => String(c.index),
    `large:${src.slug}:${path}:${n}`,
  );
  if (candidates.length < 4 && n % 2 === 1)
    return deepInsertTask(src, path, text, n);
  if (!pick?.literal) return deepInsertTask(src, path, text, n);
  const changed = `${pick.literal}_v2`;
  const q = pick.quote;
  const updated = pick.line.replace(
    `${q}${pick.literal}${q}`,
    `${q}${changed}${q}`,
  );
  const after = [
    ...lines.slice(0, pick.index),
    updated,
    ...lines.slice(pick.index + 1),
  ].join("\n");
  return {
    task_id: "",
    category: "large_file",
    complexity: lines.length > 1000 ? "heavy" : "medium",
    instruction: `In \`${path}\` (${lines.length} lines), on line ${pick.index + 1} (\`${pick.line.trim()}\`), change the string literal \`${q}${pick.literal}${q}\` to \`${q}${changed}${q}\`. Change nothing else.`,
    path,
    before: text,
    after,
    notes: `Single-literal change at line ${pick.index + 1} of ${lines.length}.`,
  };
}

function deepInsertTask(
  src: Source,
  path: string,
  text: string,
  n: number,
): Task | null {
  const lines = text.split("\n");
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line, index }) =>
        index > lines.length * 0.5 &&
        /^\s+\S/.test(line) &&
        plainLine(line) &&
        lines.indexOf(line) === lines.lastIndexOf(line) &&
        plainLine(lines[index - 1] ?? "") &&
        !insideBlockString(lines, index),
    );
  const [pick] = order(
    candidates,
    (c) => String(c.index),
    `deep:${src.slug}:${path}:${n}`,
  );
  if (!pick) return null;
  const indent = /^\s*/.exec(pick.line)?.[0] ?? "";
  const after = [
    ...lines.slice(0, pick.index),
    `${indent}${comment(src.language)} ${MARKER}`,
    ...lines.slice(pick.index),
  ].join("\n");
  return {
    task_id: "",
    category: "large_file",
    complexity: lines.length > 1000 ? "heavy" : "medium",
    instruction: `In \`${path}\` (${lines.length} lines), insert a new line containing the comment \`${comment(src.language)} ${MARKER}\` immediately before line ${pick.index + 1} (\`${pick.line.trim()}\`), indented exactly like that line. Change nothing else.`,
    path,
    before: text,
    after,
    notes: `Insertion at line ${pick.index + 1} of ${lines.length}.`,
  };
}

function repeatedTask(
  src: Source,
  path: string,
  text: string,
  n: number,
): Task | null {
  const lines = text.split("\n");
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (plainLine(line) && !insideBlockString(lines, index))
      groups.set(line, [...(groups.get(line) ?? []), index]);
  });
  const candidates = [...groups].filter(
    ([, at]) => at.length >= 2 && at.length <= 12,
  );
  const [pick] = order(
    candidates,
    ([line]) => line,
    `repeat:${src.slug}:${path}:${n}`,
  );
  if (!pick) return null;
  const [line, at] = pick;
  const which =
    Number.parseInt(digest("which", src.slug, path, line).slice(0, 8), 16) %
    at.length;
  const index = at[which] as number;
  const ordinal = [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
  ][which];
  const after = lines
    .map((l, i) =>
      i === index ? `${l} ${comment(src.language)} ${MARKER}` : l,
    )
    .join("\n");
  return {
    task_id: "",
    category: "repeated_lines",
    complexity: "light",
    instruction: `In \`${path}\`, the line \`${line.trim()}\` appears ${at.length} times. Append \` ${comment(src.language)} ${MARKER}\` to the end of only its ${ordinal} occurrence (line ${index + 1}), leaving the other occurrences unchanged. Change nothing else.`,
    path,
    before: text,
    after,
    notes: `Disambiguating one of ${at.length} identical lines.`,
  };
}

const GENERATORS: Record<
  Category,
  (src: Source, path: string, text: string, n: number) => Task | null
> = {
  multi_site: renameTask,
  whitespace_sensitive: whitespaceTask,
  large_file: largeTask,
  repeated_lines: repeatedTask,
};
const SHORT: Record<Category, string> = {
  multi_site: "rename",
  whitespace_sensitive: "indent",
  large_file: "large",
  repeated_lines: "repeat",
};

async function main() {
  const { values } = parseArgs({ options: { sources: { type: "string" } } });
  if (!values.sources) throw new Error("--sources DIR is required");
  const out = fileURLToPath(
    new URL("../fixtures/edit-benchmark/v2", import.meta.url),
  );
  await rm(out, { recursive: true, force: true });
  const tasks: Task[] = [];
  const sourcesMeta = [];
  for (const src of SOURCES) {
    const root = join(values.sources, src.checkout);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (head !== src.commit)
      throw new Error(
        `${src.slug}: checkout is at ${head}, expected ${src.commit}`,
      );
    const files: Array<{ path: string; text: string }> = [];
    for (const path of execFileSync("git", ["-C", root, "ls-files"], {
      encoding: "utf8",
    }).split("\n")) {
      if (!src.extensions.some((ext) => path.endsWith(ext))) continue;
      if (
        /(^|\/)(tests?|test-d|testdata|toml-test|vendor|examples?|docs?|benches|fuzz)(\/|$)|_test\.|\.test\.|test_/.test(
          path,
        )
      )
        continue;
      const size = (await stat(join(root, path))).size;
      if (size > MAX_BYTES) continue;
      const text = await readFile(join(root, path), "utf8");
      if (text.split("\n").length < 60 || text.includes("\r")) continue;
      files.push({ path, text });
    }
    const used = new Set<string>();
    for (const category of Object.keys(PER_SOURCE) as Category[]) {
      let made = 0;
      const pool = order(files, (f) => f.path, `${category}:${src.slug}`);
      for (let round = 0; round < 8 && made < PER_SOURCE[category]; round += 1)
        for (const file of pool) {
          if (made >= PER_SOURCE[category]) break;
          const key = `${category}:${file.path}`;
          if (used.has(key) && round === 0) continue;
          const task = GENERATORS[category](src, file.path, file.text, round);
          if (!task || task.after === task.before) continue;
          if (
            tasks.some(
              (t) => t.path === task.path && t.instruction === task.instruction,
            )
          )
            continue;
          used.add(key);
          made += 1;
          tasks.push({
            ...task,
            task_id: `${src.slug}-${SHORT[category]}-${made}`,
            source: src,
          } as Task);
        }
      if (made < PER_SOURCE[category])
        throw new Error(`${src.slug}: only ${made} ${category} tasks`);
    }
    await mkdir(join(out, "licenses"), { recursive: true });
    await writeFile(
      join(out, "licenses", `${src.slug}.txt`),
      await readFile(join(root, src.licenseFile)),
    );
    sourcesMeta.push({
      slug: src.slug,
      repository: src.repository,
      commit: src.commit,
      license: src.license,
      license_file: `licenses/${src.slug}.txt`,
      language: src.language,
    });
  }
  for (const task of tasks as Array<Task & { source: Source }>) {
    const dir = join(out, "tasks", task.task_id);
    for (const [side, body] of [
      ["before", task.before],
      ["after", task.after],
    ] as const) {
      await mkdir(dirname(join(dir, side, task.path)), { recursive: true });
      await writeFile(join(dir, side, task.path), body);
    }
    await writeFile(
      join(dir, "task.json"),
      `${JSON.stringify(
        {
          schema: "mars.edit-benchmark-task/v1",
          task_id: task.task_id,
          category: task.category,
          complexity: task.complexity,
          instruction: task.instruction,
          provenance: {
            origin: "derived",
            created: CREATED,
            author: "build-edit-bench-v2.ts (MARS S3 follow-up)",
            notes: `${task.notes} before/ is the unmodified upstream file; after/ applies the instructed edit.`,
            source: {
              repository: task.source.repository,
              commit: task.source.commit,
              license: task.source.license,
              path: task.path,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  await writeFile(
    join(out, "suite.json"),
    `${JSON.stringify(
      {
        schema: "mars.edit-benchmark-suite/v1",
        suite_id: "mars-edit-heldout-v2",
        revision: "2",
        domain: "code/edit",
        tasks: tasks.map((t) => t.task_id),
        provenance: {
          origin: "derived",
          created: CREATED,
          author: "build-edit-bench-v2.ts (MARS S3 follow-up)",
          statement:
            "Each task is one unmodified file from a pinned commit of a permissively licensed public repository (see sources and licenses/) plus one fully specified mechanical edit generated deterministically by packages/evaluation/scripts/build-edit-bench-v2.ts. Instructions and expected trees are new; registered as held-out split mars-edit-heldout-v2.",
        },
        sources: sourcesMeta,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${tasks.length} tasks written to ${out}`);
}

await main();
