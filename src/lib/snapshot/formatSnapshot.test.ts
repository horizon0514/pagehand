import { describe, it, expect } from 'vitest';
import { formatSnapshot, type AXNode } from './formatSnapshot';

function node(partial: Partial<AXNode> & { nodeId: string }): AXNode {
  return {
    ignored: false,
    role: { type: 'role', value: 'button' },
    backendDOMNodeId: Number(partial.nodeId) + 100,
    ...partial,
  } as AXNode;
}

/** A root plus N children, so the walker has a tree to descend. */
function tree(children: AXNode[]): AXNode[] {
  const root = node({
    nodeId: '0',
    role: { type: 'role', value: 'RootWebArea' },
    childIds: children.map((c) => c.nodeId),
  });
  return [root, ...children.map((c) => ({ ...c, parentId: '0' }))];
}

/** Collects uids in assignment order. */
function makeRegister() {
  const seen: number[] = [];
  return {
    seen,
    register: (backendNodeId: number) => {
      seen.push(backendNodeId);
      return String(seen.length);
    },
  };
}

describe('formatSnapshot', () => {
  it('assigns sequential uids and renders role, name and value', () => {
    const { register } = makeRegister();
    const nodes = tree([
      node({ nodeId: '1', role: { type: 'role', value: 'link' }, name: { type: 'n', value: 'Home' } }),
      node({
        nodeId: '2',
        role: { type: 'role', value: 'textbox' },
        name: { type: 'n', value: 'Search' },
        value: { type: 'v', value: 'kittens' },
      }),
    ]);

    const { text, uidCount } = formatSnapshot(nodes, register);

    expect(uidCount).toBe(3); // root + 2 children
    expect(text).toContain('link "Home" [uid=2]');
    expect(text).toContain('textbox "Search" value="kittens" [uid=3]');
  });

  it('indents children under their parent', () => {
    const { register } = makeRegister();
    const nodes = tree([node({ nodeId: '1', name: { type: 'n', value: 'Child' } })]);

    const lines = formatSnapshot(nodes, register).text.split('\n');

    expect(lines[0].startsWith(' ')).toBe(false);
    expect(lines[1]).toMatch(/^ {2}button "Child"/);
  });

  it('prunes ignored nodes, layout-only roles, and nodes with no backing DOM node', () => {
    const { register } = makeRegister();
    const nodes = tree([
      node({ nodeId: '1', ignored: true, name: { type: 'n', value: 'hidden' } }),
      node({ nodeId: '2', role: { type: 'role', value: 'generic' }, name: { type: 'n', value: 'wrapper' } }),
      node({ nodeId: '3', role: { type: 'role', value: 'none' } }),
      node({ nodeId: '4', backendDOMNodeId: undefined, name: { type: 'n', value: 'detached' } }),
      node({ nodeId: '5', name: { type: 'n', value: 'keep me' } }),
    ]);

    const { text } = formatSnapshot(nodes, register);

    expect(text).toContain('keep me');
    for (const dropped of ['hidden', 'wrapper', 'detached']) {
      expect(text).not.toContain(dropped);
    }
  });

  it('still descends into pruned wrappers to reach real children', () => {
    const { register } = makeRegister();
    const wrapper = node({
      nodeId: '1',
      role: { type: 'role', value: 'generic' },
      childIds: ['2'],
    });
    const inner = node({ nodeId: '2', name: { type: 'n', value: 'deep' }, parentId: '1' });
    const nodes = [...tree([wrapper]), inner];

    expect(formatSnapshot(nodes, register).text).toContain('deep');
  });

  it('truncates over-long names', () => {
    const { register } = makeRegister();
    const long = 'x'.repeat(400);
    const nodes = tree([node({ nodeId: '1', name: { type: 'n', value: long } })]);

    const { text } = formatSnapshot(nodes, register);

    expect(text).toContain('…');
    expect(text).not.toContain('x'.repeat(200));
  });

  // CDP's AXValue.value is untyped and arrives as a number for spinbutton /
  // slider / price-filter nodes, which used to throw `e.replace is not a
  // function` and blind the agent for that step.
  it('renders numeric AX names and values instead of crashing', () => {
    const { register } = makeRegister();
    const nodes = tree([
      node({
        nodeId: '1',
        role: { type: 'role', value: 'spinbutton' },
        name: { type: 'n', value: 1200 } as unknown as AXNode['name'],
        value: { type: 'v', value: 350.5 } as unknown as AXNode['value'],
      }),
    ]);

    const { text } = formatSnapshot(nodes, register);

    expect(text).toContain('spinbutton "1200" value="350.5"');
  });

  it('keeps 0 and false, which are real values on a spinbutton or checkbox', () => {
    const { register } = makeRegister();
    const nodes = tree([
      node({
        nodeId: '1',
        role: { type: 'role', value: 'slider' },
        value: { type: 'v', value: 0 } as unknown as AXNode['value'],
      }),
      node({
        nodeId: '2',
        role: { type: 'role', value: 'checkbox' },
        value: { type: 'v', value: false } as unknown as AXNode['value'],
      }),
    ]);

    const { text } = formatSnapshot(nodes, register);

    expect(text).toContain('slider value="0"');
    expect(text).toContain('checkbox value="false"');
  });

  it('omits a name that is absent or empty after coercion', () => {
    const { register } = makeRegister();
    const nodes = tree([
      node({ nodeId: '1', name: { type: 'n', value: '   ' } }),
      node({ nodeId: '2', name: { type: 'n', value: null } as unknown as AXNode['name'] }),
    ]);

    const { text } = formatSnapshot(nodes, register);

    expect(text).not.toContain('""');
    expect(text).not.toContain('null');
  });

  it('collapses whitespace in names', () => {
    const { register } = makeRegister();
    const nodes = tree([node({ nodeId: '1', name: { type: 'n', value: '  a \n\n  b  ' } })]);

    expect(formatSnapshot(nodes, register).text).toContain('"a b"');
  });
});

