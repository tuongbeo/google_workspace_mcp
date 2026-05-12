/**
 * docs-engine/types.ts
 * AST node types for the markdown-to-Google-Docs compiler
 */

export type InlineNode =
  | { type: "text"; content: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "strikethrough"; children: InlineNode[] }
  | { type: "underline"; children: InlineNode[] }
  | { type: "code"; content: string }
  | { type: "link"; url: string; children: InlineNode[] }
  | { type: "mention"; name: string; email: string }
  | { type: "footnote_ref"; id: string }
  | { type: "image"; url: string; alt?: string; widthPt?: number; heightPt?: number };

export interface ListItem {
  children: InlineNode[];
  checked?: boolean; // undefined = not checkbox, true = checked, false = unchecked
  subItems?: ListItem[];
}

export interface TableData {
  headers: string[];
  rows: string[][];
}

export type DocNode =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "bullet_list"; items: ListItem[]; listType: "bullet" | "numbered" | "checkbox" }
  | { type: "table"; data: TableData }
  | { type: "code_block"; language?: string; content: string }
  | { type: "blockquote"; children: InlineNode[] }
  | { type: "horizontal_rule" }
  | { type: "page_break" }
  | { type: "toc" }
  | { type: "image"; url: string; alt?: string; widthPt?: number; heightPt?: number }
  | { type: "footnote_def"; id: string; content: string };

export interface RichElement {
  type: "image" | "mention" | "footnote" | "toc" | "rich_link";
  placeholder: string;
  // image
  url?: string;
  widthPt?: number;
  heightPt?: number;
  // mention
  email?: string;
  name?: string;
  // footnote
  footnoteContent?: string;
}

export interface ExecutionPlan {
  pass1Requests: object[];
  richElements: RichElement[];
  themeRequests: object[];
  headerRequest?: object;
  footerRequest?: object;
  stats: {
    sections: number;
    tables: number;
    images: number;
    mentions: number;
    footnotes: number;
    hasToc: boolean;
  };
}
