/** Runs `run` with the current window, loading the Tauri window API only in the desktop shell. */
export function withWindow(run: (w: import("@tauri-apps/api/window").Window) => unknown): Promise<unknown> {
  return import("@tauri-apps/api/window").then(({ getCurrentWindow }) => run(getCurrentWindow()));
}
