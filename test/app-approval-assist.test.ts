import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAppApproval, checkAndAllowAppApproval, appApprovalPageProbe, serializedAppApprovalPageProbe, chatGptConversationIdentity } from '../src/app-approval-assist.js';
import { dispatchTrustedClick } from '../src/broker.js';

function element(tagName: string, text = '', children: any[] = [], options: { role?: string; disabled?: boolean; hidden?: boolean; rect?: { left: number; top: number; width: number; height: number }; onClick?: () => void } = {}): any {
  const node: any = {
    tagName,
    parentElement: undefined,
    children,
    disabled: options.disabled ?? false,
    getAttribute(name: string) { return name === 'role' ? options.role ?? null : null; },
    hidden: options.hidden ?? false,
    closest(selector: string) {
      let current: any = this;
      while (current) { if (selector === 'form' && current.tagName === 'FORM') return current; current = current.parentElement; }
      return null;
    },
    getBoundingClientRect() { return options.rect ?? { left: 0, top: 0, width: 100, height: 20 }; },
    querySelectorAll(selector: string) {
      const descendants = (parent: any): any[] => parent.children.flatMap((child: any) => [child, ...descendants(child)]);
      return descendants(this).filter(child => selector === 'form'
        ? child.tagName === 'FORM'
        : selector === '*'
          ? true
        : selector.includes('button') && (child.tagName === 'BUTTON' || child.getAttribute('role') === 'button'));
    },
    click() { options.onClick?.(); },
  };
  node.childNodes = [...(text ? [{ nodeType: 3, textContent: text }] : []), ...children];
  node.ownText = text;
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
  global.document = { body: root, querySelectorAll: (selector: string) => root.querySelectorAll(selector) };
  global.window = { innerWidth: 1280, innerHeight: 800 };
  global.getComputedStyle = (element: any) => ({ visibility: element.hidden ? 'hidden' : 'visible', display: element.hidden ? 'none' : 'block', opacity: '1' });
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
  const result = withDom(root, () => appApprovalPageProbe());
  assert.deepEqual(result, {
    status: 'ready',
    choice: 'always_allow',
    target: { x: 100, y: 80 },
  });
  assert.equal(directDomClick, false);
});

test('probe chooses an Always allow button with nearby Notion context', () => {
  const match = notionCard();
  const otherButton = element('BUTTON', 'Always allow');
  const otherCard = element('DIV', 'Allow ChatGPT to use another app? ChatGPT will call another app tool.', [element('FORM', '', [otherButton])]);
  const root = element('DIV', '', [match.card, otherCard]);
  const result = withDom(root, () => appApprovalPageProbe());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.target, { x: 100, y: 80 });
});

test('probe prefers Always allow and falls back to an enabled Allow once button', () => {
  const onceOnly = notionCard({ actionLabels: ['Allow once ⏎', 'Deny Esc'] });
  assert.deepEqual(withDom(element('DIV', '', [onceOnly.card]), () => appApprovalPageProbe()), {
    status: 'ready', choice: 'allow_once', target: { x: 350, y: 80 },
  });

  const disabled = notionCard({ disabledChoice: 'Always allow' });
  assert.deepEqual(withDom(element('DIV', '', [disabled.card]), () => appApprovalPageProbe()), {
    status: 'ready', choice: 'allow_once', target: { x: 350, y: 80 },
  });
});

test('probe accepts the third ancestor when it contains one supported approval action group', () => {
  const actions = element('FORM', '', [element('BUTTON', 'Always allow'), element('BUTTON', 'Deny Esc')]);
  const requestBranch = element('DIV', 'Allow ChatGPT to use Notion? ChatGPT will call its Update page tool.', [actions]);
  const card = element('DIV', '', [requestBranch]);
  assert.deepEqual(withDom(card, () => appApprovalPageProbe()), {
    status: 'ready', choice: 'always_allow', target: { x: 50, y: 10 },
  });
});

test('probe accepts request text owned by the third-ancestor approval card', () => {
  const actions = element('FORM', '', [element('BUTTON', 'Always allow'), element('BUTTON', 'Deny Esc')]);
  const card = element('DIV', 'Allow ChatGPT to use Notion?', [element('DIV', '', [actions])]);
  assert.deepEqual(withDom(card, () => appApprovalPageProbe()), {
    status: 'ready', choice: 'always_allow', target: { x: 50, y: 10 },
  });
});

