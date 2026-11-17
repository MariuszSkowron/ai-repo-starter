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

// ---------------------------------------------------------------------------
// Data inside a command: heredoc bodies and message arguments.
//
// Some text in a command is never run: the body of a heredoc read by `cat`
// (`cat > notes.md <<'EOF'`), the message of `git commit -m '...'` and the
// title and body of `gh pr|issue create|edit|comment`. A hook that reads such
// text as commands blocks a commit message or a run log that merely mentions
// a protected word. The helpers below separate that data and fall back to
// "everything is a command" whenever the text is not plainly data:
//
// - a heredoc body is data only when `cat` reads it and nothing on its line
//   passes the text on (`|`, `>(`, `$(`, backticks), with a quoted delimiter
//   or a body without `$` and backticks; inside a command substitution it is
//   data only as the value of a message flag (`-m "$(cat <<'EOF' ... EOF)"`);
// - a message argument is masked only when it is one quoted word: single
//   quotes, or double quotes without `$` (no variable, no substitution);
// - nothing is masked when Bash and PowerShell could read the quoting
//   differently: a backtick, `$(`, a backslash before a quote, an unclosed
//   quote, typographic quotes, or a here-string that contains its own quote.

const HEREDOC_OPERATOR =
  /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*))/g;
// Text after the heredoc operator that sends the body somewhere else.
const PASSES_TEXT_ON = /[|`]|[<>]\(|\$\(/;
const GIT_MESSAGE_FLAG = /^(?:-[asnvq]*m|--message)$/;
const GH_MESSAGE_FLAG = /^(?:-t|--title|-b|--body)$/;
const GH_MESSAGE_SUBCOMMANDS = new Set(["create", "edit", "comment"]);
const MESSAGE_PLACEHOLDER = "MESSAGE";
const TYPOGRAPHIC_QUOTES = /[\u2018-\u201F]/;

/** The program name of a word: `C:\tools\gh.exe` -> `gh`. */
function programName(word) {
  return baseName(word ?? "").replace(/\.(?:exe|cmd)$/, "");
}

/**
 * The pattern of message flags when the words are `git [-C x|-c x] commit` or
 * `gh [-R x] pr|issue create|edit|comment`; null for any other command.
 */
export function messageFlagPattern(values) {
  const program = programName(values[0]);
  let i = 1;

  if (program === "git") {
    while (i < values.length && /^-[Cc]$/.test(values[i])) i += 2;
    return values[i] === "commit" ? GIT_MESSAGE_FLAG : null;
  }
  if (program === "gh") {
    while (i < values.length && /^(?:-R|--repo)(?:=|$)/.test(values[i])) {
      i += values[i].includes("=") ? 1 : 2;
    }
    const isMessage =
      (values[i] === "pr" || values[i] === "issue") && GH_MESSAGE_SUBCOMMANDS.has(values[i + 1]);
    return isMessage ? GH_MESSAGE_FLAG : null;
  }
  return null;
}

/** True when the text before `$(` ends with a message flag of a message command. */
function endsWithMessageFlag(outer) {
  const segment = outer.split(/[;&|\n(]/).pop() ?? "";
  const open = segment.replace(/"$/, "").replace(/=$/, " ");
  const values = words(open.replace(/["']/g, ""));
  const pattern = messageFlagPattern(values);
  return pattern !== null && values.length > 0 && pattern.test(values[values.length - 1]);
}

/** "plain" or "message" when a heredoc body is data, null when it may be run. */
function heredocContext(prefix, suffix) {
  const pieces = prefix.split(/(\$\(|[;&|(\n])/);
  const own = pieces[pieces.length - 1];
  const opener = pieces[pieces.length - 2];

  if (programName(words(own.replace(/["']/g, ""))[0]) !== "cat") return null;
  if (PASSES_TEXT_ON.test(suffix)) return null;
  if (opener !== "$(") return "plain";
  return endsWithMessageFlag(pieces.slice(0, -2).join("")) ? "message" : null;
}

/** Index of the line that closes a heredoc, or -1. */
function closingLine(lines, from, delimiter, stripTabs) {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, "");
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) return i;
  }
  return -1;
}

/**
 * Splits the bodies of data heredocs off a command. Returns the command
 * without those bodies (`text`) and the lines of the bodies `cat` prints or
 * saves (`data`), which a hook still checks for plainly dangerous lines; the
 * body of a message heredoc is dropped. A heredoc used as a message
 * (`-m "$(cat <<'EOF' ... EOF\n)"`) becomes the word `HEREDOC`. When a
 * heredoc is not closed, nothing is separated.
 */
export function separateHeredocs(command) {
  if (typeof command !== "string" || !command.includes("<<")) return { text: command, data: [] };
  const lines = command.split("\n");
  const out = [];
  const data = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const operators = [...line.matchAll(HEREDOC_OPERATOR)];
    out.push(line);

    for (const operator of operators) {
      const [whole, dash, single, double, escaped, bare] = operator;
      const delimiter = single ?? double ?? escaped ?? bare;
      const end = closingLine(lines, i + 1, delimiter, dash === "-");
      if (end === -1) return { text: command, data: [] };

      const body = lines.slice(i + 1, end);
      const suffix = line.slice(operator.index + whole.length);
      const context = heredocContext(line.slice(0, operator.index), suffix);
      const literal = bare === undefined || !/[$`]/.test(body.join("\n"));

      if (context === null || !literal) {
        out.push(...body, lines[end]);
        i = end;
        continue;
      }
      // A message body is never run; a plain one may be saved to a file and
      // run later, so the hooks still check its lines.
      if (context === "plain") data.push(...body);
      const closing = /^\s*\)(.*)$/.exec(lines[end + 1] ?? "");
      const start = line.lastIndexOf("$(", operator.index);
      if (context === "message" && operators.length === 1 && closing && !suffix.trim()) {
        out[out.length - 1] = `${line.slice(0, start)}HEREDOC${closing[1]}`;
        i = end + 1;
      } else {
        out.push(lines[end]);
        i = end;
      }
    }
  }
  return { text: out.join("\n"), data };
}

