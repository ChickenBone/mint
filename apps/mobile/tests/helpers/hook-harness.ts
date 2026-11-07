// Minimal DOM host for react-dom without adding a test renderer; hooks render nothing.
const noop = () => {};
const doc: Record<string, unknown> = { nodeType: 9, addEventListener: noop, removeEventListener: noop, activeElement: null };
const host = { event: undefined, addEventListener: noop, removeEventListener: noop, document: doc, HTMLIFrameElement: class {} };
Object.assign(globalThis, { window: host, IS_REACT_ACT_ENVIRONMENT: true });
doc.defaultView = host;
const element = () => ({ nodeType: 1, ownerDocument: doc, addEventListener: noop, removeEventListener: noop, childNodes: [], firstChild: null,
  nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", textContent: "", removeChild: noop, appendChild: noop });
doc.documentElement = element();

export async function harness<P, R>(hook: (props: P) => R, props: P) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const latest: { current: R | null } = { current: null };
  function Probe(next: { value: P }) { latest.current = hook(next.value); return null; }
  const root = createRoot(element() as unknown as Element);
  const flush = async () => { for (let i = 0; i < 4; i += 1) await React.act(async () => { await Promise.resolve(); }); };
  const render = async (value: P) => { await React.act(async () => { root.render(React.createElement(Probe, { value })); }); await flush(); };
  await render(props);
  return {
    get current() { return latest.current!; }, render, flush,
    act: async (fn: () => void | Promise<void>) => { await React.act(async () => { await fn(); }); await flush(); },
    unmount: async () => { await React.act(async () => { root.unmount(); }); },
  };
}