describe('formatSnapshot — size limits', () => {
  it('stops at the character budget on a huge page and says how to proceed', () => {
    const { register } = makeRegister();
    // Long names, few enough nodes that the char budget trips before the line cap.
    const children = Array.from({ length: 600 }, (_, i) =>
      node({ nodeId: String(i + 1), name: { type: 'n', value: 'y'.repeat(115) } }),
    );

    const { text, truncated, chars } = formatSnapshot(tree(children), register);

    expect(truncated).toBe(true);
    // Bounded: an unbounded snapshot here would be ~75KB and swallow a context window.
    expect(chars).toBeLessThan(45_000);
    expect(text.split('\n').length).toBeLessThan(600);
    expect(text).toContain('snapshot truncated');
    expect(text).toContain('evaluate_script');
  });

  it('stops at the line cap when lines are short', () => {
    const { register } = makeRegister();
    const children = Array.from({ length: 2500 }, (_, i) => node({ nodeId: String(i + 1) }));

    const { text, truncated, chars } = formatSnapshot(tree(children), register);

    expect(truncated).toBe(true);
    expect(chars).toBeLessThan(40_000); // line cap hit first, not the char budget
    // 1500-line cap, plus the blank line and truncation notice.
    expect(text.split('\n').length).toBeLessThanOrEqual(1502);
  });

  it('does not mark small pages as truncated', () => {
    const { register } = makeRegister();
    const nodes = tree([node({ nodeId: '1', name: { type: 'n', value: 'small' } })]);

    const { truncated, text } = formatSnapshot(nodes, register);

    expect(truncated).toBe(false);
    expect(text).not.toContain('snapshot truncated');
  });

  it('reports a placeholder rather than empty text when nothing is keepable', () => {
    const { register } = makeRegister();
    const nodes = [node({ nodeId: '0', ignored: true, role: { type: 'role', value: 'none' } })];

    expect(formatSnapshot(nodes, register).text).toContain('empty page');
  });
});