test('probe rejects an unsupported request inside a card with direct supported-app text', () => {
  const actions = element('FORM', '', [element('BUTTON', 'Always allow'), element('BUTTON', 'Deny Esc')]);
  const card = element('DIV', 'Allow ChatGPT to use Notion?', [element('DIV', 'ChatGPT will call Calendar', [actions])]);
  assert.deepEqual(withDom(card, () => appApprovalPageProbe()), { status: 'not_present' });
});

test('probe rejects app context found only above the third ancestor', () => {
  const actions = element('FORM', '', [element('BUTTON', 'Always allow'), element('BUTTON', 'Deny Esc')]);
  const tooDeep = element('DIV', 'Notion', [element('DIV', '', [element('DIV', '', [element('DIV', '', [actions])])])]);
  assert.deepEqual(withDom(tooDeep, () => appApprovalPageProbe()), { status: 'not_present' });
});

test('conversation identity is limited to a concrete ChatGPT conversation route', () => {
  assert.equal(chatGptConversationIdentity('https://chatgpt.com/c/abc_123?model=private'), 'https://chatgpt.com/c/abc_123');
  assert.equal(chatGptConversationIdentity('https://chatgpt.com/'), undefined);
  assert.equal(chatGptConversationIdentity('https://chatgpt.example/c/abc_123'), undefined);
  assert.equal(chatGptConversationIdentity('https://chatgpt.com/c/abc_123/settings'), undefined);
});

test('probe rejects a button hidden by a distant ancestor', () => {
  const match = notionCard();
  const hidden = element('DIV', '', [element('DIV', '', [element('DIV', '', [match.card])])], { hidden: true });
  assert.deepEqual(withDom(hidden, () => appApprovalPageProbe()), { status: 'not_present' });
});

test('probe rejects app text from a sibling approval card and ambiguous approval cards', () => {
  const notion = notionCard({ actionLabels: ['Always allow', 'Deny Esc'] }).card;
  const otherApp = element('DIV', 'Allow ChatGPT to use Calendar?', [element('FORM', '', [
    element('BUTTON', 'Allow once'), element('BUTTON', 'Deny Esc'),
  ])]);
  const root = element('DIV', '', [notion, otherApp]);
  assert.deepEqual(withDom(root, () => appApprovalPageProbe()), {
    status: 'ready', choice: 'always_allow', target: { x: 100, y: 80 },
  });

  const requestFromSibling = element('DIV', '', [
    element('DIV', 'Allow ChatGPT to use Notion?'),
    element('DIV', 'Allow ChatGPT to use Calendar?', [element('FORM', '', [
      element('BUTTON', 'Allow once'), element('BUTTON', 'Deny Esc'),
    ])]),
  ]);
  assert.deepEqual(withDom(requestFromSibling, () => appApprovalPageProbe()), { status: 'not_present' });

  const supportedPhraseBesideOtherApp = element('SECTION', '', [
    element('DIV', 'Allow ChatGPT to use Notion?'),
    element('FORM', 'Allow ChatGPT to use Calendar?', [
      element('BUTTON', 'Always allow'), element('BUTTON', 'Deny'),
    ]),
  ]);
  assert.deepEqual(withDom(supportedPhraseBesideOtherApp, () => appApprovalPageProbe()), { status: 'not_present' });

  const mixedRequestsInOneBranch = element('DIV', '', [element('DIV', '', [
    element('DIV', 'Allow ChatGPT to use Notion?'),
    element('DIV', 'Allow ChatGPT to use Calendar?'),
    element('FORM', '', [element('BUTTON', 'Always allow'), element('BUTTON', 'Deny')]),
  ])]);
  assert.deepEqual(withDom(mixedRequestsInOneBranch, () => appApprovalPageProbe()), { status: 'not_present' });

  const chrome = element('DIV', '', [element('DIV', 'Allow ChatGPT to use Chrome?', [element('FORM', '', [
    element('BUTTON', 'Allow once'), element('BUTTON', 'Deny Esc'),
  ])])]);
  assert.deepEqual(withDom(element('DIV', '', [notion, chrome]), () => appApprovalPageProbe()), { status: 'not_present' });

  const unrelated = element('DIV', 'Notion is available in this conversation.', [element('FORM', '', [
    element('BUTTON', 'Allow'), element('BUTTON', 'Deny'),
  ])]);
  assert.deepEqual(withDom(unrelated, () => appApprovalPageProbe()), { status: 'not_present' });

  const plainAllow = element('DIV', '', [element('DIV', 'Allow ChatGPT to use Notion?', [element('FORM', '', [
    element('BUTTON', 'Allow'), element('BUTTON', 'Deny'),
  ])])]);
  assert.deepEqual(withDom(plainAllow, () => appApprovalPageProbe()), { status: 'ready', choice: 'allow', target: { x: 50, y: 10 } });
});

