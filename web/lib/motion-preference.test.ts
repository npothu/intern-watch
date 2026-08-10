import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_PREFERENCE_INIT_SCRIPT,
  MOTION_PREFERENCE_STORAGE_KEY,
  motionPreferenceListeners,
  setMotionPreference,
} from "./motion-preference";
import { FORCE_MOTION_ATTR, REDUCE_MOTION_ATTR } from "./motion-constants";

type FakeHtml = {
  attributes: Set<string>;
  hasAttribute: (name: string) => boolean;
  setAttribute: (name: string) => void;
  toggleAttribute: (name: string, force: boolean) => void;
};

function fakeHtml(): FakeHtml {
  const attributes = new Set<string>();
  return {
    attributes,
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => {
      attributes.add(name);
    },
    toggleAttribute: (name, force) => {
      if (force) attributes.add(name);
      else attributes.delete(name);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  motionPreferenceListeners.clear();
});

describe("motion preference persistence", () => {
  it("restores Full before hydration", () => {
    const html = fakeHtml();
    const storage = { getItem: () => "full" };
    const run = new Function(
      "localStorage",
      "document",
      MOTION_PREFERENCE_INIT_SCRIPT
    );

    run(storage, { documentElement: html });

    expect(html.hasAttribute(FORCE_MOTION_ATTR)).toBe(true);
    expect(html.hasAttribute(REDUCE_MOTION_ATTR)).toBe(false);
    expect(MOTION_PREFERENCE_INIT_SCRIPT).not.toContain("undefined");
    expect(MOTION_PREFERENCE_INIT_SCRIPT).toContain(FORCE_MOTION_ATTR);
  });

  it("applies and stores each explicit preference without a second store", () => {
    const html = fakeHtml();
    const values = new Map<string, string>();
    vi.stubGlobal("document", { documentElement: html });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });

    setMotionPreference("full");
    expect(html.attributes).toEqual(new Set([FORCE_MOTION_ATTR]));
    expect(values.get(MOTION_PREFERENCE_STORAGE_KEY)).toBe("full");

    setMotionPreference("reduced");
    expect(html.attributes).toEqual(new Set([REDUCE_MOTION_ATTR]));
    expect(values.get(MOTION_PREFERENCE_STORAGE_KEY)).toBe("reduced");

    setMotionPreference("system");
    expect(html.attributes.size).toBe(0);
    expect(values.get(MOTION_PREFERENCE_STORAGE_KEY)).toBe("system");
  });
});
