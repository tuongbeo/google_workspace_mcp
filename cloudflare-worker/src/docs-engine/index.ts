/**
 * docs-engine/index.ts — barrel export
 */
export { parseMarkdown } from "./parser";
export { buildExecutionPlan, hexToRgb } from "./builder";
export type { DocNode, InlineNode, ExecutionPlan, RichElement } from "./types";