test('serialized probe is self-contained and accepts Allow once when Always allow is absent', () => {
  const match = notionCard({ actionLabels: ['Allow once ⏎', 'Deny Esc'] });
  const root = element('DIV', '', [match.card]);
  const result = withDom(root, () => {
    const globals = globalThis as any;
    const run = new Function('document', 'window', 'getComputedStyle', `return (${serializedAppApprovalPageProbe()})()`);
    return run(globals.document, globals.window, globals.getComputedStyle);
  });
  assert.deepEqual(result, { status: 'ready', choice: 'allow_once', target: { x: 350, y: 80 } });
});

test('probe refuses to guess when a card has multiple equally prioritized buttons', () => {
  const ambiguous = notionCard({ secondAlwaysAllow: true });
  const result = withDom(element('DIV', '', [ambiguous.card]), () => appApprovalPageProbe());
  assert.deepEqual(result, { status: 'not_present' });
});

test('assist reports the trusted click and leaves retry timing to the pending service loop', async () => {
  const results = [
    { status: 'ready', choice: 'allow_once', target: { x: 100, y: 80 } },
  ];
  const clicks: Array<{ x: number; y: number; label: string }> = [];
  let probes = 0;
  const page = {
    async within<T>(_deadline: number, operation: () => Promise<T>) { return operation(); },
    async evaluate<T>(_expression: string) { probes++; return results.shift() as T; },
    async clickAt(x: number, y: number, expectation: { label: string }) { clicks.push({ x, y, label: expectation.label }); return { status: 'clicked' as const }; },
  };
  assert.deepEqual(await checkAndAllowAppApproval(page), { status: 'click_reported', attemptedChoice: 'allow_once' });
  assert.deepEqual(clicks, [{ x: 100, y: 80, label: 'Allow once' }]);
  assert.equal(probes, 1);
});

test('opt-in approval observation captures the target before and after click and reports the post-click probe', async () => {
  const results = [
    { status: 'ready', choice: 'always_allow', target: { x: 100, y: 80 } },
    { status: 'not_present' },
  ];
  const screenshots: Array<{ frame: string; png: string }> = [];
  const targets: Array<{ x: number; y: number }> = [];
  const page = {
    async within<T>(_deadline: number, operation: () => Promise<T>) { return operation(); },
    async evaluate<T>(_expression: string) { return results.shift() as T; },
    async clickAt() { return { status: 'clicked' as const }; },
    async captureAround(x: number, y: number) { targets.push({ x, y }); return 'cG5n'; },
  };
  const result = await checkAndAllowAppApproval(page, screenshot => {
    screenshots.push(screenshot);
    return `approval-${screenshot.frame}.png`;
  });
  assert.deepEqual(result, {
    status: 'click_reported',
    attemptedChoice: 'always_allow',
    beforeArtifact: 'approval-before_click.png',
    afterArtifact: 'approval-after_click.png',
    postClickProbe: 'not_present',
  });
  assert.deepEqual(screenshots, [
    { frame: 'before_click', png: 'cG5n' },
    { frame: 'after_click', png: 'cG5n' },
  ]);
  assert.deepEqual(targets, [{ x: 100, y: 80 }, { x: 100, y: 80 }]);
});

