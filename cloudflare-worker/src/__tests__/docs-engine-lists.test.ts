import { describe, it, expect } from "vitest";
import { parseMarkdown } from "../docs-engine/parser";
import { buildExecutionPlan } from "../docs-engine/builder";

describe("docs-engine — flat list (no nesting) regression check", () => {
  it("still parses and builds a simple flat list correctly", () => {
    const md = "- One\n- Two\n- Three\n";
    const ast = parseMarkdown(md) as any;
    expect(ast[0].items.map((i: any) => i.children)).toEqual([
      [{ type: "text", content: "One" }],
      [{ type: "text", content: "Two" }],
      [{ type: "text", content: "Three" }],
    ]);
    expect(ast[0].items.every((i: any) => i.subItems === undefined)).toBe(true);

    const plan = buildExecutionPlan(ast, { startIndex: 1 });
    const insertReq = plan.pass1Requests.find((r: any) => r.insertText) as any;
    expect(insertReq.insertText.text).toBe("One\nTwo\nThree\n");
  });
});

describe("docs-engine — nested list parsing", () => {
  it("preserves nested list items as subItems instead of dropping them", () => {
    const md = "- Item A\n  - Sub A1\n  - Sub A2\n- Item B\n";
    const ast = parseMarkdown(md);

    expect(ast).toHaveLength(1);
    const list = ast[0] as any;
    expect(list.type).toBe("bullet_list");
    expect(list.items).toHaveLength(2);

    const [itemA, itemB] = list.items;
    expect(itemA.children).toEqual([{ type: "text", content: "Item A" }]);
    expect(itemA.subItems).toHaveLength(2);
    expect(itemA.subItems[0].children).toEqual([{ type: "text", content: "Sub A1" }]);
    expect(itemA.subItems[1].children).toEqual([{ type: "text", content: "Sub A2" }]);

    // The sibling after the nested block must be intact, not corrupted or dropped.
    expect(itemB.children).toEqual([{ type: "text", content: "Item B" }]);
    expect(itemB.subItems).toBeUndefined();
  });

  it("supports multiple levels of nesting", () => {
    const md = "- A\n  - B\n    - C\n";
    const ast = parseMarkdown(md);
    const list = ast[0] as any;

    expect(list.items[0].children).toEqual([{ type: "text", content: "A" }]);
    expect(list.items[0].subItems[0].children).toEqual([{ type: "text", content: "B" }]);
    expect(list.items[0].subItems[0].subItems[0].children).toEqual([{ type: "text", content: "C" }]);
  });

  it("preserves checkbox state on nested items", () => {
    const md = "- [ ] Parent\n  - [x] Done sub-task\n  - [ ] Pending sub-task\n";
    const ast = parseMarkdown(md);
    const list = ast[0] as any;

    expect(list.items[0].subItems[0].checked).toBe(true);
    expect(list.items[0].subItems[1].checked).toBe(false);
  });
});

describe("docs-engine — nested list index alignment in the built plan", () => {
  it("keeps every top-level item's text in the actual inserted string, in order", () => {
    const md = "- Item A\n  - Sub A1\n  - Sub A2\n- Item B\n";
    const ast = parseMarkdown(md);
    const plan = buildExecutionPlan(ast, { startIndex: 1 });

    const insertReq = plan.pass1Requests.find((r: any) => r.insertText) as any;
    expect(insertReq.insertText.text).toBe("Item A\nSub A1\nSub A2\nItem B\n");
  });

  it("styles the sibling item after a nested block at its correct offset, not inside the nested text", () => {
    const md = "- Item A\n  - Sub A1\n  - Sub A2\n- Item B\n";
    const ast = parseMarkdown(md);
    const plan = buildExecutionPlan(ast, { startIndex: 1 });

    const insertReq = plan.pass1Requests.find((r: any) => r.insertText) as any;
    const fullText = insertReq.insertText.text as string;

    // "Item B" must start right where the text actually says it does.
    const expectedItemBStart = 1 + fullText.indexOf("Item B"); // +1 for the doc's 1-based index
    const itemBStyleReq = plan.pass1Requests.find((r: any) =>
      r.updateParagraphStyle?.range?.startIndex === expectedItemBStart
      && r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "NORMAL_TEXT",
    ) as any;

    expect(itemBStyleReq).toBeDefined();
    expect(itemBStyleReq.updateParagraphStyle.range.endIndex).toBe(expectedItemBStart + "Item B".length);
  });

  it("indents nested items so they're visually distinguishable from top-level items", () => {
    const md = "- Item A\n  - Sub A1\n";
    const ast = parseMarkdown(md);
    const plan = buildExecutionPlan(ast, { startIndex: 1 });

    const insertReq = plan.pass1Requests.find((r: any) => r.insertText) as any;
    const fullText = insertReq.insertText.text as string;
    const subA1Start = 1 + fullText.indexOf("Sub A1");

    const indentReq = plan.pass1Requests.find((r: any) =>
      r.updateParagraphStyle?.range?.startIndex === subA1Start,
    ) as any;

    expect(indentReq.updateParagraphStyle.paragraphStyle.indentStart.magnitude).toBeGreaterThan(0);
  });

  it("does not indent top-level items", () => {
    const md = "- Item A\n  - Sub A1\n";
    const ast = parseMarkdown(md);
    const plan = buildExecutionPlan(ast, { startIndex: 1 });

    const itemAStyleReq = plan.pass1Requests.find((r: any) =>
      r.updateParagraphStyle?.range?.startIndex === 1,
    ) as any;

    expect(itemAStyleReq.updateParagraphStyle.paragraphStyle.indentStart).toBeUndefined();
  });
});
