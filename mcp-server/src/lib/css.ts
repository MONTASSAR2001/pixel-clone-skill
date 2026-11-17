/** Extract balanced top-level `@name ... { ... }` blocks from CSS text. */
export function extractAtRules(css: string, name: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = css.indexOf(name, i)) !== -1) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      const c = css[j];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    out.push(css.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

export interface FontFace {
  family: string;
  weight: string | null;
  style: string | null;
  display: string | null;
  unicodeRange: string | null;
  sources: { url: string; format: string | null }[];
}

export function parseFontFace(block: string, baseUrl: string): FontFace {
  // Parenthesis-aware value: `url(data:font/woff;base64,...)` contains a ";" that must not end the declaration.
  const get = (prop: string) => new RegExp(`(?:^|[{;\\s])${prop}\\s*:\\s*((?:[^;}(]|\\([^)]*\\))+)`, "i").exec(block)?.[1]?.trim() ?? null;
  const src = get("src") ?? "";
  const sources = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi)].map((m) => {
    let url = m[1]!;
    try {
      if (!url.startsWith("data:")) url = new URL(url, baseUrl || undefined).href;
    } catch {
      /* keep raw */
    }
    return { url: url.startsWith("data:") ? "data:(inline)" : url, format: m[2] ?? null };
  });
  return {
    family: (get("font-family") ?? "").replace(/^["']|["']$/g, ""),
    weight: get("font-weight"),
    style: get("font-style"),
    display: get("font-display"),
    unicodeRange: get("unicode-range"),
    sources,
  };
}

/** Collect `--custom-prop: value` declarations from :root / html / body style blocks. */
export function extractRootVariables(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /(?:^|[}\s,])(:root|html|body|\[data-theme[^\]]*\])[^{]*\{([^}]*)\}/g;
  for (const m of css.matchAll(re)) {
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) vars[d[1]!] = d[2]!.trim();
  }
  return vars;
}

export function extractMediaQueries(css: string): string[] {
  return [...new Set([...css.matchAll(/@media\s*([^{]+)\{/g)].map((m) => m[1]!.trim()))];
}