/**
 * The quoted spans of a text (`{ start, end, quote }`, `end` = closing quote),
 * or null when Bash and PowerShell could read the quoting differently.
 */
function quotedSpans(text) {
  if (TYPOGRAPHIC_QUOTES.test(text)) return null;
  for (const match of text.matchAll(/@(["'])\r?\n([\s\S]*?)\r?\n\1@/g)) {
    if (match[2].includes(match[1])) return null;
  }
  const spans = [];

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (char === "'" || char === '"') {
      const end = text.indexOf(char, i + 1);
      if (end === -1) return null;
      const inner = text.slice(i + 1, end);
      if (char === '"' && (/`|\$\(/.test(inner) || inner.endsWith("\\"))) return null;
      spans.push({ start: i, end, quote: char });
      i = end;
    } else if (char === "`") return null;
    else if (char === "$" && text[i + 1] === "(") return null;
    else if (char === "\\" && /["']/.test(text[i + 1] ?? "")) return null;
  }
  return spans;
}

/** Simple commands as lists of words; a word is a list of bare and quoted parts. */
function tokenize(text, spans) {
  const spanAt = new Map(spans.map((span) => [span.start, span]));
  const commands = [];
  let current = [];
  let word = null;
  const endWord = () => {
    if (word) current.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (current.length > 0) commands.push(current);
    current = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const span = spanAt.get(i);
    if (span) {
      word ??= [];
      word.push({ span, text: text.slice(span.start + 1, span.end) });
      i = span.end;
    } else if (/[;&|\r\n()]/.test(text[i])) endCommand();
    else if (/\s/.test(text[i])) endWord();
    else {
      word ??= [];
      const last = word[word.length - 1];
      if (last && !last.span) last.text += text[i];
      else word.push({ span: null, text: text[i] });
    }
  }
  endCommand();
  return commands;
}

const wordValue = (word) => word.map((part) => part.text).join("");
const isLiteral = (part) => part.span.quote === "'" || !part.text.includes("$");

/** The quoted part a message flag word carries or points to, or null. */
function messagePart(commandWords, index, pattern) {
  const word = commandWords[index];
  const [first, second] = word;

  if (word.length === 1 && !first.span && pattern.test(first.text)) {
    const next = commandWords[index + 1];
    return next?.length === 1 && next[0].span ? next[0] : null;
  }
  if (word.length === 2 && !first.span && second.span) {
    return pattern.test(first.text.replace(/=$/, "")) ? second : null;
  }
  return null;
}

/**
 * The command (continuations joined) with data made harmless: the quoted
 * message of `git commit` and of `gh pr|issue create|edit|comment` becomes
 * `MESSAGE`, and in the quoted arguments of `readers` (programs that only
 * read) separators and redirect characters (`;&|<>()`, newline) become spaces,
 * so `grep 'a|b' file` stays one segment. With ambiguous quoting the text is
 * returned unchanged.
 */
export function maskShellData(command, { readers = null } = {}) {
  const text = joinContinuations(command);
  const spans = quotedSpans(text);
  if (spans === null) return text;
  const replacements = new Map();

  for (const commandWords of tokenize(text, spans)) {
    const values = commandWords.map(wordValue);
    const pattern = messageFlagPattern(values);

    if (pattern) {
      commandWords.forEach((_, index) => {
        const part = messagePart(commandWords, index, pattern);
        if (part && isLiteral(part)) replacements.set(part.span, MESSAGE_PLACEHOLDER);
      });
    }
    if (readers?.has(programName(values[0]))) {
      for (const part of commandWords.flat()) {
        if (part.span && !replacements.has(part.span)) {
          replacements.set(part.span, part.text.replace(/[;&|<>()\r\n]/g, " "));
        }
      }
    }
  }

  let result = text;
  for (const [span, inner] of [...replacements].sort((a, b) => b[0].start - a[0].start)) {
    result = result.slice(0, span.start + 1) + inner + result.slice(span.end);
  }
  return result;
}
