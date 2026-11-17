// Shared text helpers of the PreToolUse hooks. The hooks never run the command;
// they read its text. These helpers turn the text into something the checks
// can rely on, erring on the side of "suspicious":
//
// - line continuations (`\` + newline in Bash, backtick + newline in
//   PowerShell) are joined, so a command split over lines reads as one;
// - segments are cut at every command separator (`;`, `&`, `|`, newline),
//   also inside quotes (a quoted part never makes a command look safer);
// - detection variants remove the quoting and escape characters that a shell
//   would remove (`m"er"ge`, `m\erge`, PowerShell `` mer`ge ``), so an
//   obfuscated word reads as the word it becomes.

/**
 * Joins Bash and PowerShell line continuations the way the shell does: the
 * escape and the newline disappear, so `.e\<newline>nv` reads as `.env`.
 */
export function joinContinuations(command) {
  return command.replace(/[\\`]\r?\n/g, "");
}

/** Command segments: the text between separators, trimmed, without empty ones. */
export function splitSegments(command) {
  return joinContinuations(command)
    .split(/[;&|\r\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Detection variants of a text: as typed, without quotes and backticks, and
 * additionally without backslashes. A check runs on every variant; a Windows
 * path (`C:\tools\gh.exe`) survives in the first two, a Bash escape
 * (`g\h`) is resolved in the last one.
 */
export function detectionVariants(text) {
  const unquoted = text.replace(/["'`]/g, "");

  return [...new Set([text, unquoted, unquoted.replace(/\\/g, "")])];
}

/** Whitespace-separated words. */
export function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** The file name of a word that may be a path (`C:\tools\gh.exe` -> `gh.exe`). */
export function baseName(word) {
  return word.split(/[\\/]/).pop().toLowerCase();
}

/** A shell/PowerShell glob as a regular expression over one file name. */
export function globToRegExp(glob) {
  let source = "";

  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];

    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        source += "\\{";
        continue;
      }
      const options = glob.slice(i + 1, end).split(",");
      source += `(?:${options.map((option) => option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}