test('approval retries move through fresh copies of the same conversation and stop after three tabs', async () => {
  const page = (label: string, probes: Array<{ status: 'ready'; choice: 'always_allow' | 'allow_once'; target: { x: number; y: number } } | { status: 'not_present' }>) => {
    const clicks: string[] = [];
    return {
      clicks,
      async within<T>(_deadline: number, operation: () => Promise<T>) { return operation(); },
      async evaluate<T>() { return (probes.shift() ?? { status: 'not_present' }) as T; },
      async clickAt() { clicks.push(label); return { status: 'clicked' as const }; },
    };
  };
  const ready = { status: 'ready' as const, choice: 'always_allow' as const, target: { x: 100, y: 80 } };
  const primary = page('tab-1', [ready, { status: 'not_present' }]);
  const second = page('tab-2', [ready]);
  const third = page('tab-3', [ready]);
  const freshPages = [second, third];
  const opened: string[] = [];
  const tabs = {
    async currentUrl() { return 'https://chatgpt.com/c/6ac9f22d-77c0-83ec-b2ad-9f3b91d2a5bb'; },
    async openConversationTab(url: string) { opened.push(url); return freshPages.shift()!; },
  };

  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), {
    status: 'click_reported', attemptedChoice: 'always_allow', tabIndex: 1,
  });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), {
    status: 'click_reported', attemptedChoice: 'always_allow', tabIndex: 2, openedFreshTab: true,
  });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), {
    status: 'click_reported', attemptedChoice: 'always_allow', tabIndex: 3, openedFreshTab: true,
  });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), { status: 'not_present' });
  assert.deepEqual(primary.clicks, ['tab-1']);
  assert.deepEqual(second.clicks, ['tab-2']);
  assert.deepEqual(third.clicks, ['tab-3']);
  assert.deepEqual(opened, [
    'https://chatgpt.com/c/6ac9f22d-77c0-83ec-b2ad-9f3b91d2a5bb',
    'https://chatgpt.com/c/6ac9f22d-77c0-83ec-b2ad-9f3b91d2a5bb',
  ]);
});

test('a missing card in a fresh tab returns to the original tab for later approvals', async () => {
  const makePage = (probes: Array<{ status: 'ready'; choice: 'always_allow' | 'allow_once'; target: { x: number; y: number } } | { status: 'not_present' }>) => {
    const clicks: number[] = [];
    return {
      clicks,
      async within<T>(_deadline: number, operation: () => Promise<T>) { return operation(); },
      async evaluate<T>() { return (probes.shift() ?? { status: 'not_present' }) as T; },
      async clickAt(x: number) { clicks.push(x); return { status: 'clicked' as const }; },
    };
  };
  const primary = makePage([
    { status: 'ready', choice: 'always_allow', target: { x: 100, y: 80 } },
    { status: 'not_present' },
    { status: 'ready', choice: 'always_allow', target: { x: 100, y: 80 } },
  ]);
  const second = makePage([{ status: 'not_present' }]);
  const third = makePage([{ status: 'ready', choice: 'always_allow', target: { x: 120, y: 90 } }]);
  const freshPages = [second, third];
  let opened = 0;
  const tabs = {
    async currentUrl() { return 'https://chatgpt.com/c/6ac9f22d-77c0-83ec-b2ad-9f3b91d2a5bb'; },
    async openConversationTab() { opened++; return freshPages.shift()!; },
  };
  await checkAndAllowAppApproval(primary, undefined, tabs);
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), {
    status: 'not_present', tabIndex: 2, openedFreshTab: true,
  });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), { status: 'not_present' });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), {
    status: 'click_reported', attemptedChoice: 'always_allow', tabIndex: 1,
  });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), {
    status: 'click_reported', attemptedChoice: 'always_allow', tabIndex: 3, openedFreshTab: true,
  });
  assert.deepEqual(await checkAndAllowAppApproval(primary, undefined, tabs), { status: 'not_present' });
  assert.equal(opened, 2);
  assert.deepEqual(primary.clicks, [100, 100]);
  assert.deepEqual(second.clicks, []);
  assert.deepEqual(third.clicks, [120]);
});

test('service-facing assist adapter keeps browser failures best-effort', async () => {
  assert.deepEqual(await requestAppApproval({ async requestAppApprovalAssist() { throw new Error('broker unavailable'); } }), { status: 'unavailable', reason: 'broker_unavailable' });
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
