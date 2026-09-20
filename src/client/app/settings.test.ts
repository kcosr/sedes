// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClickNamesToFilter,
  setClickNamesToFilter,
  subscribeClickNamesToFilter,
  getActivityDetail,
  getChatAtmosphereEnabled,
  getDiffLineWrap,
  getDiagnosticCategoryEnabled,
  getPromptsPlacement,
  getMobileComposerRefocusAfterSend,
  getMobileHistorySeekControl,
  getPanelPresentation,
  getRightOptionFocusesComposer,
  getSeekOnSubmit,
  getSmoothStreamingEnabled,
  getShowPromptsTab,
  getTerminalPreferences,
  getConfirmTerminalTermination,
  setConfirmTerminalTermination,
  subscribeConfirmTerminalTermination,
  setActivityDetail,
  setChatAtmosphereEnabled,
  setDiffLineWrap,
  setDiagnosticCategoryEnabled,
  setPromptsPlacement,
  setMobileComposerRefocusAfterSend,
  setMobileHistorySeekControl,
  setPanelPresentation,
  setRightOptionFocusesComposer,
  setSeekOnSubmit,
  setSmoothStreamingEnabled,
  setShowPromptsTab,
  subscribeDiffLineWrap,
  subscribeChatAtmosphereEnabled,
  subscribeDiagnosticCategoryEnabled,
  subscribePromptsPlacement,
  subscribeMobileComposerRefocusAfterSend,
  subscribeMobileHistorySeekControl,
  subscribePanelPresentation,
  subscribeRightOptionFocusesComposer,
  subscribeSeekOnSubmit,
  subscribeSmoothStreamingEnabled,
  subscribeShowPromptsTab,
  setTerminalPreferences,
  subscribeTerminalPreferences,
  subscribeActivityDetail,
} from "./settings";

describe("panel presentation setting", () => {
  it("defaults to split and rejects noncanonical stored values", () => {
    expect(getPanelPresentation()).toBe("split");
    localStorage.setItem("sedes-panel-presentation", "single");
    expect(getPanelPresentation()).toBe("single");
    localStorage.setItem("sedes-panel-presentation", "replace");
    expect(getPanelPresentation()).toBe("split");
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribePanelPresentation((value) => seen.push(value));

    setPanelPresentation("single");
    expect(localStorage.getItem("sedes-panel-presentation")).toBe("single");
    expect(seen).toEqual(["single"]);

    localStorage.setItem("sedes-panel-presentation", "split");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "sedes-panel-presentation" }),
    );
    expect(seen).toEqual(["single", "split"]);
    unsubscribe();
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("terminal termination confirmation", () => {
  it("defaults to confirmation unless explicitly disabled", () => {
    expect(getConfirmTerminalTermination()).toBe(true);
    localStorage.setItem("sedes-confirm-terminal-termination", "invalid");
    expect(getConfirmTerminalTermination()).toBe(true);
    setConfirmTerminalTermination(false);
    expect(getConfirmTerminalTermination()).toBe(false);
    expect(localStorage.getItem("sedes-confirm-terminal-termination")).toBe("false");
  });

  it("notifies local and cross-window consumers and unsubscribes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConfirmTerminalTermination((value) => seen.push(value));
    setConfirmTerminalTermination(false);
    localStorage.setItem("sedes-confirm-terminal-termination", "true");
    window.dispatchEvent(new StorageEvent("storage", {
      key: "sedes-confirm-terminal-termination",
    }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(seen).toEqual([false, true, true]);
    unsubscribe();
    setConfirmTerminalTermination(false);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(seen).toEqual([false, true, true]);
  });
});

describe("terminal preferences", () => {
  it("defaults blinking off only on Windows and preserves explicit client choices", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    try {
      expect(getTerminalPreferences().cursorBlink).toBe(false);
      const seen: boolean[] = [];
      const unsubscribe = subscribeTerminalPreferences((prefs) => seen.push(prefs.cursorBlink));
      setTerminalPreferences({ ...getTerminalPreferences(), cursorBlink: true });
      expect(getTerminalPreferences().cursorBlink).toBe(true);
      localStorage.setItem("sedes-terminal-cursor-blink", "false");
      window.dispatchEvent(new StorageEvent("storage", { key: "sedes-terminal-cursor-blink" }));
      expect(seen).toEqual([true, false]);
      unsubscribe();
      localStorage.removeItem("sedes-terminal-cursor-blink");
      platform.mockReturnValue("MacIntel");
      expect(getTerminalPreferences().cursorBlink).toBe(true);
      platform.mockReturnValue("Linux armv8l");
      expect(getTerminalPreferences().cursorBlink).toBe(true);
    } finally {
      platform.mockRestore();
    }
  });

  it("defaults, persists, validates, and notifies across windows", () => {
    const seen: Array<{ cursorBlink: boolean; fontSize: number; scrollback: number }> = [];
    const unsubscribe = subscribeTerminalPreferences((value) =>
      seen.push(value),
    );
    expect(getTerminalPreferences()).toEqual({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 8_000,
    });

    setTerminalPreferences({ cursorBlink: true, fontSize: 17, scrollback: 12_000 });
    expect(getTerminalPreferences()).toEqual({
      cursorBlink: true,
      fontSize: 17,
      scrollback: 12_000,
    });
    expect(seen).toEqual([{ cursorBlink: true, fontSize: 17, scrollback: 12_000 }]);

    localStorage.setItem("sedes-terminal-font-size", "20");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-terminal-font-size",
        newValue: "20",
      }),
    );
    expect(seen.at(-1)).toEqual({ cursorBlink: true, fontSize: 20, scrollback: 12_000 });
    expect(() =>
      setTerminalPreferences({ cursorBlink: true, fontSize: 25, scrollback: 12_000 }),
    ).toThrow("outside the supported bounds");
    unsubscribe();
  });

  it("rejects malformed stored values instead of accepting another shape", () => {
    localStorage.setItem("sedes-terminal-font-size", "13px");
    localStorage.setItem("sedes-terminal-scrollback", "unbounded");
    expect(getTerminalPreferences()).toEqual({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 8_000,
    });
  });
});

