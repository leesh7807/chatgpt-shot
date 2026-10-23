export type AppApprovalReason =
  | 'target_mismatch'
  | 'target_obscured'
  | 'click_not_received'
  | 'probe_failed'
  | 'broker_unavailable'
  | 'invalid_result';

export type AppApprovalChoice = 'always_allow' | 'allow_once' | 'allow';
export type ApprovalScreenshot = { frame: 'before_click' | 'after_click'; png: string };
type ApprovalObservation = {
  beforeArtifact?: string;
  afterArtifact?: string;
  postClickProbe?: 'not_present' | 'ready' | 'probe_failed';
  tabIndex?: number;
  openedFreshTab?: boolean;
};

export type AppApprovalCheck =
  | ({ status: 'not_present' } & Partial<ApprovalObservation>)
  | ({ status: 'click_reported'; attemptedChoice: AppApprovalChoice } & Partial<ApprovalObservation>)
  | ({ status: 'click_unconfirmed'; reason: AppApprovalReason; attemptedChoice: AppApprovalChoice } & Partial<ApprovalObservation>)
  | ({ status: 'unavailable'; reason: AppApprovalReason; attemptedChoice?: AppApprovalChoice } & Partial<ApprovalObservation>);

export interface AppApprovalBrowser {
  requestAppApprovalAssist?(): Promise<unknown>;
}

/** Approval recovery is best-effort; Notion readback remains authoritative. */
export async function recoverPendingAppApproval(browser?: AppApprovalBrowser): Promise<AppApprovalCheck | undefined> {
  if (!browser?.requestAppApprovalAssist) return undefined;
  try {
    const result = await browser.requestAppApprovalAssist();
    if (result === undefined) return undefined;
    if (result && typeof result === 'object' && 'status' in result && typeof result.status === 'string'
      && ['not_present', 'click_reported', 'click_unconfirmed', 'unavailable'].includes(result.status)) {
      return result as AppApprovalCheck;
    }
    return { status: 'unavailable', reason: 'invalid_result' };
  } catch {
    return { status: 'unavailable', reason: 'broker_unavailable' };
  }
}

type Probe = { status: 'ready'; choice: AppApprovalChoice; target: { x: number; y: number } } | { status: 'not_present' };

/** Prefer Always allow, then Allow once, then an enabled Allow button. */
export function appApprovalPageProbe(): Probe {
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
  function choice(button: HTMLButtonElement): AppApprovalChoice | undefined {
    const labels = [button.getAttribute('aria-label'), button.getAttribute('title'), button.innerText, button.textContent]
      .filter(Boolean).map(value => normalize(value as string));
    const matches = (expected: string) => labels.some(label => label === expected || label.startsWith(`${expected} `));
    if (matches('always allow')) return 'always_allow';
    if (matches('allow once')) return 'allow_once';
    if (labels.includes('allow')) return 'allow';
    return undefined;
  }
  function enabled(button: HTMLButtonElement): boolean {
    return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }
  function hasSupportedAppContext(button: HTMLButtonElement): boolean {
    for (let parent: Element | null = button, depth = 0; parent && depth < 3; parent = parent.parentElement, depth++) {
      const text = normalize((parent as HTMLElement).innerText || parent.textContent || '');
      if (text.includes('notion') || text.includes('chrome')) return true;
    }
    return false;
  }

  const candidates = [...document.querySelectorAll('button')]
    .filter((element): element is HTMLButtonElement => element.tagName === 'BUTTON')
    .filter(candidate => visible(candidate) && enabled(candidate) && hasSupportedAppContext(candidate));
  const button = candidates.find(candidate => choice(candidate) === 'always_allow')
    ?? candidates.find(candidate => choice(candidate) === 'allow_once')
    ?? candidates.find(candidate => choice(candidate) === 'allow');
  if (!button) return { status: 'not_present' };

  const rect = button.getBoundingClientRect();
  return { status: 'ready', choice: choice(button)!, target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
}

/** Build a self-contained expression for the browser page. */
export function serializedAppApprovalPageProbe(): string {
  const source = appApprovalPageProbe.toString().replace(/__name\([\w$]+,\s*["'][^"']+["']\);/g, '');
  return `() => (${source})()`;
}

export interface AppApprovalPage {
  within<T>(deadline: number, operation: () => Promise<T>): Promise<T>;
  evaluate<T>(expression: string, args?: unknown[]): Promise<T>;
  clickAt(x: number, y: number, expectation: { label: string; context: string[] }): Promise<{
    status: 'clicked' | 'target_mismatch' | 'target_obscured' | 'click_not_received';
  }>;
  captureAround?(x: number, y: number): Promise<string>;
}

export interface AppApprovalTabControl {
  currentUrl(): Promise<string>;
  openConversationTab(url: string): Promise<AppApprovalPage>;
}

type ApprovalTabState = {
  tabCount: number;
  activeTabIndex: number;
  activePage: AppApprovalPage;
  openNextTab: boolean;
};

const MAX_APPROVAL_TABS = 3;
const approvalTabStates = new WeakMap<AppApprovalPage, ApprovalTabState>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isChatGptConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && /^\/c\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch { return false; }
}

async function inspectFreshTab(page: AppApprovalPage): Promise<Probe | 'probe_failed'> {
  const deadline = Date.now() + 5_000;
  let probeSucceeded = false;
  while (Date.now() < deadline) {
    try {
      const result = await page.within(Math.min(deadline, Date.now() + 1_200), () => page.evaluate<Probe>(serializedAppApprovalPageProbe()));
      probeSucceeded = true;
      if (result.status === 'ready') return result;
    } catch { /* A newly opened conversation can still be hydrating. */ }
    await delay(250);
  }
  return probeSucceeded ? { status: 'not_present' } : 'probe_failed';
}

