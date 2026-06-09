import stylesText from './styles.css?inline';

// Origin that served this widget script — used to default the API base and to
// locate the lazily-loaded html2canvas asset on the same host. Captured at
// module load while document.currentScript is still valid.
const WIDGET_ORIGIN = (() => {
  try {
    const s = typeof document !== 'undefined' ? document.currentScript : null;
    return s && s.src ? new URL(s.src, document.baseURI).origin : '';
  } catch {
    return '';
  }
})();

const SCREENSHOT_MAX_WIDTH = 1600;

const STATE = {
  initialized: false,
  config: {
    projectKey: null,
    apiUrl: '',
    appVersion: null,
    widgetOrigin: WIDGET_ORIGIN,
    greeting: null,
  },
  user: null,
  refs: {},
  ui: {
    activeTab: 'feedback',
    message: '',
    screenshotId: null,      // server id after upload
    screenshotPreview: null, // data URL for the in-widget thumbnail
    capturing: false,
    submitting: false,
  },
  changelog: null, // array | null = not loaded, [] = loaded but empty
  changelogLoading: false,
};

function setText(el, text) {
  el.textContent = text == null ? '' : String(text);
}

/**
 * Tiny hyperscript helper — builds real DOM nodes (never innerHTML), so the
 * widget works under `require-trusted-types-for 'script'`. `text` sets
 * textContent; `disabled` sets the property; everything else is an attribute.
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'disabled') { if (v) node.disabled = true; }
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Attach widget CSS to the shadow root. Prefers a Constructable Stylesheet
 * (not subject to the host page's `style-src` CSP); falls back to a <style>
 * element on older browsers.
 */
function applyStyles(shadow) {
  try {
    if (shadow.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(stylesText);
      shadow.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    /* fall through to <style> */
  }
  shadow.appendChild(el('style', { text: stylesText }));
}

function buildPopover() {
  const tabs = el('div', { class: 'fa-tabs', role: 'tablist' },
    el('button', { class: 'fa-tab', 'data-tab': 'changelog', 'data-active': 'false', role: 'tab' }, "What's New"),
    el('button', { class: 'fa-tab', 'data-tab': 'feedback', 'data-active': 'true', role: 'tab' }, 'Send Feedback'),
  );
  const header = el('div', { class: 'fa-header' },
    el('div', { class: 'fa-title', text: 'Feedback' }),
    tabs,
  );

  const changelogPanel = el('div', { class: 'fa-panel fa-panel-changelog', 'data-panel': 'changelog', 'data-active': 'false' },
    el('div', { class: 'fa-changelog-section' },
      el('div', { class: 'fa-section-header', text: 'Changelog' }),
      el('div', { class: 'fa-changelog-empty', text: 'No entries yet.' }),
    ),
  );

  const textarea = el('textarea', {
    class: 'fa-textarea', rows: '5',
    placeholder: "What's on your mind? Bugs, ideas, anything…",
  });
  const feedbackPanel = el('div', { class: 'fa-panel', 'data-panel': 'feedback', 'data-active': 'true' },
    textarea,
    el('div', { class: 'fa-screenshot-slot' }),
    el('div', { class: 'fa-helper', text: 'We attach the URL, your name, and the app version automatically.' }),
    el('div', { class: 'fa-actions' },
      el('button', { class: 'fa-btn fa-screenshot-btn', type: 'button' }, 'Attach screenshot'),
      el('button', { class: 'fa-btn fa-sharescreen-btn', type: 'button', title: 'Capture the actual screen (asks permission)' }, 'Share screen'),
      el('button', { class: 'fa-btn fa-btn-primary fa-send-btn', type: 'button', disabled: true }, 'Send'),
    ),
  );

  return { header, changelogPanel, feedbackPanel, textarea };
}

function ensureShadowRoot() {
  if (STATE.refs.host) return STATE.refs;

  const host = document.createElement('div');
  host.setAttribute('data-feedback-assistant', '');
  host.style.all = 'initial';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow);

  const root = el('div', { class: 'fa-root' });
  shadow.appendChild(root);

  const orb = el('button', { type: 'button', class: 'fa-orb', 'aria-label': 'Open feedback' });
  orb.addEventListener('click', () => togglePopover());
  root.appendChild(orb);

  const popover = el('div', { class: 'fa-popover', role: 'dialog', 'aria-label': 'Feedback Assistant' });
  popover.dataset.open = 'false';
  const built = buildPopover();
  popover.appendChild(built.header);
  popover.appendChild(built.changelogPanel);
  popover.appendChild(built.feedbackPanel);
  root.appendChild(popover);

  const toast = el('div', { class: 'fa-toast', role: 'status' });
  toast.dataset.visible = 'false';
  root.appendChild(toast);

  popover.querySelectorAll('.fa-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      STATE.ui.activeTab = btn.dataset.tab;
      renderTabs();
      if (btn.dataset.tab === 'changelog' && STATE.changelog === null) {
        loadChangelog();
      }
    });
  });

  const textarea = built.textarea;
  textarea.addEventListener('input', (e) => {
    STATE.ui.message = e.target.value;
    popover.querySelector('.fa-send-btn').disabled =
      !STATE.ui.message.trim() || STATE.ui.submitting;
  });

  popover.querySelector('.fa-screenshot-btn').addEventListener('click', () => handleCapture());
  popover.querySelector('.fa-sharescreen-btn').addEventListener('click', () => handleShareScreen());
  popover.querySelector('.fa-send-btn').addEventListener('click', () => handleSend());

  document.addEventListener('click', (e) => {
    if (popover.dataset.open !== 'true') return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(host) || host.contains(e.target)) return;
    setOpen(false);
  });

  STATE.refs = { host, shadow, root, orb, popover, toast, textarea };
  if (STATE.config.greeting) applyGreeting();
  return STATE.refs;
}

