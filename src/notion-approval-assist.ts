export type NotionApprovalReason =
  | 'card_still_visible'
  | 'target_mismatch'
  | 'target_obscured'
  | 'click_not_received'
  | 'probe_failed'
  | 'broker_unavailable'
  | 'invalid_result';

export type NotionApprovalCheck =
  | { permissionChoice: 'always_allow' }
  | { status: 'not_present' | 'click_unconfirmed' | 'unavailable'; reason?: NotionApprovalReason; attemptedChoice?: 'always_allow' };

export interface NotionApprovalBrowser {
  checkPendingNotionApproval?(): Promise<NotionApprovalCheck | undefined>;
}

/** Approval recovery is best-effort; Notion readback remains authoritative. */
export async function recoverNotionWriteAccess(browser?: NotionApprovalBrowser): Promise<NotionApprovalCheck | undefined> {
  if (!browser?.checkPendingNotionApproval) return undefined;
  try { return await browser.checkPendingNotionApproval(); }
  catch { return undefined; }
}

type Probe = { status: 'ready'; target: { x: number; y: number } } | { status: 'not_present' };

/** Find the Notion prompt's visible Always allow button directly. */
export function notionApprovalPageProbe(): Probe {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    .replace(/\s*(?:esc|enter|return|↵|⏎|▼)$/i, '').trim();
  const visible = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let parent: Element | null = button; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const hasAlwaysAllowLabel = (button: HTMLButtonElement) =>
    [button.getAttribute('aria-label'), button.getAttribute('title'), button.innerText, button.textContent]
      .filter(Boolean)
      .some(value => {
        const label = normalize(value as string);
        return label === 'always allow' || label.startsWith('always allow ');
      });
  const hasNotionContext = (button: HTMLButtonElement) => {
    for (let parent: Element | null = button, depth = 0; parent && depth < 3; parent = parent.parentElement, depth++) {
      if (normalize((parent as HTMLElement).innerText || parent.textContent || '').includes('notion')) return true;
    }
    return false;
  };

  const button = [...document.querySelectorAll('button')]
    .filter((element): element is HTMLButtonElement => element.tagName === 'BUTTON')
    .find(candidate => visible(candidate) && hasAlwaysAllowLabel(candidate) && hasNotionContext(candidate));
  if (!button) return { status: 'not_present' };

  const rect = button.getBoundingClientRect();
  return { status: 'ready', target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
}

/** Build a self-contained expression for the browser page. */
export function serializedNotionApprovalPageProbe(): string {
  const nameHelper = '(target, value) => Object.defineProperty(target, "name", { value, configurable: true })';
  return `() => ((__name) => (${notionApprovalPageProbe.toString()})())(${nameHelper})`;
}

export interface NotionApprovalPage {
  within<T>(deadline: number, operation: () => Promise<T>): Promise<T>;
  evaluate<T>(expression: string, args?: unknown[]): Promise<T>;
  clickAt(x: number, y: number, expectation: { label: string; context: string[] }): Promise<{
    status: 'clicked' | 'target_mismatch' | 'target_obscured' | 'click_not_received';
  }>;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Find, click, and re-run the same button finder to confirm it is gone. */
export async function checkAndAllowNotionUpdate(page: NotionApprovalPage): Promise<NotionApprovalCheck> {
  const expression = serializedNotionApprovalPageProbe();
  const inspect = () => page.within(Date.now() + 1_200, () => page.evaluate<Probe>(expression));
  let before: Probe;
  try { before = await inspect(); }
  catch { return { status: 'unavailable', reason: 'probe_failed' }; }
  if (before.status === 'not_present') return { status: 'not_present' };

  let click: Awaited<ReturnType<NotionApprovalPage['clickAt']>>;
  try {
    click = await page.within(Date.now() + 1_500, () => page.clickAt(before.target.x, before.target.y, {
      label: 'Always allow',
      context: ['Notion'],
    }));
  } catch { return { status: 'unavailable', reason: 'broker_unavailable', attemptedChoice: 'always_allow' }; }
  if (click.status !== 'clicked') return { status: 'click_unconfirmed', reason: click.status, attemptedChoice: 'always_allow' };

  for (const interval of [150, 300, 500]) {
    await delay(interval);
    let after: Probe;
    try { after = await inspect(); }
    catch { return { status: 'click_unconfirmed', reason: 'probe_failed', attemptedChoice: 'always_allow' }; }
    if (after.status === 'not_present') return { permissionChoice: 'always_allow' };
  }
  return { status: 'click_unconfirmed', reason: 'card_still_visible', attemptedChoice: 'always_allow' };
}
