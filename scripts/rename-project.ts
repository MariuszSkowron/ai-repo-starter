// Renames the template to a real project: identifiers, database role and
// database names, package name, cookie prefix and the name shown in the UI.
//
// Run once, right after creating a repository from the template:
//   npm run rename-project -- my_app "My App"
// (slug: lowercase letters, digits, underscores; then the display name.)
// Afterwards delete scripts/rename-project.ts, scripts/lib/rename-project.ts and
// tests/scripts/rename-project.test.ts, and the `rename-project` npm script.
import { RenameInputError, renameProject } from "./lib/rename-project";

function main() {
  const [slug, displayName, ...rest] = process.argv.slice(2);

  if (slug === undefined || displayName === undefined || rest.length > 0) {
    throw new RenameInputError('Usage: npm run rename-project -- <slug> "<Display Name>"');
  }

  const { changedFiles, lockfileUpdated } = renameProject(process.cwd(), slug, displayName);

  for (const file of changedFiles) {
    console.log(`Renamed: ${file}`);
  }
  console.log(
    `Done: ${changedFiles.length} files${lockfileUpdated ? ", package-lock.json name fields" : ""}.`,
  );
  console.log("Run npm run check before committing.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