describe("activity detail setting", () => {
  it("defaults to full and rejects noncanonical stored values", () => {
    expect(getActivityDetail()).toBe("full");
    localStorage.setItem("sedes-activity-detail", "summary");
    expect(getActivityDetail()).toBe("summary");
    localStorage.setItem("sedes-activity-detail", "hidden");
    expect(getActivityDetail()).toBe("full");
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeActivityDetail((value) => seen.push(value));

    setActivityDetail("summary");
    expect(localStorage.getItem("sedes-activity-detail")).toBe("summary");
    expect(seen).toEqual(["summary"]);

    localStorage.setItem("sedes-activity-detail", "full");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-activity-detail",
        newValue: "full",
      }),
    );
    expect(seen).toEqual(["summary", "full"]);
    unsubscribe();
  });
});

describe("diff line-wrap setting", () => {
  it("defaults to on, persists choices, and notifies every window", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeDiffLineWrap((value) => seen.push(value));

    expect(getDiffLineWrap()).toBe(true);
    setDiffLineWrap(false);
    expect(getDiffLineWrap()).toBe(false);
    expect(localStorage.getItem("sedes-diff-line-wrap")).toBe("false");
    expect(seen).toEqual([false]);

    localStorage.setItem("sedes-diff-line-wrap", "true");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-diff-line-wrap",
        newValue: "true",
      }),
    );
    expect(seen).toEqual([false, true]);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "other-key", newValue: "false" }),
    );
    expect(seen).toEqual([false, true]);
    unsubscribe();
  });

  it("fails closed to the wrap-on default for unrelated stored values", () => {
    localStorage.setItem("sedes-diff-line-wrap", "invalid");
    expect(getDiffLineWrap()).toBe(true);
  });
});

describe("diagnostic category settings", () => {
  it("keeps categories independent and notifies subscribers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeDiagnosticCategoryEnabled(
      "thread_load",
      (value) => seen.push(value),
    );

    expect(getDiagnosticCategoryEnabled("thread_load")).toBe(false);
    expect(getDiagnosticCategoryEnabled("seek")).toBe(false);
    expect(getDiagnosticCategoryEnabled("streaming")).toBe(false);
    setDiagnosticCategoryEnabled("thread_load", true);
    expect(getDiagnosticCategoryEnabled("thread_load")).toBe(true);
    expect(getDiagnosticCategoryEnabled("seek")).toBe(false);
    expect(getDiagnosticCategoryEnabled("streaming")).toBe(false);
    expect(localStorage.getItem("sedes-diagnostics-thread-load")).toBe("true");
    expect(seen).toEqual([true]);

    localStorage.setItem("sedes-diagnostics-thread-load", "false");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-diagnostics-thread-load",
        newValue: "false",
      }),
    );
    expect(seen).toEqual([true, false]);
    unsubscribe();
  });
});

