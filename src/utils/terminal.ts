import { exec, spawn } from "child_process";
import { promisify } from "util";
import { getPreferenceValues } from "@raycast/api";
import { existsSync } from "fs";

const execAsync = promisify(exec);

export type TerminalApp = "ghostty" | "iterm" | "terminal" | "auto";

interface TerminalPreferences {
  terminal: TerminalApp;
}

const GHOSTTY_CLI_BUNDLE_PATH = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const ITERM_APP_PATH = "/Applications/iTerm.app";

// Cache terminal detection results to avoid repeated filesystem/PATH checks
let ghosttyBinaryCache: string | null | undefined = undefined;
let itermInstalledCache: boolean | undefined = undefined;

/**
 * Find the Ghostty CLI binary path.
 * Checks PATH first (for Homebrew or user-configured installs),
 * then falls back to the app bundle location.
 */
async function findGhosttyBinary(): Promise<string | null> {
  if (ghosttyBinaryCache !== undefined) return ghosttyBinaryCache;

  // Check PATH first (covers Homebrew, user symlinks, shell integration)
  try {
    const { stdout } = await execAsync("which ghostty");
    const path = stdout.trim();
    if (path) {
      console.log(`[Terminal] Found ghostty in PATH: ${path}`);
      ghosttyBinaryCache = path;
      return path;
    }
  } catch {
    // Not in PATH, continue checking
  }

  // Check the app bundle binary (standard .dmg install)
  if (existsSync(GHOSTTY_CLI_BUNDLE_PATH)) {
    console.log(`[Terminal] Found ghostty in app bundle: ${GHOSTTY_CLI_BUNDLE_PATH}`);
    ghosttyBinaryCache = GHOSTTY_CLI_BUNDLE_PATH;
    return GHOSTTY_CLI_BUNDLE_PATH;
  }

  console.log("[Terminal] Ghostty not found");
  ghosttyBinaryCache = null;
  return null;
}

/**
 * Check if Ghostty terminal is installed
 */
export async function isGhosttyInstalled(): Promise<boolean> {
  return (await findGhosttyBinary()) !== null;
}

/**
 * Check if iTerm2 is installed
 */
export function isItermInstalled(): boolean {
  if (itermInstalledCache !== undefined) return itermInstalledCache;
  itermInstalledCache = existsSync(ITERM_APP_PATH);
  console.log(`[Terminal] iTerm2 installed: ${itermInstalledCache}`);
  return itermInstalledCache;
}

/**
 * Auto-detect the best available terminal.
 * Priority: Ghostty > iTerm2 > Terminal.app
 */
async function detectTerminal(): Promise<"ghostty" | "iterm" | "terminal"> {
  if (await isGhosttyInstalled()) return "ghostty";
  if (isItermInstalled()) return "iterm";
  return "terminal";
}

/**
 * Resolve which terminal to use based on the user's Raycast preference
 * and what's actually installed. Falls back gracefully if the preferred
 * terminal isn't available.
 */
async function resolveTerminal(): Promise<"ghostty" | "iterm" | "terminal"> {
  let preference: TerminalApp = "auto";
  try {
    const prefs = getPreferenceValues<TerminalPreferences>();
    preference = prefs.terminal || "auto";
  } catch {
    // Preferences might not be available in all contexts
    preference = "auto";
  }

  if (preference === "auto") {
    const detected = await detectTerminal();
    console.log(`[Terminal] Auto-detected: ${detected}`);
    return detected;
  }

  // Validate the preferred terminal is actually installed
  if (preference === "ghostty" && !(await isGhosttyInstalled())) {
    console.warn("[Terminal] Ghostty preferred but not installed, falling back to auto-detect");
    return await detectTerminal();
  }
  if (preference === "iterm" && !isItermInstalled()) {
    console.warn("[Terminal] iTerm2 preferred but not installed, falling back to auto-detect");
    return await detectTerminal();
  }

  console.log(`[Terminal] Using preferred terminal: ${preference}`);
  return preference;
}

/**
 * Open a command in the user's preferred terminal application.
 *
 * Detection priority: User preference > Ghostty > iTerm2 > Terminal.app
 *
 * The terminal window stays open after the command finishes so the user
 * can continue interacting with the shell.
 *
 * @param command - The shell command to execute in the new terminal window
 * @param title - Optional window title (best-effort, not all terminals support it)
 * @returns The display name of the terminal that was used
 */
