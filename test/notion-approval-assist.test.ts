import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverNotionWriteAccess, checkAndAllowNotionUpdate, notionApprovalPageProbe, serializedNotionApprovalPageProbe } from '../src/notion-approval-assist.js';
import { dispatchTrustedClick } from '../src/broker.js';

function element(tagName: string, text = '', children: any[] = [], options: { role?: string; disabled?: boolean; rect?: { left: number; top: number; width: number; height: number }; onClick?: () => void } = {}): any {
  const node: any = {
    tagName,
    parentElement: undefined,
    children,
    disabled: options.disabled ?? false,
    getAttribute(name: string) { return name === 'role' ? options.role ?? null : null; },
    closest(selector: string) {
      let current: any = this;
      while (current) {
        if (selector === 'form' && current.tagName === 'FORM') return current;
        if (selector.includes('button') && (current.tagName === 'BUTTON' || current.getAttribute('role') === 'button')) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(target: any) {
      let current = target;
      while (current) { if (current === this) return true; current = current.parentElement; }
      return false;
    },
    getBoundingClientRect() { return options.rect ?? { left: 0, top: 0, width: 100, height: 20 }; },
    querySelectorAll(selector: string) {
      const descendants = (parent: any): any[] => parent.children.flatMap((child: any) => [child, ...descendants(child)]);
      return descendants(this).filter(child => selector === 'form'
        ? child.tagName === 'FORM'
        : selector.includes('button') && (child.tagName === 'BUTTON' || child.getAttribute('role') === 'button'));
    },
    click() { options.onClick?.(); },
  };
  Object.defineProperty(node, 'textContent', { get: () => `${text} ${children.map(child => child.textContent).join(' ')}`.trim() });
  Object.defineProperty(node, 'innerText', { get: () => `${text} ${children.map(child => child.innerText).join(' ')}`.trim() });
  for (const child of children) child.parentElement = node;
  return node;
}

function notionCard(options: { actionLabels?: string[]; secondAlwaysAllow?: boolean; disabledChoice?: string; onClick?: () => void } = {}) {
  const labels = options.actionLabels ?? ['Always allow', 'Deny Esc', 'Allow once ⏎', 'Approval options'];
  const actions = labels.map(text => element('BUTTON', text, [], {
    disabled: options.disabledChoice === text,
    rect: { left: text.startsWith('Allow once') ? 300 : 50, top: 70, width: 100, height: 20 },
    onClick: text === 'Always allow' ? options.onClick : undefined,
    role: text === 'Approval options' ? 'button' : undefined,
  }));
  if (options.secondAlwaysAllow) actions.push(element('BUTTON', 'Always allow', [], { rect: { left: 450, top: 70, width: 100, height: 20 } }));
  const form = element('FORM', '', actions);
  const cardBody = element('DIV', "Notion Allow ChatGPT to use Notion? ChatGPT will call Notion's Update Notion page tool. See details", [form]);
  return { card: element('DIV', '', [cardBody]) };
}

function withDom<T>(root: any, run: () => T): T {
  const global = globalThis as any;
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalGetComputedStyle = global.getComputedStyle;
  global.document = {
    body: root,
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    elementFromPoint(x: number, y: number) {
      return root.querySelectorAll('button,[role="button"]').find((action: any) => {
        const rect = action.getBoundingClientRect();
        return x >= rect.left && y >= rect.top && x < rect.left + rect.width && y < rect.top + rect.height;
      }) ?? null;
    },
  };
  global.window = { innerWidth: 1280, innerHeight: 800 };
  global.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  try { return run(); }
  finally {
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalGetComputedStyle === undefined) delete global.getComputedStyle;
    else global.getComputedStyle = originalGetComputedStyle;
  }
}

test('page probe returns the exact card button target for a trusted browser click', () => {
  let directDomClick = false;
  const match = notionCard({ onClick: () => { directDomClick = true; } });
  const root = element('DIV', '', [match.card]);
  const result = withDom(root, () => notionApprovalPageProbe());
  assert.deepEqual(result, {
    status: 'ready',
    target: { x: 100, y: 80 },
  });
  assert.equal(directDomClick, false);
});

test('probe chooses an Always allow button with nearby Notion context', () => {
  const match = notionCard();
  const otherButton = element('BUTTON', 'Always allow');
  const otherCard = element('DIV', 'Allow ChatGPT to use another app? ChatGPT will call another app tool.', [element('FORM', '', [otherButton])]);
  const root = element('DIV', '', [match.card, otherCard]);
  const result = withDom(root, () => notionApprovalPageProbe());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.target, { x: 100, y: 80 });
});

test('probe requires Always allow and keeps a disabled matching button present', () => {
  const onceOnly = notionCard({ actionLabels: ['Allow once ⏎', 'Deny Esc'] });
  assert.deepEqual(withDom(element('DIV', '', [onceOnly.card]), () => notionApprovalPageProbe()), { status: 'not_present' });

  const disabled = notionCard({ disabledChoice: 'Always allow' });
  assert.equal(withDom(element('DIV', '', [disabled.card]), () => notionApprovalPageProbe()).status, 'ready');
});

test('serialized probe is self-contained and does not accept Allow once', () => {
  const match = notionCard({ actionLabels: ['Allow once ⏎', 'Deny Esc'] });
  const root = element('DIV', '', [match.card]);
  const result = withDom(root, () => {
    const globals = globalThis as any;
    const run = new Function('document', 'window', 'getComputedStyle', `return (${serializedNotionApprovalPageProbe()})()`);
    return run(globals.document, globals.window, globals.getComputedStyle);
  });
  assert.deepEqual(result, { status: 'not_present' });
});

test('probe selects the first matching Always allow button', () => {
  const ambiguous = notionCard({ secondAlwaysAllow: true });
  const result = withDom(element('DIV', '', [ambiguous.card]), () => notionApprovalPageProbe());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.target, { x: 100, y: 80 });
});

test('assist owns the browser probe, trusted click, and post-click verification', async () => {
  const results = [
    { status: 'ready', choice: 'always_allow', target: { x: 100, y: 80 } },
    { status: 'not_present' },
  ];
  const clicks: Array<{ x: number; y: number }> = [];
  const page = {
    async within<T>(_deadline: number, operation: () => Promise<T>) { return operation(); },
    async evaluate<T>(_expression: string) { return results.shift() as T; },
    async clickAt(x: number, y: number) { clicks.push({ x, y }); return { status: 'clicked' as const }; },
  };
  assert.deepEqual(await checkAndAllowNotionUpdate(page), { permissionChoice: 'always_allow' });
  assert.deepEqual(clicks, [{ x: 100, y: 80 }]);
});

test('service-facing assist adapter keeps browser failures best-effort', async () => {
  assert.equal(await recoverNotionWriteAccess({ async checkPendingNotionApproval() { throw new Error('broker unavailable'); } }), undefined);
});

test('trusted approval click dispatches mouse movement, press, and release in order', async () => {
  const events: unknown[] = [];
  await dispatchTrustedClick(async event => { events.push(event); }, 100, 80);
  assert.deepEqual(events, [
    { type: 'mouseMoved', x: 100, y: 80, button: 'none', buttons: 0, clickCount: 0 },
    { type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 },
  ]);
});

test('trusted approval click always releases the mouse after a press error', async () => {
  const events: string[] = [];
  await assert.rejects(dispatchTrustedClick(async event => {
    events.push(event.type);
    if (event.type === 'mousePressed') throw new Error('press response lost');
  }, 100, 80), /press response lost/);
  assert.deepEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});