function renderTabs() {
  const { popover } = STATE.refs;
  popover.querySelectorAll('.fa-tab').forEach((btn) => {
    btn.dataset.active = btn.dataset.tab === STATE.ui.activeTab ? 'true' : 'false';
  });
  popover.querySelectorAll('.fa-panel').forEach((panel) => {
    panel.dataset.active = panel.dataset.panel === STATE.ui.activeTab ? 'true' : 'false';
  });
}

/**
 * Fetch per-project widget config (greeting). Fire-and-forget — any failure
 * keeps the silent default (no greeting bubble) and never breaks the widget.
 */
async function loadConfig() {
  try {
    const base = STATE.config.apiUrl.replace(/\/$/, '');
    const url = `${base}/projects/${encodeURIComponent(STATE.config.projectKey)}/widget`;
    const res = await fetch(url, { credentials: 'omit' });
    const data = await res.json().catch(() => ({}));
    if (data && typeof data.greeting === 'string' && data.greeting.trim()) {
      STATE.config.greeting = data.greeting.trim();
      applyGreeting();
    }
  } catch {
    /* keep default — no bubble */
  }
}

/** Show the per-project greeting as a dismissible bubble anchored above the orb. */
function applyGreeting() {
  const { root } = STATE.refs;
  if (!root || !STATE.config.greeting) return;
  dismissGreeting();
  const bubble = el('div', { class: 'fa-greeting', role: 'status' });
  bubble.appendChild(el('span', { class: 'fa-greeting-text', text: STATE.config.greeting }));
  const close = el('button', { type: 'button', class: 'fa-greeting-close', 'aria-label': 'Dismiss' }, '×');
  close.addEventListener('click', (e) => { e.stopPropagation(); dismissGreeting(); });
  bubble.appendChild(close);
  bubble.addEventListener('click', () => { dismissGreeting(); setOpen(true); });
  root.appendChild(bubble);
  STATE.refs.greetingBubble = bubble;
  clearTimeout(applyGreeting._t);
  applyGreeting._t = setTimeout(dismissGreeting, 8000);
}

function dismissGreeting() {
  if (STATE.refs.greetingBubble) {
    STATE.refs.greetingBubble.remove();
    STATE.refs.greetingBubble = null;
  }
}

async function loadChangelog() {
  if (STATE.changelogLoading) return;
  STATE.changelogLoading = true;
  renderChangelog(); // show loading state
  try {
    const url = `${STATE.config.apiUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(STATE.config.projectKey)}/changelog`;
    const res = await fetch(url, { credentials: 'omit' });
    const data = await res.json().catch(() => ({}));
    STATE.changelog = Array.isArray(data.changelog) ? data.changelog : [];
  } catch {
    STATE.changelog = [];
  } finally {
    STATE.changelogLoading = false;
    renderChangelog();
  }
}

