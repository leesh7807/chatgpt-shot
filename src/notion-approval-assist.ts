export type NotionApprovalReason =
  | 'target_mismatch'
  | 'target_obscured'
  | 'click_not_received'
  | 'probe_failed'
  | 'broker_unavailable'
  | 'invalid_result';

export type ApprovalScreenshot = { frame: 'before_click' | 'after_click'; png: string };
type ApprovalObservation = {
  beforeArtifact?: string;
  afterArtifact?: string;
  postClickProbe?: 'not_present' | 'ready' | 'probe_failed';
  tabIndex?: number;
  openedFreshTab?: boolean;
};

export type NotionApprovalCheck =
  | ({ status: 'not_present' } & Partial<ApprovalObservation>)
  | ({ status: 'click_reported'; attemptedChoice: 'always_allow' } & Partial<ApprovalObservation>)
  | ({ status: 'click_unconfirmed'; reason: NotionApprovalReason; attemptedChoice: 'always_allow' } & Partial<ApprovalObservation>)
  | ({ status: 'unavailable'; reason: NotionApprovalReason; attemptedChoice?: 'always_allow' } & Partial<ApprovalObservation>);

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
  captureAround?(x: number, y: number): Promise<string>;
}

export interface NotionApprovalTabControl {
  currentUrl(): Promise<string>;
  openConversationTab(url: string): Promise<NotionApprovalPage>;
}

type ApprovalTabState = {
  tabCount: number;
  activeTabIndex: number;
  activePage: NotionApprovalPage;
  openNextTab: boolean;
};

const MAX_APPROVAL_TABS = 3;
const approvalTabStates = new WeakMap<NotionApprovalPage, ApprovalTabState>();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isChatGptConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && /^\/c\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch { return false; }
}

async function inspectFreshTab(page: NotionApprovalPage): Promise<Probe | 'probe_failed'> {
  const deadline = Date.now() + 5_000;
  let probeSucceeded = false;
  while (Date.now() < deadline) {
    try {
      const result = await page.within(Math.min(deadline, Date.now() + 1_200), () => page.evaluate<Probe>(serializedNotionApprovalPageProbe()));
      probeSucceeded = true;
      if (result.status === 'ready') return result;
    } catch { /* A newly opened conversation can still be hydrating. */ }
    await delay(250);
  }
  return probeSucceeded ? { status: 'not_present' } : 'probe_failed';
}

/** Check the active conversation tab, then advance to a fresh tab after each pending read and click. */
export async function checkAndAllowNotionUpdate(
  page: NotionApprovalPage,
  writeScreenshot?: (screenshot: ApprovalScreenshot) => string | undefined,
  tabControl?: NotionApprovalTabControl,
): Promise<NotionApprovalCheck> {
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

  const expression = serializedNotionApprovalPageProbe();
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

  let click: Awaited<ReturnType<NotionApprovalPage['clickAt']>>;
  try {
    click = await activePage.within(Date.now() + 1_500, () => activePage.clickAt(before.target.x, before.target.y, {
      label: 'Always allow',
      context: ['Notion'],
    }));
  } catch {
    if (tabControl) {
      state ??= { tabCount: 1, activeTabIndex: 1, activePage: page, openNextTab: false };
      state.activeTabIndex = tabIndex;
      state.activePage = activePage;
      state.openNextTab = state.tabCount < MAX_APPROVAL_TABS;
      approvalTabStates.set(page, state);
    }
    return { status: 'unavailable', reason: 'broker_unavailable', attemptedChoice: 'always_allow', ...(tabControl ? { tabIndex, ...(openedFreshTab ? { openedFreshTab: true } : {}) } : {}) };
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
  if (click.status !== 'clicked') return { status: 'click_unconfirmed', reason: click.status, attemptedChoice: 'always_allow', ...observation };
  return { status: 'click_reported', attemptedChoice: 'always_allow', ...observation };
}