describe("seek-on-submit setting", () => {
  it("defaults to off and persists explicit choices", () => {
    expect(getSeekOnSubmit()).toBe(false);
    setSeekOnSubmit(true);
    expect(getSeekOnSubmit()).toBe(true);
    expect(localStorage.getItem("sedes-seek-on-submit")).toBe("true");
    setSeekOnSubmit(false);
    expect(getSeekOnSubmit()).toBe(false);
  });

  it("notifies subscribers of same-window and cross-window changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeSeekOnSubmit((value) => seen.push(value));

    setSeekOnSubmit(true);
    expect(seen).toEqual([true]);

    // Cross-window writes arrive as storage events.
    localStorage.setItem("sedes-seek-on-submit", "false");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-seek-on-submit",
        newValue: "false",
      }),
    );
    expect(seen).toEqual([true, false]);

    // Unrelated keys do not notify.
    window.dispatchEvent(
      new StorageEvent("storage", { key: "other-key", newValue: "x" }),
    );
    expect(seen).toEqual([true, false]);

    unsubscribe();
    setSeekOnSubmit(true);
    expect(seen).toEqual([true, false]);
  });
});

describe("mobile history seek control setting", () => {
  it("defaults on and only exact stored false disables it", () => {
    expect(getMobileHistorySeekControl()).toBe(true);
    localStorage.setItem("sedes-mobile-history-seek-control", "false");
    expect(getMobileHistorySeekControl()).toBe(false);
    localStorage.setItem("sedes-mobile-history-seek-control", "disabled");
    expect(getMobileHistorySeekControl()).toBe(true);
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeMobileHistorySeekControl((value) =>
      seen.push(value),
    );

    setMobileHistorySeekControl(false);
    expect(localStorage.getItem("sedes-mobile-history-seek-control")).toBe(
      "false",
    );
    expect(seen).toEqual([false]);

    localStorage.setItem("sedes-mobile-history-seek-control", "true");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-mobile-history-seek-control",
        newValue: "true",
      }),
    );
    expect(seen).toEqual([false, true]);
    unsubscribe();
  });
});

describe("smooth-streaming setting", () => {
  it("defaults on and accepts only canonical stored booleans", () => {
    expect(getSmoothStreamingEnabled()).toBe(true);

    localStorage.setItem("sedes-smooth-streaming", "false");
    expect(getSmoothStreamingEnabled()).toBe(false);
    localStorage.setItem("sedes-smooth-streaming", "true");
    expect(getSmoothStreamingEnabled()).toBe(true);

    localStorage.setItem("sedes-smooth-streaming", "1");
    expect(getSmoothStreamingEnabled()).toBe(true);
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeSmoothStreamingEnabled((value) =>
      seen.push(value),
    );

    setSmoothStreamingEnabled(false);
    expect(localStorage.getItem("sedes-smooth-streaming")).toBe("false");
    expect(seen).toEqual([false]);

    localStorage.setItem("sedes-smooth-streaming", "true");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-smooth-streaming",
        newValue: "true",
      }),
    );
    expect(seen).toEqual([false, true]);

    unsubscribe();
  });
});

describe("prompts tab setting", () => {
  it("defaults on and accepts only canonical stored booleans", () => {
    expect(getShowPromptsTab()).toBe(true);

    localStorage.setItem("sedes-show-prompts-tab", "false");
    expect(getShowPromptsTab()).toBe(false);
    localStorage.setItem("sedes-show-prompts-tab", "true");
    expect(getShowPromptsTab()).toBe(true);
    localStorage.setItem("sedes-show-prompts-tab", "hidden");
    expect(getShowPromptsTab()).toBe(true);
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeShowPromptsTab((value) => seen.push(value));

    setShowPromptsTab(false);
    expect(localStorage.getItem("sedes-show-prompts-tab")).toBe("false");
    expect(seen).toEqual([false]);

    localStorage.setItem("sedes-show-prompts-tab", "true");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-show-prompts-tab",
        newValue: "true",
      }),
    );
    expect(seen).toEqual([false, true]);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "another-setting" }),
    );
    expect(seen).toEqual([false, true]);
    unsubscribe();
  });
});