function fmtPublished(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderChangelog() {
  const { popover } = STATE.refs;
  const panel = popover.querySelector('.fa-panel-changelog');
  panel.textContent = ''; // wipe — safe because we rebuild via setText/el below

  const section = el('div', { class: 'fa-changelog-section' },
    el('div', { class: 'fa-section-header', text: 'Changelog' }),
  );

  if (STATE.changelogLoading && !STATE.changelog) {
    section.appendChild(el('div', { class: 'fa-changelog-empty', text: 'Loading…' }));
  } else if (!STATE.changelog || STATE.changelog.length === 0) {
    section.appendChild(el('div', { class: 'fa-changelog-empty', text: 'No entries yet.' }));
  } else {
    const list = el('ol', { class: 'fa-changelog-list' });
    for (const entry of STATE.changelog) {
      const li = el('li', { class: 'fa-changelog-item' });
      const title = el('div', { class: 'fa-changelog-version' });
      setText(title, entry.publishedAt ? `${fmtPublished(entry.publishedAt)} · ${entry.title}` : entry.title);
      li.appendChild(title);
      if (entry.body) {
        const body = el('div', { class: 'fa-changelog-body' });
        setText(body, entry.body);
        li.appendChild(body);
      }
      list.appendChild(li);
    }
    section.appendChild(list);
  }

  panel.appendChild(section);
}

function resetScreenshot() {
  STATE.ui.screenshotId = null;
  STATE.ui.screenshotPreview = null;
}

function renderScreenshot() {
  const { popover } = STATE.refs;
  const slot = popover.querySelector('.fa-screenshot-slot');
  const captureBtns = popover.querySelectorAll('.fa-screenshot-btn, .fa-sharescreen-btn');
  slot.textContent = '';
  if (!STATE.ui.screenshotPreview) {
    captureBtns.forEach((b) => { b.style.display = ''; });
    return;
  }
  captureBtns.forEach((b) => { b.style.display = 'none'; });
  const wrap = el('div', { class: 'fa-screenshot' });
  const img = el('img', { alt: 'Screenshot preview' });
  img.src = STATE.ui.screenshotPreview;
  const remove = el('button', { type: 'button', 'aria-label': 'Remove screenshot' }, '×');
  remove.addEventListener('click', () => { resetScreenshot(); renderScreenshot(); });
  wrap.appendChild(img);
  wrap.appendChild(remove);
  slot.appendChild(wrap);
}

function setOpen(open) {
  const { popover } = STATE.refs;
  popover.dataset.open = open ? 'true' : 'false';
  if (open) {
    dismissGreeting();
    renderTabs();
    renderScreenshot();
    setTimeout(() => STATE.refs.textarea.focus(), 0);
  }
}

function togglePopover() {
  setOpen(STATE.refs.popover.dataset.open !== 'true');
}

function showToast(message, tone = 'info') {
  const { toast } = STATE.refs;
  setText(toast, message);
  toast.dataset.tone = tone;
  toast.dataset.visible = 'true';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.dataset.visible = 'false';
  }, 2400);
}

/** Lazily load self-hosted html2canvas as a classic script; resolves the global. */
function loadHtml2canvas() {
  if (typeof window !== 'undefined' && window.html2canvas) return Promise.resolve(window.html2canvas);
  if (loadHtml2canvas._p) return loadHtml2canvas._p;
  loadHtml2canvas._p = new Promise((resolve, reject) => {
    const origin = STATE.config.widgetOrigin || '';
    const s = document.createElement('script');
    s.src = `${origin}/widget/html2canvas-v1.js`;
    s.async = true;
    s.onload = () => (window.html2canvas ? resolve(window.html2canvas) : reject(new Error('html2canvas load failed')));
    s.onerror = () => { loadHtml2canvas._p = null; reject(new Error('html2canvas load failed')); };
    document.head.appendChild(s);
  });
  return loadHtml2canvas._p;
}

/** Default capture: render the current viewport to a canvas — no permission prompt. */
async function captureWithHtml2canvas() {
  const html2canvas = await loadHtml2canvas();
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / Math.max(window.innerWidth, 1));
  return html2canvas(document.body, {
    useCORS: true,
    allowTaint: false,
    logging: false,
    backgroundColor: '#ffffff',
    x: window.scrollX,
    y: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    windowWidth: document.documentElement.scrollWidth,
    windowHeight: document.documentElement.scrollHeight,
    scale,
    ignoreElements: (node) => node === STATE.refs.host,
  });
}

/** Secondary capture: getDisplayMedia (asks permission, captures real pixels). */
async function captureScreenshot() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  await new Promise((r) => setTimeout(r, 250));
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / Math.max(video.videoWidth, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  track.stop();
  video.srcObject = null;
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality);
  });
}

