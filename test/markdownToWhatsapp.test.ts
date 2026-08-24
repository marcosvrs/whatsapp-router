import { describe, expect, it } from "vitest";
import { markdownToWhatsapp } from "../src/markdownToWhatsapp.js";

describe("markdownToWhatsapp", () => {
  it("converts **bold** to *bold*", () => {
    expect(markdownToWhatsapp("This is **bold** text")).toBe("This is *bold* text");
  });

  it("converts __bold__ to *bold*", () => {
    expect(markdownToWhatsapp("This is __bold__ text")).toBe("This is *bold* text");
  });

  it("converts markdown *italic* to WhatsApp _italic_", () => {
    expect(markdownToWhatsapp("This is *italic* text")).toBe("This is _italic_ text");
  });

  it("converts markdown _italic_ to WhatsApp _italic_ (no-op syntax-wise)", () => {
    expect(markdownToWhatsapp("This is _italic_ text")).toBe("This is _italic_ text");
  });

  it("converts ~~strikethrough~~ to ~strikethrough~", () => {
    expect(markdownToWhatsapp("This is ~~struck~~ text")).toBe("This is ~struck~ text");
  });

  it("does not confuse bold and italic in the same sentence", () => {
    expect(markdownToWhatsapp("**bold** and *italic* together")).toBe(
      "*bold* and _italic_ together",
    );
  });

  it("handles bold immediately adjacent to italic with no space", () => {
    expect(markdownToWhatsapp("**bold***italic*")).toBe("*bold*_italic_");
  });

  it("converts a level-1 header to bold", () => {
    expect(markdownToWhatsapp("# Title")).toBe("*Title*");
  });

  it("converts a level-3 header to bold", () => {
    expect(markdownToWhatsapp("### Subheading")).toBe("*Subheading*");
  });
  it("trims padded headings and only converts complete header lines", () => {
    expect(markdownToWhatsapp("#   Padded title  \ntext # not a heading")).toBe(
      "*Padded title*\ntext # not a heading",
    );
  });

  it("converts a markdown link to 'text: url'", () => {
    expect(markdownToWhatsapp("Check [our docs](https://example.com/docs)")).toBe(
      "Check our docs: https://example.com/docs",
    );
  });

  it("converts inline code (single backtick) to WhatsApp monospace (triple backtick)", () => {
    expect(markdownToWhatsapp("Run `npm install` first")).toBe("Run ```npm install``` first");
  });

  it("leaves a fenced code block's content completely untouched", () => {
    const input = "```\nconst x = **not bold** here;\n```";
    expect(markdownToWhatsapp(input)).toBe(input);
  });

  it("does not convert markdown syntax that appears inside a fenced code block", () => {
    const input = "Before\n```\n*not italic* __not bold__\n```\nAfter";
    const result = markdownToWhatsapp(input);
    expect(result).toContain("*not italic* __not bold__");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });
  it("handles multiple code spans and underscore emphasis", () => {
    const input = "Run `one` and `two`, then use _italic_ and *italic*.";
    expect(markdownToWhatsapp(input)).toBe("Run ```one``` and ```two```, then use _italic_ and _italic_.");
  });

  it("does not span underscore emphasis across newlines and preserves multi-character content", () => {
    expect(markdownToWhatsapp("_two words_")).toBe("_two words_");
    expect(markdownToWhatsapp("_first\nsecond_")).toBe("_first\nsecond_");
  });

  it("leaves plain text with no markdown completely unchanged", () => {
    expect(markdownToWhatsapp("Just a normal sentence.")).toBe("Just a normal sentence.");
  });

  it("leaves an already-WhatsApp-formatted string unchanged where syntax doesn't overlap", () => {
    expect(markdownToWhatsapp("~already~ fine")).toBe("~already~ fine");
  });

  it("handles an empty string", () => {
    expect(markdownToWhatsapp("")).toBe("");
  });

  it("converts a realistic multi-line LLM reply end to end", () => {
    const input = [
      "## Summary",
      "",
      "Here's what I found:",
      "- **Total**: 42 items",
      "- Some are *pending* review",
      "",
      "See [the report](https://example.com/report) for details.",
    ].join("\n");

    const result = markdownToWhatsapp(input);

    expect(result).toContain("*Summary*");
    expect(result).toContain("*Total*: 42 items");
    expect(result).toContain("Some are _pending_ review");
    expect(result).toContain("the report: https://example.com/report");
    // Bulleted list markers are left as plain text — WhatsApp has no list syntax.
    expect(result).toContain("- ");
  });
});
