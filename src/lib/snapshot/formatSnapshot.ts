export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  // CDP's AXValue.value is untyped: numeric roles (spinbutton, slider, the
  // price/range filters retail sites use) send a number, not a string.
  name?: { type: string; value: unknown };
  value?: { type: string; value: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);
const MAX_TEXT_LEN = 120;
const MAX_LINES = 1500;
/** ~40K chars ≈ 10-12K tokens — leaves room to reason even on a 64K-context
 * model like deepseek-chat, which one unbounded snapshot could exhaust. */
const MAX_CHARS = 40_000;

/** Coerces whatever CDP sent (string, number, boolean) into a display string. */
function truncate(text: unknown): string {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT_LEN ? `${collapsed.slice(0, MAX_TEXT_LEN)}…` : collapsed;
}

/** `0` and `false` are real values on a spinbutton or a checkbox, so emptiness
 * is decided after coercion rather than by truthiness of the raw value. */
function render(label: '' | 'value', raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const text = truncate(raw);
  if (text === '') return '';
  return label === '' ? ` "${text}"` : ` ${label}="${text}"`;
}

/** Filters AX-tree noise down to elements worth showing the model: anything
 * with real content/interactivity, skipping pure layout wrappers. */
function isKeepable(node: AXNode): boolean {
  if (node.ignored) return false;
  if (node.backendDOMNodeId === undefined) return false;
  const role = node.role?.value ?? '';
  if (SKIP_ROLES.has(role)) return false;
  return true;
}

export interface FormatResult {
  text: string;
  uidCount: number;
  truncated: boolean;
  chars: number;
}

export function formatSnapshot(
  nodes: AXNode[],
  register: (backendNodeId: number) => string,
): FormatResult {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

  const lines: string[] = [];
  let uidCount = 0;
  let truncated = false;
  let chars = 0;

  function walk(node: AXNode, depth: number): void {
    if (truncated) return;
    // A line cap alone isn't enough: huge pages (a GitHub PR diff, say) can
    // produce hundreds of KB and swallow a whole context window in one call,
    // leaving the model no room to reason over the result.
    if (lines.length >= MAX_LINES || chars >= MAX_CHARS) {
      truncated = true;
      return;
    }

    const keep = isKeepable(node);
    let nextDepth = depth;

    if (keep) {
      const uid = register(node.backendDOMNodeId!);
      uidCount += 1;
      const role = node.role?.value ?? 'unknown';
      const name = render('', node.name?.value);
      const value = render('value', node.value?.value);
      const line = `${'  '.repeat(depth)}${role}${name}${value} [uid=${uid}]`;
      lines.push(line);
      chars += line.length + 1;
      nextDepth = depth + 1;
    }

    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, nextDepth);
    }
  }

  for (const root of roots) walk(root, 0);

  if (truncated) {
    lines.push(
      '',
      '[snapshot truncated — this page is too large to show in full. Scope your next ' +
        'step to a region you can see, or use evaluate_script to query the DOM directly.]',
    );
  }

  return {
    text: lines.join('\n') || '(empty page or no accessible content)',
    uidCount,
    truncated,
    chars,
  };
}
