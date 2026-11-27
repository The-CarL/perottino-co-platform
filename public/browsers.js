'use strict';

async function browsersPage(token) {
  const sessionId = routeOption('sessionId');
  const selected = sessionId ? (await api('browser.view', { sessionId })).session : null;
  if (token !== revision) return;
  const employeeId = selected?.employeeId || routeOption('employeeId') || 'ceo';
  const who = optionSelect(
    'employeeId',
    roster.map((a) => [a.id, a.name + ' · ' + a.role]),
    employeeId,
  );
  who.onchange = () => {
    location.hash = routeTo('browsers', { employeeId: who.value });
  };
  const { sessions, profiles, catalog = [] } = await api('browser.list', { employeeId });
  if (token !== revision) return;
  if (person(employeeId)?.desiredState === 'active')
    actions.append(btn('Start browser', () => startBrowser(employeeId, profiles), { class: 'primary' }));
  const list = resourceList(
    sessions,
    (s) =>
      rowChoice(
        nameOf(s.employeeId),
        [s.profileId || 'Clean profile', 'Expires ' + date(s.expiresAt)].join(' · '),
        () => browserDialog(s),
        status(s.status),
      ),
    'No browser sessions.',
  );
  const grants = resourceList(
    profiles,
    (p) =>
      el(
        'li',
        { class: 'row' },
        el('div', {}, el('strong', {}, p.label || p.id), el('small', {}, ' · ' + nameOf(p.employeeId))),
        btn(
          'Revoke profile',
          () =>
            form(
              'Revoke browser profile',
              [sectionNote('Remove ' + nameOf(p.employeeId) + '’s access to ' + (p.label || p.id) + '.')],
              'Revoke access',
              saveAndClose(() =>
                change('browser.profile.revoke', { employeeId: p.employeeId, profileId: p.id }),
              ),
            ),
          { class: 'link' },
        ),
      ),
    'No profiles assigned.',
  );
  content.replaceChildren(
    el('div', { class: 'resource-toolbar' }, field('Employee browsers', who)),
    el(
      'div',
      { class: 'resource-grid' },
      panel('Employee sessions', list),
      panel(
        'Assigned profiles',
        grants,
        catalog.length ? btn('Grant profile', () => grantBrowserProfile(employeeId, catalog)) : null,
      ),
    ),
  );
  if (selected) await browserDialog(selected);
}
function grantBrowserProfile(employeeId, catalog) {
  const profile = optionSelect(
    'profileId',
    catalog.map((p) => [p.id, p.label]),
  );
  const originFields = el('div', {});
  function draw() {
    const p = catalog.find((x) => x.id === profile.value);
    originFields.replaceChildren(
      checks(
        'Allowed origins',
        'origins',
        p.origins.map((o) => [o, o]),
      ),
    );
    for (const box of originFields.querySelectorAll('input')) box.checked = true;
  }
  draw();
  profile.onchange = draw;
  form(
    'Grant browser profile',
    [sectionNote(nameOf(employeeId)), field('Configured profile', profile), originFields],
    'Grant profile',
    saveAndClose((data) =>
      change('browser.profile.grant', {
        employeeId,
        profileId: data.get('profileId'),
        allowedOrigins: data.getAll('origins'),
      }),
    ),
  );
}
function startBrowser(employeeId, profiles) {
  const which = optionSelect(
    'profileId',
    [['', 'Clean browser'], ...profiles.map((p) => [p.id, p.label || p.id])],
    '',
    false,
  );
  form(
    'Start browser session',
    [
      sectionNote(nameOf(employeeId)),
      field('Browser profile', which),
      field('Starting URL', textControl('url', '', { type: 'url', required: false })),
    ],
    'Start session',
    async (data) => {
      const { session } = await change('browser.start', {
        employeeId,
        ...(data.get('url') && { url: data.get('url') }),
        ...(data.get('profileId') && { profileId: data.get('profileId') }),
      });
      await render();
      await browserDialog(session);
    },
  );
}
const browserKeys = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];
async function browserDialog(session) {
  const sessionId = session.id,
    active = session.status === 'active';
  let owned = session.controller === 'owner',
    timer,
    pendingFrame,
    failedFrames = 0,
    frameWidth = 0,
    frameHeight = 0;
  const frame = el('img', {
    class: 'browser-screen',
    alt: 'Live view of ' + nameOf(session.employeeId) + '’s browser',
    hidden: true,
  });
  const state = el('p', { class: 'section-note', role: 'status' });
  const message = el('p', { class: 'error', role: 'alert', hidden: true });
  const controls = el('div', { class: 'actions' });
  const inputForm = el('div', { class: 'stack' });
  const address = textControl('url', '', { type: 'url' }),
    text = textControl('text', '', { required: false });
  const key = optionSelect(
    'key',
    browserKeys.map((k) => [k, k]),
  );
  const enable = () => {
    state.textContent = active
      ? owned
        ? 'You have control.'
        : 'Employee has control.'
      : 'Session ' + label(session.status).toLowerCase() + '.';
    frame.classList.toggle('owner', owned && active);
    inputForm.hidden = !owned || !active;
    frame.tabIndex = owned && active ? 0 : -1;
  };
  const live = () => frame.isConnected && dialog.open && !document.hidden;
  async function refresh() {
    clearTimeout(timer);
    if (!active || !frame.isConnected || !dialog.open) return;
    if (!live() || pendingFrame) {
      timer = setTimeout(refresh, 3000);
      return;
    }
    pendingFrame = api('browser.frame', { sessionId });
    try {
      const shot = await pendingFrame;
      if (!frame.isConnected || !dialog.open) return;
      if (
        !/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/=]+$/.test(shot.dataUrl) ||
        !(shot.width > 0 && shot.height > 0)
      )
        throw Error('Browser frame is unavailable.');
      frame.src = shot.dataUrl;
      frame.hidden = false;
      frameWidth = shot.width;
      frameHeight = shot.height;
      if (owned !== (shot.controller === 'owner')) {
        owned = shot.controller === 'owner';
        enable();
        draw();
      }
      failedFrames = 0;
      message.hidden = true;
    } catch (err) {
      if (!live()) return;
      failedFrames++;
      message.textContent = err.message;
      message.hidden = false;
    } finally {
      pendingFrame = undefined;
    }
    if (frame.isConnected && dialog.open && failedFrames <= 3 && session.expiresAt > Date.now())
      timer = setTimeout(refresh, Math.min(10000, 2000 * 2 ** failedFrames));
  }
  async function action(op, data = {}) {
    message.hidden = true;
    try {
      await change(op, { sessionId, ...data });
      if (op === 'browser.takeover') owned = true;
      if (op === 'browser.release') owned = false;
      enable();
      draw();
      await refresh();
    } catch (err) {
      message.textContent = err.message;
      message.hidden = false;
    }
  }
  function draw() {
    controls.replaceChildren(btn('Refresh view', refresh));
    if (active)
      controls.append(
        owned
          ? btn('Hand back control', () => action('browser.release'))
          : btn('Take control', () => action('browser.takeover'), { class: 'primary' }),
      );
    if (active || session.status === 'starting')
      controls.append(
        btn(
          'Stop session',
          () => {
            clearTimeout(timer);
            const save = el('input', { type: 'checkbox', name: 'save' });
            form(
              'Stop browser session',
              [
                sectionNote('End the browser session for ' + nameOf(session.employeeId) + '.'),
                ...(session.profileId
                  ? [el('label', {}, save, ' Save changes to the assigned profile')]
                  : []),
              ],
              'Stop session',
              saveAndClose(async (data) => {
                // The old view was detached when the confirmation opened. Finish the
                // one frame it already requested before closing the provider session.
                await pendingFrame?.catch(() => {});
                await change('browser.stop', {
                  sessionId,
                  ...(session.profileId && { saveProfile: data.has('save') }),
                });
                if (routeOption('sessionId'))
                  history.replaceState(null, '', routeTo('browsers', { employeeId: session.employeeId }));
              }),
            );
          },
          { class: 'danger' },
        ),
      );
  }
  frame.onclick = (event) => {
    if (!owned || !frameWidth || !frameHeight) return;
    const rect = frame.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(frameWidth - 1, Math.floor(((event.clientX - rect.left) * frameWidth) / rect.width)),
    );
    const y = Math.max(
      0,
      Math.min(frameHeight - 1, Math.floor(((event.clientY - rect.top) * frameHeight) / rect.height)),
    );
    void action('browser.input', { kind: 'click', x, y });
  };
  frame.onkeydown = (e) => {
    if (owned && browserKeys.includes(e.key) && e.key !== 'Tab') {
      e.preventDefault();
      void action('browser.input', { kind: 'key', key: e.key });
    }
  };
  const nav = el(
    'form',
    { class: 'resource-toolbar' },
    field('Navigate to URL', address),
    el('button', { type: 'submit' }, 'Navigate'),
  );
  nav.onsubmit = (e) => {
    e.preventDefault();
    if (owned) void action('browser.navigate', { url: address.value });
  };
  const typing = el(
    'form',
    { class: 'resource-toolbar' },
    field('Type into focused browser element', text),
    el('button', { type: 'submit' }, 'Send text'),
  );
  typing.onsubmit = (e) => {
    e.preventDefault();
    if (owned && text.value) void action('browser.input', { kind: 'type', text: text.value });
  };
  inputForm.append(
    nav,
    typing,
    el(
      'div',
      { class: 'resource-toolbar' },
      field('Browser key', key),
      btn('Send key', () => action('browser.input', { kind: 'key', key: key.value })),
    ),
  );
  enable();
  draw();
  showDialog(
    'Browser session',
    sectionNote(nameOf(session.employeeId) + ' · ' + (session.profileId || 'Clean profile')),
    el('a', { href: '/chat' + routeTo('browsers', { sessionId }) }, 'Link to this session'),
    state,
    message,
    controls,
    frame,
    inputForm,
  );
  await refresh();
}
