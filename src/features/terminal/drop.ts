/**
 * Files dropped from the OS onto a terminal: the path is pasted at the prompt
 * (shell-quoted when needed), one line per file, instead of the window-wide
 * drop (open in the editor, "Open project in" for a folder) or the browser /
 * shell falling through to a system dialog. Images are treated the same way:
 * showing the path is the expected behaviour.
 */
import { formatArgs } from "@/platform/commandLine";
import { registerFileDropHandler } from "@/workbench/fileDrop";

/** Shell-quoted paths joined for the prompt, one per line. */
export function droppedPathsText(paths: readonly string[]): string {
  return paths.map((p) => formatArgs([p])).join("\n");
}

/** Registers the terminal's drop handler; the disposer unregisters it. */
export function installTerminalDrop(paste: (text: string) => void): () => void {
  return registerFileDropHandler((paths, x, y) => {
    const el = document.elementFromPoint(x, y)?.closest?.<HTMLElement>("[data-terminal-session]");
    if (!el || !paths.length) return false;
    paste(`${droppedPathsText(paths)}\n`);
    return true;
  });
}