/** Upload a screenshot blob to /v1/screenshots; returns the stored screenshotId. */
async function uploadScreenshot(blob) {
  const base = STATE.config.apiUrl.replace(/\/$/, '');
  const form = new FormData();
  form.append('file', blob, 'screenshot.jpg');
  const res = await fetch(`${base}/screenshots`, {
    method: 'POST',
    headers: { 'X-Project-Key': STATE.config.projectKey },
    body: form,
    credentials: 'omit',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  return data.screenshotId;
}

/** Turn a captured canvas into a preview thumbnail + uploaded screenshotId. */
async function finishCapture(canvas) {
  STATE.ui.screenshotPreview = canvas.toDataURL('image/jpeg', 0.5);
  renderScreenshot();
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.7);
  STATE.ui.screenshotId = await uploadScreenshot(blob);
}

function setCaptureBusy(busy, label) {
  const { popover } = STATE.refs;
  const primary = popover.querySelector('.fa-screenshot-btn');
  const share = popover.querySelector('.fa-sharescreen-btn');
  if (primary) {
    primary.disabled = busy;
    setText(primary, label || 'Attach screenshot');
  }
  if (share) share.disabled = busy;
}

async function handleCapture() {
  if (STATE.ui.capturing) return;
  STATE.ui.capturing = true;
  setCaptureBusy(true, 'Capturing…');
  try {
    const canvas = await captureWithHtml2canvas();
    await finishCapture(canvas);
  } catch (err) {
    resetScreenshot();
    renderScreenshot();
    const msg = /load failed/.test(err?.message || '') ? 'Screenshot unavailable' : 'Could not capture screenshot';
    showToast(msg, 'error');
  } finally {
    STATE.ui.capturing = false;
    setCaptureBusy(false);
  }
}

async function handleShareScreen() {
  if (STATE.ui.capturing) return;
  setOpen(false);
  STATE.ui.capturing = true;
  try {
    const canvas = await captureScreenshot();
    setOpen(true);
    await finishCapture(canvas);
  } catch (err) {
    setOpen(true);
    resetScreenshot();
    renderScreenshot();
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
      showToast('Could not capture screenshot', 'error');
    }
  } finally {
    STATE.ui.capturing = false;
  }
}

async function handleSend() {
  const trimmed = STATE.ui.message.trim();
  if (!trimmed) {
    showToast('Add a message before sending', 'error');
    return;
  }
  if (!STATE.config.projectKey) {
    showToast('Widget not initialized', 'error');
    return;
  }

  STATE.ui.submitting = true;
  const sendBtn = STATE.refs.popover.querySelector('.fa-send-btn');
  setText(sendBtn, 'Sending…');
  sendBtn.disabled = true;

  try {
    const url = `${STATE.config.apiUrl.replace(/\/$/, '')}/submissions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Project-Key': STATE.config.projectKey,
      },
      body: JSON.stringify({
        message: trimmed,
        url: window.location.href,
        userAgent: navigator.userAgent,
        appVersion: STATE.config.appVersion ?? null,
        endUserId: STATE.user?.id ?? null,
        endUserName: STATE.user?.name ?? null,
        endUserEmail: STATE.user?.email ?? null,
        screenshotId: STATE.ui.screenshotId,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Send failed (${res.status})`);
    }
    showToast('Thanks — feedback sent');
    STATE.ui.message = '';
    resetScreenshot();
    STATE.refs.textarea.value = '';
    renderScreenshot();
    setOpen(false);
  } catch (err) {
    showToast(err?.message || 'Could not send feedback', 'error');
  } finally {
    STATE.ui.submitting = false;
    setText(sendBtn, 'Send');
    sendBtn.disabled = !STATE.ui.message.trim();
  }
}

export const FeedbackAssistant = {
  init(options = {}) {
    if (!options.projectKey) {
      console.warn('[FeedbackAssistant] projectKey is required');
      return;
    }
    STATE.config.projectKey = options.projectKey;
    STATE.config.apiUrl = options.apiUrl || '';
    STATE.config.appVersion = options.appVersion ?? null;
    STATE.config.widgetOrigin = options.widgetOrigin || STATE.config.widgetOrigin || WIDGET_ORIGIN;
    STATE.initialized = true;
    ensureShadowRoot();
    loadConfig(); // fire-and-forget greeting fetch
  },
  identify(user = {}) {
    STATE.user = {
      id: user.id ?? null,
      name: user.name ?? null,
      email: user.email ?? null,
    };
  },
  show() {
    if (!STATE.initialized) return;
    ensureShadowRoot();
    setOpen(true);
  },
};

// Auto-init when loaded via <script data-project="...">. When data-api is
// absent, default the API base to the widget host's /v1 so cross-origin embeds
// post to the right place.
if (typeof document !== 'undefined') {
  const tag = document.currentScript;
  if (tag && tag.dataset.project) {
    let scriptOrigin = WIDGET_ORIGIN;
    try { if (tag.src) scriptOrigin = new URL(tag.src, document.baseURI).origin; } catch { /* keep */ }
    FeedbackAssistant.init({
      projectKey: tag.dataset.project,
      apiUrl: tag.dataset.api || (scriptOrigin ? `${scriptOrigin}/v1` : ''),
      widgetOrigin: scriptOrigin,
    });
  }
}

if (typeof window !== 'undefined') {
  window.FeedbackAssistant = FeedbackAssistant;
}