describe("prompts placement setting", () => {
  it("defaults above the composer and accepts only canonical stored values", () => {
    expect(getPromptsPlacement()).toBe("above_composer");

    localStorage.setItem("sedes-prompts-placement", "toolbar");
    expect(getPromptsPlacement()).toBe("toolbar");
    localStorage.setItem("sedes-prompts-placement", "elsewhere");
    expect(getPromptsPlacement()).toBe("above_composer");
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribePromptsPlacement((value) => seen.push(value));

    setPromptsPlacement("toolbar");
    expect(localStorage.getItem("sedes-prompts-placement")).toBe("toolbar");
    expect(seen).toEqual(["toolbar"]);

    localStorage.setItem("sedes-prompts-placement", "above_composer");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-prompts-placement",
        newValue: "above_composer",
      }),
    );
    expect(seen).toEqual(["toolbar", "above_composer"]);
    unsubscribe();
  });
});

describe("chat-atmosphere setting", () => {
  it("defaults off and accepts only an explicit canonical true", () => {
    expect(getChatAtmosphereEnabled()).toBe(false);

    localStorage.setItem("sedes-chat-atmosphere", "true");
    expect(getChatAtmosphereEnabled()).toBe(true);
    localStorage.setItem("sedes-chat-atmosphere", "1");
    expect(getChatAtmosphereEnabled()).toBe(false);
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeChatAtmosphereEnabled((value) =>
      seen.push(value),
    );

    setChatAtmosphereEnabled(true);
    expect(localStorage.getItem("sedes-chat-atmosphere")).toBe("true");
    expect(seen).toEqual([true]);

    localStorage.setItem("sedes-chat-atmosphere", "false");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-chat-atmosphere",
        newValue: "false",
      }),
    );
    expect(seen).toEqual([true, false]);

    unsubscribe();
  });
});

describe("right-Option composer focus setting", () => {
  it("defaults to off and persists explicit choices", () => {
    expect(getRightOptionFocusesComposer()).toBe(false);
    setRightOptionFocusesComposer(true);
    expect(getRightOptionFocusesComposer()).toBe(true);
    expect(localStorage.getItem("sedes-right-option-focuses-composer")).toBe(
      "true",
    );
    setRightOptionFocusesComposer(false);
    expect(getRightOptionFocusesComposer()).toBe(false);
  });

  it("notifies subscribers of same-window and cross-window changes", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeRightOptionFocusesComposer((value) =>
      seen.push(value),
    );

    setRightOptionFocusesComposer(true);
    expect(seen).toEqual([true]);

    localStorage.setItem("sedes-right-option-focuses-composer", "false");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-right-option-focuses-composer",
        newValue: "false",
      }),
    );
    expect(seen).toEqual([true, false]);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "other-key", newValue: "x" }),
    );
    expect(seen).toEqual([true, false]);

    unsubscribe();
    setRightOptionFocusesComposer(true);
    expect(seen).toEqual([true, false]);
  });
});

describe("mobile composer refocus setting", () => {
  it("defaults to on and accepts only canonical stored booleans", () => {
    expect(getMobileComposerRefocusAfterSend()).toBe(true);

    localStorage.setItem("sedes-mobile-composer-refocus-after-send", "false");
    expect(getMobileComposerRefocusAfterSend()).toBe(false);
    localStorage.setItem("sedes-mobile-composer-refocus-after-send", "invalid");
    expect(getMobileComposerRefocusAfterSend()).toBe(true);
  });

  it("persists and notifies same-window and cross-window consumers", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeMobileComposerRefocusAfterSend((value) =>
      seen.push(value),
    );

    setMobileComposerRefocusAfterSend(false);
    expect(
      localStorage.getItem("sedes-mobile-composer-refocus-after-send"),
    ).toBe("false");
    expect(seen).toEqual([false]);

    localStorage.setItem("sedes-mobile-composer-refocus-after-send", "true");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-mobile-composer-refocus-after-send",
        newValue: "true",
      }),
    );
    expect(seen).toEqual([false, true]);
    unsubscribe();
  });
});


describe("sidebar name filter preference", () => {
  it("defaults off, persists changes, and notifies local and other-window subscribers", () => {
    localStorage.clear();
    expect(getClickNamesToFilter()).toBe(false);
    const changed = vi.fn();
    const unsubscribe = subscribeClickNamesToFilter(changed);
    setClickNamesToFilter(true);
    expect(getClickNamesToFilter()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    localStorage.setItem("sedes-filter-by-project-name", "false");
    window.dispatchEvent(new StorageEvent("storage", { key: "sedes-filter-by-project-name" }));
    expect(getClickNamesToFilter()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    setClickNamesToFilter(false);
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
