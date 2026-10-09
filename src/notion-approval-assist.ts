export type NotionApprovalReason =
  | 'target_mismatch'
  | 'target_obscured'
  | 'click_not_received'
  | 'probe_failed'
  | 'broker_unavailable'
  | 'invalid_result';

export type NotionApprovalCheck =
  | { status: 'not_present' }
  | { status: 'click_reported'; attemptedChoice: 'always_allow' }
  | { status: 'click_unconfirmed'; reason: NotionApprovalReason; attemptedChoice: 'always_allow' }
  | { status: 'unavailable'; reason: NotionApprovalReason; attemptedChoice?: 'always_allow' };

export interface NotionApprovalBrowser {
  requestNotionApprovalAssist?(): Promise<unknown>;
}

/** Approval recovery is best-effort; Notion readback remains authoritative. */
export async function recoverNotionWriteAccess(browser?: NotionApprovalBrowser): Promise<NotionApprovalCheck | undefined> {
  if (!browser?.requestNotionApprovalAssist) return undefined;
  try {
    const result = await browser.requestNotionApprovalAssist();
    if (result === undefined) return undefined;
    if (result && typeof result === 'object' && 'status' in result && typeof result.status === 'string'
      && ['not_present', 'click_reported', 'click_unconfirmed', 'unavailable'].includes(result.status)) {
      return result as NotionApprovalCheck;
    }
    return { status: 'unavailable', reason: 'invalid_result' };
  } catch {
    return { status: 'unavailable', reason: 'broker_unavailable' };
  }
}

type Probe = { status: 'ready'; target: { x: number; y: number } } | { status: 'not_present' };

/** Find the Notion prompt's visible Always allow button directly. */
export function notionApprovalPageProbe(): Probe {
  function normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
      .replace(/\s*(?:esc|enter|return|↵|⏎|▼)$/i, '').trim();
  }
  function visible(button: HTMLButtonElement): boolean {
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let parent: Element | null = button; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }
  function hasAlwaysAllowLabel(button: HTMLButtonElement): boolean {
    return [button.getAttribute('aria-label'), button.getAttribute('title'), button.innerText, button.textContent]
      .filter(Boolean)
      .some(value => {
        const label = normalize(value as string);
        return label === 'always allow' || label.startsWith('always allow ');
      });
  }
  function hasNotionContext(button: HTMLButtonElement): boolean {
    for (let parent: Element | null = button, depth = 0; parent && depth < 3; parent = parent.parentElement, depth++) {
      if (normalize((parent as HTMLElement).innerText || parent.textContent || '').includes('notion')) return true;
    }
    return false;
  }

  const button = [...document.querySelectorAll('button')]
    .filter((element): element is HTMLButtonElement => element.tagName === 'BUTTON')
    .find(candidate => visible(candidate) && hasAlwaysAllowLabel(candidate) && hasNotionContext(candidate));
  if (!button) return { status: 'not_present' };

  const rect = button.getBoundingClientRect();
  return { status: 'ready', target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
}

/** Build a self-contained expression for the browser page. */
export function serializedNotionApprovalPageProbe(): string {
  const source = notionApprovalPageProbe.toString().replace(/__name\([\w$]+,\s*["'][^"']+["']\);/g, '');
  return `() => (${source})()`;
}

export interface NotionApprovalPage {
  within<T>(deadline: number, operation: () => Promise<T>): Promise<T>;
  evaluate<T>(expression: string, args?: unknown[]): Promise<T>;
  clickAt(x: number, y: number, expectation: { label: string; context: string[] }): Promise<{
    status: 'clicked' | 'target_mismatch' | 'target_obscured' | 'click_not_received';
  }>;
}

/** Find the Notion prompt and report the trusted click result; the caller retries while pending. */
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
  return { status: 'click_reported', attemptedChoice: 'always_allow' };
}