/** Check the active conversation tab, then advance to a fresh tab after each pending read and click. */
export async function checkAndAllowAppApproval(
  page: AppApprovalPage,
  writeScreenshot?: (screenshot: ApprovalScreenshot) => string | undefined,
  tabControl?: AppApprovalTabControl,
): Promise<AppApprovalCheck> {
  let state = approvalTabStates.get(page);

  let activePage = state?.activePage ?? page;
  let tabIndex = state?.activeTabIndex ?? 1;
  let openedFreshTab = false;
  if (state?.openNextTab && tabControl) {
    const nextTabIndex = state.tabCount + 1;
    if (nextTabIndex > MAX_APPROVAL_TABS) {
      state.openNextTab = false;
      activePage = page;
      tabIndex = 1;
    } else {
      try {
        const url = await tabControl.currentUrl();
        if (!isChatGptConversationUrl(url)) {
          state.openNextTab = false;
          state.activePage = page;
          state.activeTabIndex = 1;
          activePage = page;
          tabIndex = 1;
          return { status: 'unavailable', reason: 'target_mismatch', tabIndex: nextTabIndex };
        }
        activePage = await tabControl.openConversationTab(url);
        tabIndex = nextTabIndex;
        state = { tabCount: nextTabIndex, activeTabIndex: tabIndex, activePage, openNextTab: false };
        approvalTabStates.set(page, state);
        openedFreshTab = true;
      } catch {
        return { status: 'unavailable', reason: 'broker_unavailable', tabIndex: nextTabIndex };
      }
    }
  }

  const expression = serializedAppApprovalPageProbe();
  const inspect = () => activePage.within(Date.now() + 1_200, () => activePage.evaluate<Probe>(expression));
  let before: Probe;
  if (openedFreshTab) {
    const result = await inspectFreshTab(activePage);
    if (result === 'probe_failed') {
      state!.activePage = page;
      state!.activeTabIndex = 1;
      return { status: 'unavailable', reason: 'probe_failed', tabIndex, openedFreshTab: true };
    }
    before = result;
  } else {
    try { before = await inspect(); }
    catch { return { status: 'unavailable', reason: 'probe_failed', ...(state ? { tabIndex } : {}) }; }
  }
  if (before.status === 'not_present') {
    if (openedFreshTab && state) {
      state.activePage = page;
      state.activeTabIndex = 1;
    }
    return { status: 'not_present', ...(openedFreshTab ? { tabIndex, openedFreshTab: true } : {}) };
  }

  const artifacts: Pick<ApprovalObservation, 'beforeArtifact' | 'afterArtifact'> = {};
  const capture = async (frame: ApprovalScreenshot['frame']) => {
    if (!writeScreenshot || !activePage.captureAround) return;
    try {
      const png = await activePage.within(Date.now() + 1_500, () => activePage.captureAround!(before.target.x, before.target.y));
      const artifact = writeScreenshot({ frame, png });
      if (artifact) artifacts[frame === 'before_click' ? 'beforeArtifact' : 'afterArtifact'] = artifact;
    }
    catch { /* Screenshot evidence must never change the approval click outcome. */ }
  };
  await capture('before_click');

  let click: Awaited<ReturnType<AppApprovalPage['clickAt']>>;
  const attemptedChoice = before.choice;
  const label = attemptedChoice === 'always_allow' ? 'Always allow'
    : attemptedChoice === 'allow_once' ? 'Allow once'
      : 'Allow';
  try {
    click = await activePage.within(Date.now() + 1_500, () => activePage.clickAt(before.target.x, before.target.y, {
      label,
      context: ['Notion', 'Chrome'],
    }));
  } catch {
    if (tabControl) {
      state ??= { tabCount: 1, activeTabIndex: 1, activePage: page, openNextTab: false };
      state.activeTabIndex = tabIndex;
      state.activePage = activePage;
      state.openNextTab = state.tabCount < MAX_APPROVAL_TABS;
      approvalTabStates.set(page, state);
    }
    return { status: 'unavailable', reason: 'broker_unavailable', attemptedChoice, ...(tabControl ? { tabIndex, ...(openedFreshTab ? { openedFreshTab: true } : {}) } : {}) };
  }
  if (writeScreenshot) await new Promise(resolve => setTimeout(resolve, 500));
  let postClickProbe: ApprovalObservation['postClickProbe'];
  if (writeScreenshot) {
    try { postClickProbe = (await inspect()).status; }
    catch { postClickProbe = 'probe_failed'; }
    await capture('after_click');
  }
  const observation = {
    ...(writeScreenshot ? { ...artifacts, postClickProbe } : {}),
    ...(tabControl ? { tabIndex, ...(openedFreshTab ? { openedFreshTab: true } : {}) } : {}),
  };
  if (tabControl) {
    state ??= { tabCount: 1, activeTabIndex: 1, activePage: page, openNextTab: false };
    state.activeTabIndex = tabIndex;
    state.activePage = activePage;
    state.openNextTab = state.tabCount < MAX_APPROVAL_TABS;
    if (state.tabCount >= MAX_APPROVAL_TABS) {
      state.activePage = page;
      state.activeTabIndex = 1;
    }
    approvalTabStates.set(page, state);
  }
  if (click.status !== 'clicked') return { status: 'click_unconfirmed', reason: click.status, attemptedChoice, ...observation };
  return { status: 'click_reported', attemptedChoice, ...observation };
}
