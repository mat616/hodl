import type { ReactNode } from "react";
import privacy from "../legal/privacy.md?raw";
import terms from "../legal/terms.md?raw";

/** Bump whenever terms.md or privacy.md changes materially. Wallets that accepted an older value are asked again. */
export const TERMS_VERSION = "draft-1";

const DOCS = { Terms: terms, Privacy: privacy } as const;
export type LegalDoc = keyof typeof DOCS;

export function Legal({ doc }: { doc: LegalDoc }) {
  return <section className="panel legal">{render(DOCS[doc])}</section>;
}

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("**")) return <strong key={`${keyBase}-${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={`${keyBase}-${i}`}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function cells(row: string): string[] {
  return row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function render(source: string): ReactNode[] {
  const lines = source.split("\n");
  const out: ReactNode[] = [];
  let list: string[] | null = null;
  let table: string[][] | null = null;

  const flushList = () => {
    if (!list) return;
    out.push(
      <ul key={`ul-${out.length}`}>
        {list.map((item, i) => (
          <li key={i}>{inline(item, `li-${out.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(
      <table key={`tb-${out.length}`}>
        <thead>
          <tr>{head.map((c, i) => <th key={i}>{inline(c, `th-${out.length}-${i}`)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>{row.map((c, i) => <td key={i}>{inline(c, `td-${out.length}-${r}-${i}`)}</td>)}</tr>
          ))}
        </tbody>
      </table>,
    );
    table = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\|.*\|$/.test(line)) {
      flushList();
      if (/^\|[\s|:-]+\|$/.test(line)) continue; // separator row
      (table ??= []).push(cells(line));
      continue;
    }
    flushTable();
    if (line.startsWith("- ")) {
      (list ??= []).push(line.slice(2));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (line.startsWith("### ")) out.push(<h3 key={out.length}>{inline(line.slice(4), `h3-${out.length}`)}</h3>);
    else if (line.startsWith("## ")) out.push(<h2 key={out.length}>{inline(line.slice(3), `h2-${out.length}`)}</h2>);
    else if (line.startsWith("# ")) out.push(<h1 key={out.length}>{inline(line.slice(2), `h1-${out.length}`)}</h1>);
    else out.push(<p key={out.length} className="lede">{inline(line, `p-${out.length}`)}</p>);
  }
  flushList();
  flushTable();
  return out;
}
