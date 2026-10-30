import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";

const windowApi = vi.hoisted(() => ({
  startResizeDragging: vi.fn<(direction: string) => Promise<void>>(async () => {}),
  isMaximized: vi.fn(async () => false),
  isFullscreen: vi.fn(async () => false),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ ...windowApi, onResized: async () => () => {} }),
}));

const { WindowResize } = await import("./WindowResize");

function edges() {
  return document.querySelectorAll<HTMLElement>("[data-window-resize] > div");
}

/** The first resize edge, once the window state has been read. */
async function firstEdge() {
  await vi.waitFor(() => expect(edges()).toHaveLength(8));
  const edge = edges()[0];
  expect(edge).toBeDefined();
  return edge!;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlatform.setState({ os: "windows", framelessTitleBar: true, overlayTitleBar: false });
});
afterEach(() => {
  usePlatform.setState({ os: "macos", framelessTitleBar: false, overlayTitleBar: true });
  document.body.replaceChildren();
});

describe("frameless window resize edges", () => {
  it("hands each edge and corner to the OS resize drag", async () => {
    render(<WindowResize />);
    await vi.waitFor(() => expect(edges()).toHaveLength(8));
    for (const zone of edges()) fireEvent.pointerDown(zone, { button: 0 });
    await vi.waitFor(() =>
      expect(windowApi.startResizeDragging.mock.calls.map(([d]) => d)).toEqual([
        "North",
        "South",
        "West",
        "East",
        "NorthWest",
        "NorthEast",
        "SouthWest",
        "SouthEast",
      ]),
    );
  });

  it("swallows the press so the title bar and editor do not also react", async () => {
    render(<WindowResize />);
    const edge = await firstEdge();
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    edge.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(windowApi.startResizeDragging).toHaveBeenCalledExactlyOnceWith("North"));
  });

  it("ignores presses that are not the primary button", async () => {
    render(<WindowResize />);
    const edge = await firstEdge();
    fireEvent.pointerDown(edge, { button: 2 });
    expect(windowApi.startResizeDragging).not.toHaveBeenCalled();
  });

  it.each(["maximized", "fullscreen"] as const)("draws no edges while %s", async (state) => {
    windowApi.isMaximized.mockResolvedValue(state === "maximized");
    windowApi.isFullscreen.mockResolvedValue(state === "fullscreen");
    render(<WindowResize />);
    await Promise.resolve();
    await Promise.resolve();
    expect(edges()).toHaveLength(0);
  });

  it("draws no edges on a decorated window, where the OS already has them", async () => {
    usePlatform.setState({ framelessTitleBar: false, overlayTitleBar: true });
    render(<WindowResize />);
    await Promise.resolve();
    expect(edges()).toHaveLength(0);
    expect(windowApi.isMaximized).not.toHaveBeenCalled();
  });
});
