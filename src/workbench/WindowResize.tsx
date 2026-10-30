/**
 * Resize edges for the frameless window. Windows draws no border and no resize
 * grips around a `decorations: false` window, so the shell has to offer them:
 * thin strips along the four edges and squares in the four corners that hand the
 * pointer to the OS resize drag (issue #410).
 */
import { useEffect, useRef, useState } from "react";
import { usePlatform } from "@/platform/platformInfo";
import styles from "./WindowResize.module.css";
import { withWindow } from "./windowApi";

type Direction = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";
type AppWindow = import("@tauri-apps/api/window").Window;

const DIRECTIONS: ReadonlyArray<[Direction, string | undefined]> = [
  ["North", styles.north],
  ["South", styles.south],
  ["West", styles.west],
  ["East", styles.east],
  ["NorthWest", styles.northWest],
  ["NorthEast", styles.northEast],
  ["SouthWest", styles.southWest],
  ["SouthEast", styles.southEast],
];

/** Whether the window currently has edges to drag: frameless, not maximized, not fullscreen. */
function useResizable(window: { current: AppWindow | null }) {
  const frameless = usePlatform((s) => s.framelessTitleBar);
  const [resizable, setResizable] = useState(false);

  useEffect(() => {
    if (!frameless) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    withWindow(async (w) => {
      if (disposed) return;
      window.current = w;
      // A maximized or fullscreen window has no edges to drag; grips there would
      // only swallow presses meant for the title bar or the content.
      const sync = () =>
        void Promise.all([w.isMaximized(), w.isFullscreen()]).then(
          ([maximized, fullscreen]) => !disposed && setResizable(!maximized && !fullscreen),
        );
      sync();
      const off = await w.onResized(sync);
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      window.current = null;
      unlisten?.();
    };
  }, [frameless, window]);

  return frameless && resizable;
}

export function WindowResize() {
  const win = useRef<AppWindow | null>(null);
  const resizable = useResizable(win);
  if (!resizable) return null;
  return (
    <div className={styles.zones} aria-hidden data-window-resize>
      {DIRECTIONS.map(([direction, className]) => (
        <div
          key={direction}
          className={className}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            // Keep the title bar's drag region and the editor from seeing the press.
            e.preventDefault();
            e.stopPropagation();
            void win.current?.startResizeDragging(direction);
          }}
        />
      ))}
    </div>
  );
}
