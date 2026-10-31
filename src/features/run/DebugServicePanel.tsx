/**
 * Read-only console of a live debug session shown in the Services detail pane:
 * the application's stdout/stderr and debugger output of `useDebug`, with a
 * small toolbar (stop / resume / rerun / clear) instead of the debug window's
 * evaluate input.
 */
import { useLayoutEffect, useRef } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IconButton, showContextMenu } from "@/ui";
import { spanStyle } from "@/ui/ansi";
import ansi from "@/ui/ansi.module.css";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import type { DebugRunSession } from "@/workbench/contributions";
import { clearConsole, useDebug } from "@/features/debugger/state";
import { tx } from "@/platform/i18n";
import styles from "./DebugServicePanel.module.css";

export function DebugServicePanel({ session }: { session: DebugRunSession }) {
  const lines = useDebug((s) => s.console[session.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const programmatic = useRef(false);

  const virtualizer = useVirtualizer({
    count: lines?.length ?? 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 18,
    overscan: 30,
    getItemKey: (i) => lines?.[i]?.id ?? i,
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current || !lines?.length) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  }, [lines, virtualizer]);

  return (
    <div className={styles.session}>
      <div className={styles.toolbar} role="toolbar" aria-orientation="vertical" aria-label={tx("Debug actions")}>
        {session.rerun && <IconButton icon="rerun" iconSize={14} title="Rerun" onClick={() => session.rerun!()} />}
        {session.paused && <IconButton icon="resume" iconSize={14} title="Resume" onClick={() => session.resume()} />}
        <IconButton icon="stop" iconSize={13} title="Stop" tone="danger" onClick={() => session.stop()} />
        <div className={styles.toolbarSep} />
        <IconButton icon="trash" iconSize={14} title="Clear All" onClick={() => clearConsole(session.id)} />
      </div>
      <div
        ref={scroller}
        className={clsx(styles.consoleOutput, ansi.palette)}
        onScroll={(e) => {
          if (programmatic.current) return;
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e, [{ label: "Clear All", icon: "trash", run: () => clearConsole(session.id) }]);
        }}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
        aria-label={tx`${session.name} debug output`}
        tabIndex={0}
      >
        <div className={styles.consoleInner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const l = lines?.[item.index];
            if (!l) return null;
            return (
              <span
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className={clsx(styles.out, styles[`cat-${l.category}`])}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {l.spans.map((sp, i) => (
                  <span key={i} style={spanStyle(sp)}>
                    {sp.text}
                  </span>
                ))}
              </span>
            );
          })}
        </div>
        {!lines?.length && <div className={styles.empty}>{tx`No output yet`}</div>}
      </div>
    </div>
  );
}
