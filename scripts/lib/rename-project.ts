import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Logic of `npm run rename-project`: turns the template name into the name of
// a real project in every text file of the repository. Kept apart from the CLI
// so a test can run it on a temporary directory.

// The name the template ships with. Built from two parts so that a search for
// the template name does not hit this file after the rename.
const TEMPLATE = ["star", "ter"].join("");
const TEMPLATE_DISPLAY = `${TEMPLATE[0]!.toUpperCase()}${TEMPLATE.slice(1)}`;

export const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".data",
  "coverage",
  "storybook-static",
  "test-results",
  "playwright-report",
]);

// The rename tooling is the one place that must keep the template name.
const SKIPPED_FILES = new Set([
  "package-lock.json",
  "scripts/rename-project.ts",
  "scripts/lib/rename-project.ts",
  "tests/scripts/rename-project.test.ts",
]);

export class RenameInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenameInputError";
  }
}

export type RenameNames = Readonly<{ slug: string; displayName: string }>;

export function validateNames(slug: string, displayName: string): RenameNames {
  if (!SLUG_PATTERN.test(slug)) {
    throw new RenameInputError(
      "Slug must match ^[a-z][a-z0-9_]{1,30}$ (lowercase letters, digits and underscores, starting with a letter).",
    );
  }

  if (slug === TEMPLATE) {
    throw new RenameInputError("Slug must differ from the template name.");
  }

  const name = displayName.trim();

  if (name.length === 0 || name.length > 60) {
    throw new RenameInputError("Display name must have 1 to 60 characters.");
  }

  // The name lands in TypeScript strings, JSX text, JSON and Markdown: refuse
  // what would break them or open markup.
  if (/["\\`<>&\u0000-\u001f]|\$\{/.test(name)) {
    throw new RenameInputError(
      "Display name must not contain a double quote, backslash, backtick, < > &, ${ or control characters.",
    );
  }

  return { slug, displayName: name };
}

/** Replaces the template name in one text, in the order that keeps hostnames valid. */
export function renameText(text: string, { slug, displayName }: RenameNames): string {
  const hostSlug = slug.replaceAll("_", "-");

  return (
    text
      // Environment variables and constants: the upper-case form with underscores.
      .replaceAll(TEMPLATE.toUpperCase(), slug.toUpperCase())
      // Repository names (e.g. the sibling directory of the documentation repository).
      .replace(new RegExp(`ai-repo-${TEMPLATE}`, "g"), hostSlug)
      // The GitHub App (bot) of the project and its key folder: GitHub app names
      // use hyphens (`<project>-bot`, `~/.config/<project>-bot/`).
      .replace(new RegExp(`${TEMPLATE}-bot(?![A-Za-z0-9_-])`, "g"), `${hostSlug}-bot`)
      // Hostnames cannot contain an underscore: <name>.example, demo.<name>.local.
      .replace(new RegExp(`${TEMPLATE}(?=\\.(?:example|local)\\b)`, "g"), hostSlug)
      // Identifiers, roles, databases, package and cookie names.
      .replaceAll(TEMPLATE, slug)
      // Name shown to people.
      .replace(new RegExp(`\\b${TEMPLATE_DISPLAY}\\b`, "g"), displayName)
  );
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function listWithGit(root: string): string[] | null {
  if (!existsSync(join(root, ".git"))) {
    return null;
  }

  try {
    const output = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    return output.split("\0").filter((file) => file !== "");
  } catch {
    return null;
  }
}

function listWithWalk(root: string, directory = root): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...listWithWalk(root, join(directory, entry.name)));
      }
    } else if (entry.isFile()) {
      files.push(relative(root, join(directory, entry.name)).split(sep).join("/"));
    }
  }

  return files;
}

/** Repository files that may be renamed: tracked (or untracked and not ignored) text files. */
export function listRenameableFiles(root: string): string[] {
  const listed = listWithGit(root) ?? listWithWalk(root);

  return listed.filter((file) => {
    const parts = file.split("/");

    return !SKIPPED_FILES.has(file) && !parts.some((part) => SKIPPED_DIRECTORIES.has(part));
  });
}

type LockFile = { name?: string; packages?: Record<string, { name?: string }> };

function renameLockfile(root: string, slug: string): boolean {
  const path = join(root, "package-lock.json");

  if (!existsSync(path)) {
    return false;
  }

  const lock = JSON.parse(readFileSync(path, "utf8")) as LockFile;
  let changed = false;

  if (lock.name === TEMPLATE) {
    lock.name = slug;
    changed = true;
  }
  if (lock.packages?.[""]?.name === TEMPLATE) {
    lock.packages[""].name = slug;
    changed = true;
  }
  if (changed) {
    writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
  }

  return changed;
}

export type RenameResult = Readonly<{ changedFiles: string[]; lockfileUpdated: boolean }>;

export function renameProject(root: string, slug: string, displayName: string): RenameResult {
  const names = validateNames(slug, displayName);
  const changedFiles: string[] = [];

  for (const file of listRenameableFiles(root)) {
    const path = join(root, file);

    if (!existsSync(path) || !statSync(path).isFile()) {
      continue;
    }

    const buffer = readFileSync(path);

    if (looksBinary(buffer)) {
      continue;
    }

    const original = buffer.toString("utf8");
    const renamed = renameText(original, names);

    if (renamed !== original) {
      writeFileSync(path, renamed);
      changedFiles.push(file);
    }
  }

  return { changedFiles, lockfileUpdated: renameLockfile(root, names.slug) };
}
