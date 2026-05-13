import stylesText from './styles.css?inline';

const STATE = {
  initialized: false,
  config: {
    projectKey: null,
    apiUrl: '',
    appVersion: null,
  },
  user: null,
  refs: {},
  ui: {
    activeTab: 'feedback',
    message: '',
    screenshot: null,
    capturing: false,
    submitting: false,
  },
  changelog: null, // array | null = not loaded, [] = loaded but empty
  changelogLoading: false,
};

function setText(el, text) {
  el.textContent = text == null ? '' : String(text);
}

function ensureShadowRoot() {
  if (STATE.refs.host) return STATE.refs;

  const host = document.createElement('div');
  host.setAttribute('data-feedback-assistant', '');
  host.style.all = 'initial';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = stylesText;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.className = 'fa-root';
  shadow.appendChild(root);

  const orb = document.createElement('button');
  orb.type = 'button';
  orb.className = 'fa-orb';
  orb.setAttribute('aria-label', 'Open feedback');
  orb.addEventListener('click', () => togglePopover());
  root.appendChild(orb);

  const popover = document.createElement('div');
  popover.className = 'fa-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Feedback Assistant');
  popover.dataset.open = 'false';
  root.appendChild(popover);

  popover.innerHTML = `
    <div class="fa-header">
      <div class="fa-title">Feedback Assistant</div>
      <div class="fa-tabs" role="tablist">
        <button class="fa-tab" data-tab="changelog" data-active="false" role="tab">What's New</button>
        <button class="fa-tab" data-tab="feedback" data-active="true" role="tab">Send Feedback</button>
      </div>
    </div>
    <div class="fa-panel fa-panel-changelog" data-panel="changelog" data-active="false">
      <div class="fa-changelog-section">
        <div class="fa-section-header">Changelog</div>
        <div class="fa-changelog-empty">No entries yet.</div>
      </div>
    </div>
    <div class="fa-panel" data-panel="feedback" data-active="true">
      <textarea class="fa-textarea" rows="5" placeholder="What's on your mind? Bugs, ideas, anything…"></textarea>
      <div class="fa-screenshot-slot"></div>
      <div class="fa-helper">We attach the URL, your name, and the app version automatically.</div>
      <div class="fa-actions">
        <button class="fa-btn fa-screenshot-btn" type="button">Attach screenshot</button>
        <button class="fa-btn fa-btn-primary fa-send-btn" type="button" disabled>Send</button>
      </div>
    </div>
  `;

  const toast = document.createElement('div');
  toast.className = 'fa-toast';
  toast.setAttribute('role', 'status');
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

  const textarea = popover.querySelector('.fa-textarea');
  textarea.addEventListener('input', (e) => {
    STATE.ui.message = e.target.value;
    popover.querySelector('.fa-send-btn').disabled =
      !STATE.ui.message.trim() || STATE.ui.submitting;
  });

  popover.querySelector('.fa-screenshot-btn').addEventListener('click', () => {
    handleCapture();
  });
  popover.querySelector('.fa-send-btn').addEventListener('click', () => {
    handleSend();
  });

  document.addEventListener('click', (e) => {
    if (popover.dataset.open !== 'true') return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(host) || host.contains(e.target)) return;
    setOpen(false);
  });

  STATE.refs = { host, shadow, root, orb, popover, toast, textarea };
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
  panel.textContent = ''; // wipe — safe because we'll setText each node below

  const section = document.createElement('div');
  section.className = 'fa-changelog-section';
  const header = document.createElement('div');
  header.className = 'fa-section-header';
  setText(header, 'Changelog');
  section.appendChild(header);

  if (STATE.changelogLoading && !STATE.changelog) {
    const p = document.createElement('div');
    p.className = 'fa-changelog-empty';
    setText(p, 'Loading…');
    section.appendChild(p);
  } else if (!STATE.changelog || STATE.changelog.length === 0) {
    const p = document.createElement('div');
    p.className = 'fa-changelog-empty';
    setText(p, 'No entries yet.');
    section.appendChild(p);
  } else {
    const list = document.createElement('ol');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '0.75rem';
    list.style.margin = '0';
    list.style.padding = '0';
    list.style.listStyle = 'none';
    for (const entry of STATE.changelog) {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.flexDirection = 'column';
      li.style.gap = '0.25rem';

      const title = document.createElement('div');
      title.className = 'fa-changelog-version';
      setText(title, entry.publishedAt ? `${fmtPublished(entry.publishedAt)} · ${entry.title}` : entry.title);
      li.appendChild(title);

      if (entry.body) {
        const body = document.createElement('div');
        body.style.fontSize = '0.875rem';
        body.style.whiteSpace = 'pre-wrap';
        body.style.lineHeight = '1.4';
        setText(body, entry.body);
        li.appendChild(body);
      }
      list.appendChild(li);
    }
    section.appendChild(list);
  }

  panel.appendChild(section);
}

function renderScreenshot() {
  const { popover } = STATE.refs;
  const slot = popover.querySelector('.fa-screenshot-slot');
  const btn = popover.querySelector('.fa-screenshot-btn');
  slot.textContent = '';
  if (!STATE.ui.screenshot) {
    btn.style.display = '';
    return;
  }
  btn.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = 'fa-screenshot';
  const img = document.createElement('img');
  img.alt = 'Screenshot preview';
  img.src = STATE.ui.screenshot;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove screenshot');
  setText(remove, '×');
  remove.addEventListener('click', () => {
    STATE.ui.screenshot = null;
    renderScreenshot();
  });
  wrap.appendChild(img);
  wrap.appendChild(remove);
  slot.appendChild(wrap);
}

function setOpen(open) {
  const { popover } = STATE.refs;
  popover.dataset.open = open ? 'true' : 'false';
  if (open) {
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
  const maxWidth = 1600;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  track.stop();
  video.srcObject = null;
  return canvas.toDataURL('image/jpeg', 0.7);
}

async function handleCapture() {
  setOpen(false);
  STATE.ui.capturing = true;
  try {
    const dataUrl = await captureScreenshot();
    STATE.ui.screenshot = dataUrl;
    setOpen(true);
    renderScreenshot();
  } catch (err) {
    setOpen(true);
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
        screenshotDataUrl: STATE.ui.screenshot,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `Send failed (${res.status})`);
    }
    showToast('Thanks — feedback sent');
    STATE.ui.message = '';
    STATE.ui.screenshot = null;
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
    STATE.initialized = true;
    ensureShadowRoot();
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

// Auto-init when loaded via <script data-project="...">
if (typeof document !== 'undefined') {
  const tag = document.currentScript;
  if (tag && tag.dataset.project) {
    FeedbackAssistant.init({
      projectKey: tag.dataset.project,
      apiUrl: tag.dataset.api || '',
    });
  }
}

if (typeof window !== 'undefined') {
  window.FeedbackAssistant = FeedbackAssistant;
}
