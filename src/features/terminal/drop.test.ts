import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { droppedPathsText, installTerminalDrop } from "./drop";

beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", {}));

describe("terminal drop", () => {
  it("quotes paths with spaces and joins files with newlines", () => {
    expect(droppedPathsText(["/plain/file.ts"])).toBe("/plain/file.ts");
    expect(droppedPathsText(["/a b/c.png", "/plain", "C:/dir/e f"])).toBe("'/a b/c.png'\n/plain\n'C:/dir/e f'");
  });

  it("pastes the drop on the terminal under the cursor, once per registration", async () => {
    const list = vi.spyOn(commands, "clipboardFileList");
    const host = document.createElement("div");
    host.dataset.terminalSession = "s1";
    const elsewhere = document.createElement("div");
    document.body.replaceChildren(host, elsewhere);
    document.elementFromPoint = ((x: number) => (x === 1 ? host : elsewhere)) as typeof document.elementFromPoint;
    const pasted: string[] = [];
    const remove = installTerminalDrop((text) => pasted.push(text));
    const { handleFileDrop } = await import("@/workbench/fileDrop");
    try {
      await handleFileDrop(["/a b", "/plain"], 1, 1);
      await handleFileDrop(["/img/pic.png"], 9, 9);
      expect(pasted).toEqual(["'/a b'\n/plain\n"]);
      expect(list).not.toHaveBeenCalled();
      remove();
      await handleFileDrop(["/late"], 1, 1);
      expect(pasted).toHaveLength(1);
    } finally {
      document.body.replaceChildren();
    }
  });
});
