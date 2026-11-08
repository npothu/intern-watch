import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DARK_PALETTES,
  LIGHT_PALETTES,
  type PaletteSpec,
} from "./palette";

// The tables in palette.ts carry concrete hexes because Clerk and the Settings
// swatches cannot read CSS custom properties. globals.css is the source of
// truth; this test is the "KEEP IN SYNC" comment made executable.
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found in globals.css: ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

function token(body: string, name: string): string | undefined {
  return body.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1].toLowerCase();
}

const PROPS: Array<[keyof PaletteSpec, string]> = [
  ["bg", "bg"],
  ["ink", "ink"],
  ["accent", "accent"],
  ["accentInk", "accent-ink"],
  ["red", "red"],
];

function expectMatch(spec: PaletteSpec, body: string, inherits?: string) {
  const base = inherits ? block(inherits) : "";
  for (const [key, cssName] of PROPS) {
    const value = token(body, cssName) ?? token(base, cssName);
    expect(value, `--${cssName}`).toBe(spec[key]);
  }
}

describe("palette tables match globals.css", () => {
  it("fern is the plain :root block", () => {
    expectMatch(LIGHT_PALETTES.fern, block(":root,\n:root.light {"));
  });
  it("pine", () => {
    expectMatch(LIGHT_PALETTES.pine, block(':root.light[data-light-palette="pine"]'));
  });
  it("obsidian-fern is the plain .dark block and the no-JS fallback", () => {
    expectMatch(DARK_PALETTES["obsidian-fern"], block(":root.dark,\n.dark {"));
    expectMatch(DARK_PALETTES["obsidian-fern"], block(":root:not(.light):not(.dark) {"));
  });
  it("obsidian-mono overrides only the accent pair", () => {
    expectMatch(
      DARK_PALETTES["obsidian-mono"],
      block(':root.dark[data-dark-palette="obsidian-mono"]'),
      ":root.dark,\n.dark {",
    );
  });
  it("graphite-fern", () => {
    expectMatch(DARK_PALETTES["graphite-fern"], block(':root.dark[data-dark-palette="graphite-fern"]'));
  });
});
