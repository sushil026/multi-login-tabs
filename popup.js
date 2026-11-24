// Popup: pick which profile a tab uses, open tabs as a profile, manage profiles.
// All changes go through the background worker (it owns the engine); this file only renders and sends messages.
import { COLOR_HEX, GROUP_COLORS } from './lib/colors.js';

const $ = (selector) => document.querySelector(selector);
const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

// ?tabId=<n> lets tests (and curious people) point the popup at a specific tab instead of the active one.
const tabIdOverride = new URLSearchParams(location.search).get('tabId');

let tab = null;
let state = { profiles: [], tabProfileId: null };
let editingId = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function say(text, isError = false) {
  const message = $('#message');
  message.textContent = text;
  message.classList.toggle('error', isError);
}

async function currentTab() {
  if (tabIdOverride) return chrome.tabs.get(Number(tabIdOverride));
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

// try/catch instead of URL.canParse: canParse needs Chrome 120, the manifest promises 111.
function isWebUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Runs one background action, then re-reads state. Errors are shown instead of thrown.
async function run(type, payload, successText) {
  try {
    const result = await send(type, payload);
    if (result?.error) throw new Error(result.error);
    if (successText) say(successText);
    await refresh();
    return true;
  } catch (error) {
    say(error.message, true);
    return false;
  }
}

function requireUrl() {
  const value = $('#url').value.trim();
  if (!isWebUrl(value)) {
    say('Enter a full address, for example http://localhost:3100', true);
    return null;
  }
  chrome.storage.local.set({ lastUrl: value });
  return value;
}

// A destructive button needs two clicks within 4 seconds (no confirm() dialog in a popup).
function armedButton(label, className, action) {
  const button = el('button', { type: 'button', className, textContent: label });
  let timer;
  button.addEventListener('click', () => {
    if (button.dataset.armed) {
      clearTimeout(timer);
      action();
      return;
    }
    button.dataset.armed = 'true';
    button.textContent = 'Click again to confirm';
    timer = setTimeout(() => {
      delete button.dataset.armed;
      button.textContent = label;
    }, 4000);
  });
  return button;
}

function renderCurrent() {
  const current = $('#current');
  current.replaceChildren();
  const profile = state.profiles.find((p) => p.id === state.tabProfileId);
  if (!profile) {
    current.append('This tab uses your normal browser session.');
    return;
  }
  current.append(
    'This tab uses',
    el('span', { className: 'dot', ariaHidden: 'true' }),
    el('strong', { textContent: profile.name }),
    el('button', {
      type: 'button',
      textContent: 'Remove from this tab',
      onclick: () => run('assign', { tabId: tab.id, profileId: null }, 'Tab is back on your normal session.'),
    }),
  );
  current.querySelector('.dot').style.background = COLOR_HEX[profile.color];
}

function renderEditor(profile) {
  const nameInput = el('input', { type: 'text', value: profile.name, ariaLabel: `Name for ${profile.name}`, maxLength: 40 });
  const swatches = el('fieldset', { className: 'swatches' }, el('legend', { textContent: 'Color' }));
  for (const color of GROUP_COLORS) {
    const radio = el('input', { type: 'radio', name: `color-${profile.id}`, value: color, checked: color === profile.color, ariaLabel: color });
    const dot = el('span');
    dot.style.background = COLOR_HEX[color];
    swatches.append(el('label', {}, radio, dot));
  }

  const save = el('button', { type: 'submit', className: 'primary', textContent: 'Save' });
  const host = tab?.url && isWebUrl(tab.url) ? new URL(tab.url).hostname : null;
  const row = el('div', { className: 'row' }, save);
  if (host) {
    row.append(
      el('button', {
        type: 'button',
        textContent: `Clear cookies for ${host}`,
        onclick: () => run('clear-profile', { id: profile.id, host }, `Cleared ${profile.name}'s cookies for ${host}.`),
      }),
    );
  }
  row.append(
    armedButton('Clear all cookies', 'danger', () => run('clear-profile', { id: profile.id }, `Cleared all of ${profile.name}'s cookies.`)),
    armedButton('Delete profile', 'danger', () => {
      editingId = null;
      return run('delete-profile', { id: profile.id }, `Deleted ${profile.name}.`);
    }),
  );

  const form = el('form', { className: 'editor' }, el('label', {}, 'Name', nameInput), swatches, row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const color = form.querySelector('input[type="radio"]:checked')?.value;
    run('update-profile', { id: profile.id, name: nameInput.value, color }, 'Saved.');
  });
  return form;
}

function renderProfile(profile) {
  const active = profile.id === state.tabProfileId;
  const dot = el('span', { className: 'dot', ariaHidden: 'true' });
  dot.style.background = COLOR_HEX[profile.color];

  const tabs = `${profile.tabCount} ${profile.tabCount === 1 ? 'tab' : 'tabs'}`;
  const cookies = `${profile.cookieCount} ${profile.cookieCount === 1 ? 'cookie' : 'cookies'}`;
  const editing = editingId === profile.id;

  const editButton = el('button', { type: 'button', textContent: 'Edit', ariaExpanded: String(editing) });
  editButton.addEventListener('click', () => {
    editingId = editing ? null : profile.id;
    render();
  });

  const buttons = el(
    'div',
    { className: 'buttons' },
    el('button', {
      type: 'button',
      className: 'primary',
      textContent: active ? 'In use here' : 'Use in this tab',
      disabled: active || !tab,
      onclick: () => run('assign', { tabId: tab.id, profileId: profile.id }, `This tab now uses ${profile.name}.`),
    }),
    el('button', {
      type: 'button',
      textContent: 'New tab',
      onclick: () => {
        const url = requireUrl();
        if (url) run('open-as', { profileId: profile.id, url }, `Opened a tab as ${profile.name}.`);
      },
    }),
    editButton,
  );

  const item = el(
    'li',
    { className: 'profile' },
    el('div', { className: 'head' }, dot, el('span', { className: 'name', textContent: profile.name }), el('span', { className: 'meta', textContent: `${tabs}, ${cookies}` })),
    buttons,
  );
  item.dataset.id = profile.id;
  if (active) item.setAttribute('aria-current', 'true');
  if (editing) item.append(renderEditor(profile));
  return item;
}

function renderWarning() {
  $('#warning').hidden = !state.warning;
  $('#warning-text').textContent = state.warning ?? '';
}

function render() {
  renderWarning();
  renderCurrent();
  $('#profiles').replaceChildren(...state.profiles.map(renderProfile));
}

async function refresh() {
  tab = await currentTab();
  state = await send('state', { tabId: tab?.id });
  render();
}

$('#dismiss').addEventListener('click', () => run('dismiss-warning', {}));
$('#add').addEventListener('click', () => run('create-profile', {}, 'Profile added.'));
$('#open-all').addEventListener('click', () => {
  const url = requireUrl();
  if (url) run('open-all', { url }, 'Opened one tab per profile.');
});

// Start: prefill the address from the current tab, or from the last one used.
(async () => {
  tab = await currentTab();
  const { lastUrl } = await chrome.storage.local.get('lastUrl');
  $('#url').value = tab?.url && isWebUrl(tab.url) ? tab.url : (lastUrl ?? '');
  await refresh();
})();