export async function openInTerminal(command: string, title?: string): Promise<string> {
  const terminal = await resolveTerminal();
  console.log(`[Terminal] Opening in ${terminal}: ${command}`);

  switch (terminal) {
    case "ghostty":
      return await openInGhostty(command, title);
    case "iterm":
      return await openInIterm(command, title);
    case "terminal":
    default:
      return await openInMacTerminal(command, title);
  }
}

// ─── Ghostty ──────────────────────────────────────────────────────────────────

/**
 * Open a command in Ghostty terminal.
 *
 * Ghostty's `-e` on macOS goes through `/usr/bin/login`, which:
 *  1. Uses a restricted PATH (no /usr/local/bin, /opt/homebrew/bin, etc.)
 *  2. Flattens all arguments into a single command line
 *
 * This means programs like `docker` can't be found, and complex commands
 * with semicolons or pipes break.
 *
 * Workaround: write the command to a temp script and launch it with
 * `/bin/bash -l <script>`. The `-l` flag makes bash load the user's
 * profile (~/.bash_profile, ~/.profile) which sets up the full PATH,
 * and `/bin/bash` is an absolute path that login can always resolve.
 */
async function openInGhostty(command: string, title?: string): Promise<string> {
  const ghosttyBin = await findGhosttyBinary();
  if (!ghosttyBin) {
    console.warn("[Terminal] Ghostty binary not found at execution time, falling back to Terminal.app");
    return await openInMacTerminal(command, title);
  }

  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs/promises");

  const scriptPath = path.join(os.tmpdir(), `yb-ghostty-${Date.now()}.sh`);
  const scriptContent = `#!/bin/bash\n${command}\n`;
  await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

  const child = spawn(ghosttyBin, ["-e", "/bin/bash", "-l", scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Clean up after Ghostty has had time to read the script
  setTimeout(async () => {
    try {
      await fs.unlink(scriptPath);
    } catch {
      /* ignore */
    }
  }, 10000);

  return "Ghostty";
}

// ─── iTerm2 ───────────────────────────────────────────────────────────────────

/**
 * Open a command in iTerm2 via AppleScript.
 * Creates a new window with the default profile and runs the command.
 */
async function openInIterm(command: string, title?: string): Promise<string> {
  const escapedCommand = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Build AppleScript - create a new window and optionally set the session title
  const titleScript = title
    ? `
    tell current session of current window
      set name to "${title.replace(/"/g, '\\"')}"
    end tell`
    : "";

  const appleScript = `tell application "iTerm2"
  activate
  create window with default profile command "${escapedCommand}"${titleScript}
end tell`;

  // Use heredoc-style approach for cleaner escaping
  await execAsync(`osascript <<'APPLESCRIPT'
${appleScript}
APPLESCRIPT`);

  return "iTerm2";
}

// ─── Terminal.app ─────────────────────────────────────────────────────────────

/**
 * Open a command in macOS Terminal.app via AppleScript (default fallback).
 */
async function openInMacTerminal(command: string, title?: string): Promise<string> {
  const escapedCommand = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const titleScript = title
    ? `
  set custom title of front window to "${title.replace(/"/g, '\\"')}"`
    : "";

  const appleScript = `tell application "Terminal"
  activate
  do script "${escapedCommand}"${titleScript}
end tell`;

  await execAsync(`osascript <<'APPLESCRIPT'
${appleScript}
APPLESCRIPT`);

  return "Terminal";
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Get the human-readable name of the terminal that will be used.
 * Useful for showing in toast messages, e.g. "Opening in Ghostty..."
 */
export async function getTerminalDisplayName(): Promise<string> {
  const terminal = await resolveTerminal();
  switch (terminal) {
    case "ghostty":
      return "Ghostty";
    case "iterm":
      return "iTerm2";
    case "terminal":
      return "Terminal";
  }
}

/**
 * Clear the detection cache. Useful if the user installs a terminal
 * while the extension is running.
 */
export function clearTerminalCache(): void {
  ghosttyBinaryCache = undefined;
  itermInstalledCache = undefined;
}
