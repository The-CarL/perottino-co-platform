'use strict';
const byId = (id) => document.getElementById(id);
const content = byId('content');
const actions = byId('page-actions');
const dialog = byId('dialog');
const sections = {
  dashboard: 'Dashboard',
  goals: 'Goals',
  tasks: 'Tasks',
  activity: 'Activity',
  chat: 'Chat',
  directory: 'Directory',
  admin: 'Admin',
  files: 'Files',
  settings: 'Settings',
  projects: 'Projects',
  mail: 'Email',
  browsers: 'Browsers',
};
let page = '',
  revision = 0,
  roster = [],
  chat = null,
  refreshTimer;
const drafts = new Map();
const requestKeys = new Map();

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'onClick') node.addEventListener('click', () => run(value));
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null));
  return node;
}
const btn = (label, onClick, options = {}) => el('button', { type: 'button', onClick, ...options }, label);
const link = (pageName, label) => el('a', { href: '#' + pageName }, label);
const empty = (text) => el('p', { class: 'empty' }, text);
function notify(message = '') {
  const notice = byId('notice');
  notice.textContent = message;
  notice.hidden = !message;
}
async function run(fn) {
  try {
    await fn();
  } catch (error) {
    notify(error.message || 'The request could not be completed.');
  }
}
async function api(op, input = {}) {
  return request('/api/company/' + op, input);
}
async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'owner-console' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to load this record. Please retry.');
  return data;
}
// An ambiguous response can be retried without creating a duplicate record.
async function change(op, input, transport = api) {
  const key = JSON.stringify([op, input]);
  const requestId = requestKeys.get(key) || crypto.randomUUID();
  requestKeys.set(key, requestId);
  const result = await transport(op, { ...input, requestId });
  requestKeys.delete(key);
  return result;
}
const person = (id) => roster.find((a) => a.id === id);
const nameOf = (id) => (id === 'owner' ? 'Owner' : person(id)?.name || id || 'Unassigned');
const label = (value) =>
  String(value || '')
    .replace(/[_.-]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
function date(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? ''
    : time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function status(value) {
  return el('span', { class: 'badge ' + value }, label(value));
}
function panel(title, body, extra) {
  return el(
    'section',
    { class: 'panel' },
    el('div', { class: 'section-head' }, el('h2', {}, title), extra),
    body,
  );
}
function facts(items) {
  const dl = el('dl', { class: 'details' });
  for (const [key, val] of items)
    if (val !== undefined && val !== '' && val !== null) dl.append(el('dt', {}, key), el('dd', {}, val));
  return dl;
}
let fieldNumber = 0;
function field(name, node) {
  const labelId = 'field-label-' + ++fieldNumber;
  node.setAttribute('aria-labelledby', labelId);
  return el('label', { class: 'field' }, el('span', { id: labelId }, name), node);
}
function input(name, max = 200) {
  return el('input', { name, required: true, maxlength: max });
}
function area(name, max = 2000) {
  return el('textarea', { name, rows: 3, maxlength: max, required: true });
}
function select(name, options) {
  return el(
    'select',
    { name, required: true },
    options.map(([val, text]) => el('option', { value: val }, text)),
  );
}
function activeEmployees() {
  return roster.filter((a) => a.desiredState !== 'fired');
}
function staffSelect(name) {
  return select(
    name,
    activeEmployees().map((a) => [a.id, a.name + ' · ' + a.role]),
  );
}
function showDialog(title, ...children) {
  byId('dialog-title').textContent = title;
  byId('dialog-content').replaceChildren(
    ...children.filter((child) => child !== null && child !== undefined),
  );
  if (!dialog.open) dialog.showModal();
}
function form(title, fields, submitLabel, handle) {
  const failure = el('div', { class: 'error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'primary' }, submitLabel);
  const node = el(
    'form',
    {},
    ...fields,
    failure,
    el(
      'div',
      { class: 'form-actions' },
      btn('Cancel', () => dialog.close()),
      submit,
    ),
  );
  node.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    failure.hidden = true;
    try {
      await handle(new FormData(node));
    } catch (error) {
      failure.hidden = false;
      failure.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  showDialog(title, node);
}
function setMenu(open) {
  byId('sidebar').classList.toggle('open', open);
  byId('menu').setAttribute('aria-expanded', String(open));
}
byId('menu').addEventListener('click', () => setMenu(!byId('sidebar').classList.contains('open')));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setMenu(false);
});
byId('sidebar').addEventListener('click', (event) => {
  if (event.target.closest('a')) setMenu(false);
});
byId('dialog-close').addEventListener('click', () => dialog.close());
function pageName() {
  const hash = location.hash.slice(1).split('?')[0];
  return Object.hasOwn(sections, hash) ? hash : location.pathname === '/chat' ? 'chat' : 'dashboard';
}
function navigate(target) {
  if (page !== target) location.hash = target;
  else return render();
}
async function render() {
  const token = ++revision;
  clearTimeout(refreshTimer);
  page = pageName();
  chat = null;
  if (dialog.open) dialog.close();
  notify();
  setMenu(false);
  byId('page-title').textContent = sections[page];
  document.title = sections[page] + ' · Perottino & Co.';
  for (const key of Object.keys(sections)) {
    if (key === page) byId('nav-' + key).setAttribute('aria-current', 'page');
    else byId('nav-' + key).removeAttribute('aria-current');
  }
  content.setAttribute('aria-busy', 'true');
  content.replaceChildren(empty('Loading…'));
  actions.replaceChildren();
  try {
    const overview = await api(page === 'dashboard' ? 'company.overview' : 'directory');
    if (token !== revision) return;
    roster = overview.agents || [];
    if (!['chat', 'admin'].includes(page)) actions.append(btn('Refresh', render));
    if (page === 'dashboard') dashboard(overview);
    if (page === 'goals' || page === 'tasks') await workPage(page, token);
    if (page === 'activity') await activityPage(token);
    if (page === 'directory') directoryPage();
    const extraPages = {
      files: filesPage,
      settings: settingsPage,
      projects: projectsPage,
      mail: mailPage,
      browsers: browsersPage,
    };
    if (Object.hasOwn(extraPages, page)) await extraPages[page](token);
    if (page === 'chat' || page === 'admin') await chatPage(page === 'admin', token);
  } catch (error) {
    if (token === revision) {
      content.replaceChildren(empty('The workspace could not be loaded.'), btn('Retry', render));
      notify(error.message);
    }
  } finally {
    if (token === revision) content.removeAttribute('aria-busy');
  }
}
window.addEventListener('hashchange', () => {
  byId('main-content').focus();
  void render();
});
const workOps = { goals: 'goal', tasks: 'task' };
function workRow(kind, row) {
  const task = kind === 'tasks';
  return el(
    'li',
    { class: 'row' },
    btn('', () => showWork(kind, row.id), {
      class: 'row-link',
      'aria-label': (task ? 'Task ' : 'Goal ') + (task ? row.title : row.outcome),
    }),
  );
}
function workList(kind, items, emptyText) {
  if (!items.length) return empty(emptyText);
  const rows = el('ul', { class: 'rows' });
  for (const row of items) {
    const task = kind === 'tasks',
      li = workRow(kind, row);
    li.firstElementChild.append(
      el('div', { class: 'item-line' }, el('strong', {}, task ? row.title : row.outcome), status(row.status)),
      el(
        'p',
        {},
        task
          ? nameOf(row.assigneeId)
          : nameOf(row.accountableId) +
              ' · ' +
              Number(row.taskCount || 0) +
              (row.taskCount === 1 ? ' task' : ' tasks'),
      ),
    );
    rows.append(li);
  }
  return rows;
}
// Business activity shows consequences and relevant work. Identifiers for private
// communications and provider actions appear only on the audited owner read.
function auditEventDetails(event) {
  const rows = [];
  for (const [key, title] of [
    ['policyVersion', 'Policy revision'],
    ['managerId', 'Manager'],
    ['accountableId', 'Accountable employee'],
    ['assigneeId', 'Assignee'],
    ['reviewerId', 'Reviewer'],
    ['amountKind', 'Amount type'],
    ['amountCents', 'Amount (USD)'],
    ['purpose', 'Purpose'],
    ['reasonCode', 'Reason'],
    ['projectId', 'Project ID'],
    ['goalId', 'Goal ID'],
    ['taskId', 'Task ID'],
    ['jobId', 'Job ID'],
    ['buildId', 'Build ID'],
    ['grantId', 'Hiring grant'],
    ['fundingGrantId', 'Funding grant'],
    ['proposalId', 'Proposal ID'],
    ['reservationId', 'Reservation ID'],
    ['resourceId', 'Resource ID'],
    ['threadId', 'Email thread ID'],
    ['conversationId', 'Conversation ID'],
    ['messageId', 'Message ID'],
    ['browserSessionId', 'Browser session ID'],
    ['browserProfileId', 'Browser profile ID'],
    ['traceId', 'Trace ID'],
  ]) {
    const value = event[key];
    if (value === undefined || value === null) continue;
    if (key === 'amountCents') rows.push([title, currency(value)]);
    else if (['managerId', 'accountableId', 'assigneeId', 'reviewerId'].includes(key))
      rows.push([title, nameOf(value)]);
    else if (['amountKind', 'reasonCode', 'purpose'].includes(key)) rows.push([title, label(value)]);
    else rows.push([title, el('code', {}, String(value))]);
  }
  if (rows.length)
    return el('details', { class: 'event-trace' }, el('summary', {}, 'Audit details'), facts(rows));
}

function eventList(events, audited = false) {
  if (!events.length) return empty('Company activity will appear here.');
  return el(
    'ol',
    { class: 'rows' },
    events.map((event) => {
      const who = event.actor ? nameOf(event.actor) : '';
      const people = [who, event.employeeId && nameOf(event.employeeId)].filter(Boolean).join(' → ');
      const details = [people, date(event.at || event.createdAt), event.status && label(event.status)]
        .filter(Boolean)
        .join(' · ');
      const related = el('div', { class: 'actions' });
      if (event.taskId)
        related.append(btn('Open task', () => showWork('tasks', event.taskId), { class: 'link' }));
      if (event.goalId)
        related.append(btn('Open goal', () => showWork('goals', event.goalId), { class: 'link' }));
      return el(
        'li',
        { class: 'row event' },
        el('span', { class: 'event-mark', 'aria-hidden': 'true' }),
        el(
          'div',
          {},
          el('strong', {}, label(event.kind)),
          el('small', {}, details),
          related.childElementCount ? related : null,
          audited
            ? auditEventDetails(event)
            : event.traceId
              ? el(
                  'details',
                  { class: 'event-trace' },
                  el('summary', {}, 'Trace ID'),
                  el('code', {}, event.traceId),
                )
              : null,
        ),
      );
    }),
  );
}
function dashboard(data) {
  const goals = data.goals || [],
    tasks = data.tasks || [],
    attention = tasks.filter((t) => ['blocked', 'submitted', 'waiting'].includes(t.status));
  actions.append(btn('Create goal', goalForm, { class: 'primary' }));
  const stats = el('div', { class: 'stats' });
  for (const [text, number, href] of [
    ['Active goals', goals.filter((g) => g.status === 'active').length, 'goals'],
    ['Open tasks', tasks.filter((t) => t.status !== 'done').length, 'tasks'],
    ['Employees', roster.filter((a) => a.desiredState !== 'fired').length, 'directory'],
  ]) {
    stats.append(
      el(
        'a',
        { class: 'stat', href: '#' + href },
        el('span', {}, text),
        el('strong', {}, String(number) + (data.more?.[href] ? '+' : '')),
      ),
    );
  }
  content.replaceChildren(
    stats,
    el(
      'div',
      { class: 'dashboard-grid' },
      el(
        'div',
        { class: 'stack' },
        panel(
          'Needs attention',
          workList(
            'tasks',
            attention.slice(0, 5),
            data.more?.tasks
              ? 'No tasks in this snapshot need attention. Open Tasks for the full list.'
              : 'No tasks need review or intervention.',
          ),
          link('tasks', 'View tasks'),
        ),
        panel(
          'Active goals',
          workList(
            'goals',
            goals.filter((g) => g.status === 'active').slice(0, 5),
            'Create a goal to set an outcome and name the employee accountable for it.',
          ),
          link('goals', 'View goals'),
        ),
      ),
      panel('Recent activity', eventList((data.events || []).slice(0, 8)), link('activity', 'View activity')),
    ),
  );
}
async function workPage(kind, token) {
  const states =
    kind === 'tasks' ? ['ready', 'running', 'waiting', 'blocked', 'submitted', 'done'] : ['active', 'done'];
  const pick = select('status', [['', 'All statuses'], ...states.map((s) => [s, label(s)])]);
  const rows = el('div');
  const more = btn('Load more', load);
  const records = [];
  let after,
    loading = false;
  function draw() {
    rows.replaceChildren(
      workList(
        kind,
        records.filter((r) => !pick.value || r.status === pick.value),
        'No ' + kind + ' match this view.',
      ),
    );
  }
  pick.addEventListener('change', draw);
  async function load() {
    if (loading) return;
    loading = true;
    more.disabled = true;
    try {
      const res = await api(workOps[kind] + '.list', { limit: 50, ...(after ? { after } : {}) });
      if (token !== revision) return;
      records.push(...res[kind]);
      after = res.next;
      more.hidden = !after;
      draw();
    } finally {
      loading = false;
      more.disabled = false;
    }
  }
  actions.append(
    btn(kind === 'goals' ? 'Create goal' : 'Create task', kind === 'goals' ? goalForm : () => taskForm(), {
      class: 'primary',
    }),
  );
  content.replaceChildren(
    el('div', { class: 'tools' }, el('label', {}, 'Status', pick)),
    el('section', { class: 'panel' }, rows, el('div', { class: 'page-more' }, more)),
  );
  await load();
}
async function activityPage(token) {
  const rows = el('div'),
    events = [];
  let after;
  const more = btn('Load more activity', load);
  async function load() {
    more.disabled = true;
    try {
      const data = await api('activity.list', { limit: 40, ...(after ? { after } : {}) });
      if (token !== revision) return;
      events.push(...data.events);
      after = data.next;
      more.hidden = !after;
      rows.replaceChildren(eventList(events));
    } finally {
      more.disabled = false;
    }
  }
  content.replaceChildren(panel('Company events', rows), el('div', { class: 'page-more' }, more));
  await load();
}
function goalForm() {
  form(
    'Create goal',
    [
      field('Outcome', area('outcome')),
      field('Success criteria', area('successCriteria')),
      field('Accountable employee', staffSelect('accountableId')),
    ],
    'Create goal',
    async (data) => {
      await change('goal.create', Object.fromEntries(data));
      await render();
    },
  );
}
async function collect(op, key, input = {}) {
  const all = [];
  let after;
  do {
    const result = await api(op, { ...input, limit: 100, ...(after ? { after } : {}) });
    all.push(...result[key]);
    after = result.next;
  } while (after);
  return all;
}
async function taskForm(goalId) {
  const goals = (await collect('goal.list', 'goals')).filter((g) => g.status === 'active');
  if (!goals.length) {
    showDialog(
      'Create task',
      empty('Create an active goal before assigning a task.'),
      btn('Create goal', goalForm),
    );
    return;
  }
  const goalPick = select(
    'goalId',
    goals.map((g) => [g.id, g.outcome]),
  );
  if (goalId) goalPick.value = goalId;
  const deps = el('div');
  let latest = 0;
  async function dependencies() {
    const token = ++latest;
    deps.replaceChildren();
    const tasks = await collect('task.list', 'tasks', { goalId: goalPick.value });
    if (token !== latest || !tasks.length) return;
    deps.append(
      checks(
        'Dependencies (optional)',
        'dependency',
        tasks.map((t) => [t.id, t.title]),
      ),
    );
  }
  goalPick.addEventListener('change', () => run(dependencies));
  form(
    'Create task',
    [
      field('Goal', goalPick),
      field('Title', input('title', 320)),
      field('Acceptance criteria', area('acceptance')),
      field('Assignee', staffSelect('assigneeId')),
      deps,
    ],
    'Create task',
    async (data) => {
      const payload = {
        goalId: data.get('goalId'),
        title: data.get('title'),
        acceptance: data.get('acceptance'),
        assigneeId: data.get('assigneeId'),
        dependencies: data.getAll('dependency'),
      };
      await change('task.create', payload);
      await render();
    },
  );
  await dependencies();
}
function checks(title, name, options) {
  return el(
    'fieldset',
    { class: 'checks' },
    el('legend', {}, title),
    options.map(([value, text]) => el('label', {}, el('input', { type: 'checkbox', name, value }), text)),
  );
}
function evidence(values) {
  const list = el('ul', { class: 'evidence' });
  for (const value of values || []) {
    let node = value;
    try {
      const url = new URL(value);
      if (url.protocol === 's3:' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(url.hostname)) {
        const object = new URL('https://s3.console.aws.amazon.com/s3/object/' + url.hostname);
        object.searchParams.set('prefix', decodeURIComponent(url.pathname.slice(1)));
        node = el('a', { href: object.href, rel: 'noopener noreferrer', target: '_blank' }, value);
      } else if (['http:', 'https:'].includes(url.protocol))
        node = el('a', { href: url.href, rel: 'noopener noreferrer', target: '_blank' }, value);
    } catch {}
    list.append(el('li', {}, node));
  }
  return list;
}
async function showWork(kind, id) {
  const goal = kind === 'goals',
    key = workOps[kind],
    prop = goal ? 'goalId' : 'taskId',
    cur = revision;
  const res = await api(key + '.get', { [prop]: id });
  if (cur !== revision) return;
  const row = res[key],
    controls = el('div', { class: 'actions' });
  if (goal) {
    const tasks = await collect('task.list', 'tasks', { goalId: id });
    if (cur !== revision) return;
    if (row.status === 'active') {
      controls.append(btn('Create task', () => taskForm(id), { class: 'primary' }));
      if (row.taskCount > 0 && row.openTaskCount === 0)
        controls.append(
          btn('Close goal', async () => {
            await change('goal.close', { goalId: id });
            await render();
          }),
        );
    }
    showDialog(
      'Goal details',
      el('h3', {}, row.outcome),
      facts([
        ['Status', status(row.status)],
        ['Accountable', nameOf(row.accountableId)],
        ['Success criteria', row.successCriteria],
      ]),
      el('h3', {}, 'Tasks'),
      workList('tasks', tasks, 'No tasks assigned.'),
      controls,
    );
  } else {
    if (row.status === 'submitted') {
      controls.append(btn('Review submission', () => reviewForm(row), { class: 'primary' }));
    } else if (['blocked', 'waiting'].includes(row.status)) {
      controls.append(
        btn('Resume task', async () => {
          await change('task.resume', { taskId: id });
          await render();
        }),
      );
    }
    const goalRecord = (await api('goal.get', { goalId: row.goalId })).goal;
    if (cur !== revision) return;
    const depRows = await Promise.all(
      (row.dependencies || []).map(async (dep) => (await api('task.get', { taskId: dep })).task),
    );
    if (cur !== revision) return;
    showDialog(
      'Task details',
      el('h3', {}, row.title),
      facts([
        ['Status', status(row.status)],
        ['Goal', btn(goalRecord.outcome, () => showWork('goals', row.goalId), { class: 'link' })],
        ['Assignee', nameOf(row.assigneeId)],
        ['Reviewer', nameOf(row.reviewerId)],
        ['Acceptance criteria', row.acceptance],
        ['Dependencies', depRows.length ? depRows.map((d) => d.title).join(', ') : null],
        ['Attempt', row.attempt],
        ['Progress', row.progress],
        [
          'Review',
          row.review ? [label(row.review.decision), row.review.note].filter(Boolean).join(' · ') : null,
        ],
      ]),
      ...(row.evidence?.length ? [el('h3', {}, 'Evidence'), evidence(row.evidence)] : []),
      controls,
      btn('Task history', () => taskHistory(row), { class: 'link' }),
    );
  }
}
async function taskHistory(task) {
  const list = el('ol', { class: 'rows' });
  let after;
  const more = btn('More history', load);
  async function load() {
    more.disabled = true;
    try {
      const res = await api('task.history', { taskId: task.id, limit: 40, ...(after ? { after } : {}) });
      for (const entry of res.entries)
        list.append(
          el(
            'li',
            { class: 'row' },
            el('strong', {}, label(entry.kind || entry.status)),
            el('p', {}, nameOf(entry.actor) + ' · ' + date(entry.at)),
            entry.note ? el('p', {}, entry.note) : null,
            entry.evidence?.length ? evidence(entry.evidence) : null,
          ),
        );
      after = res.next;
      more.hidden = !after;
    } finally {
      more.disabled = false;
    }
  }
  showDialog('Task history', el('h3', {}, task.title), list, more);
  await load();
}
function reviewForm(task) {
  form(
    'Review submission',
    [
      el('p', {}, task.title),
      evidence(task.evidence),
      field(
        'Decision',
        select('decision', [
          ['accept', 'Accept work'],
          ['changes', 'Request changes'],
        ]),
      ),
      field('Review note', area('note')),
    ],
    'Save review',
    async (data) => {
      await change('task.review', { taskId: task.id, ...Object.fromEntries(data) });
      await render();
    },
  );
}
function directoryPage() {
  const filter = el('input', {
    type: 'search',
    class: 'search',
    id: 'directory-search',
    'aria-label': 'Find employees',
    placeholder: 'Find by name, role or @handle',
  });
  const grid = el('div', { class: 'people-grid' });
  const draw = () => {
    const query = filter.value.trim().toLowerCase().replace(/^@/, '');
    const employees = roster.filter((a) =>
      [a.name, a.handle, a.role].some((s) => s?.toLowerCase().includes(query)),
    );
    grid.replaceChildren(
      ...employees.map((a) => {
        const controls = el(
          'div',
          { class: 'actions' },
          btn('Profile', () => profile(a)),
        );
        if (a.desiredState !== 'fired')
          controls.prepend(btn('Message', () => openDM(a.id), { 'aria-label': 'Message ' + a.name }));
        return el(
          'article',
          { class: 'panel panel-pad' },
          el(
            'div',
            { class: 'person' },
            el('span', { class: 'avatar', 'aria-hidden': 'true' }, (a.name || '?').slice(0, 1)),
            el(
              'div',
              {},
              el('h2', {}, a.name),
              el('small', {}, [a.role, a.handle].filter(Boolean).join(' · ')),
            ),
          ),
          controls,
        );
      }),
    );
    if (!employees.length) grid.append(empty('No employees found.'));
  };
  filter.addEventListener('input', draw);
  actions.append(
    btn('Hire employee', () =>
      form('Hire employee', [field('Role', input('role', 160))], 'Hire employee', async (data) => {
        await change('employee.hire', { role: data.get('role') });
        await render();
      }),
    ),
  );
  content.replaceChildren(el('div', { class: 'tools' }, filter), grid);
  draw();
}
function profile(a) {
  const controls = el('div', { class: 'actions' });
  if (a.desiredState !== 'fired') {
    const operation = a.desiredState === 'paused' ? 'resume' : 'pause';
    controls.append(
      btn(label(operation) + ' employee', async () => {
        await change('employee.' + operation, { agentId: a.id });
        await render();
      }),
    );
    if (a.id !== 'ceo')
      controls.append(
        btn(
          'Fire employee',
          () =>
            form(
              'Fire employee',
              [
                el(
                  'p',
                  {},
                  'End employment for ' + a.name + '? This employee will lose access to company work.',
                ),
              ],
              'Confirm firing',
              async () => {
                await change('employee.fire', { agentId: a.id });
                await render();
              },
            ),
          { class: 'danger' },
        ),
      );
  }
  controls.append(
    btn('SOUL.md', () => showSoul(a.id)),
    btn('Employee memory', () => knowledgeDialog(a.id)),
    btn('Effective settings', () => effectiveSettingsDialog(a.id)),
    btn('Authority and budget', () => employeeAuthority(a.id)),
  );
  showDialog(
    a.name,
    facts([
      ['Role', a.role],
      ['Handle', a.handle],
      ['Manager', nameOf(a.managerId || 'owner')],
      ['Employment', label(a.desiredState || 'active')],
      ['Runtime', a.runtimeStatus],
      ['Last pulse', a.lastPulseAt ? date(a.lastPulseAt) : null],
    ]),
    controls,
  );
}
let pendingConversation;
async function openDM(peerId) {
  const { conversation } = await api('conversations.dm', { peerId });
  pendingConversation = conversation;
  await navigate('chat');
}
function groupForm(title = '') {
  const options = activeEmployees().map((a) => [a.id, a.name + ' · ' + a.role]);
  form(
    'New group',
    [field('Group name', textControl('title', title, { max: 160 })), checks('Members', 'members', options)],
    'Create group',
    async (data) => {
      const members = data.getAll('members');
      if (!members.length) throw new Error('Choose at least one employee.');
      const result = await change('conversations.group', { title: data.get('title'), members });
      pendingConversation = result.conversation;
      await navigate('chat');
    },
  );
}
function convoTitle(c, admin) {
  if (c.type === 'group') return c.title;
  const members = admin && !c.members.includes('owner') ? c.members : c.members.filter((m) => m !== 'owner');
  return members.map(nameOf).join(' & ');
}
function threadRow(state, c) {
  const active = state.id === c.id;
  return btn('', () => selectThread(state, c), {
    class: 'thread',
    'data-conversation-id': c.id,
    'aria-label': convoTitle(c, state.admin),
    'aria-current': active ? 'true' : undefined,
  });
}
function drawThreads(state) {
  state.list.replaceChildren(
    ...state.threads.map((c) => {
      const b = threadRow(state, c);
      b.append(
        el('strong', {}, convoTitle(c, state.admin)),
        el('small', {}, c.type === 'group' ? 'Group · ' + c.members.length + ' members' : 'Direct message'),
      );
      return b;
    }),
  );
  if (!state.threads.length)
    state.list.append(
      empty(state.admin ? 'No conversations to inspect.' : 'Your direct messages and groups appear here.'),
    );
  if (state.cursor)
    state.list.append(btn('Load more conversations', () => loadThreads(state, true), { class: 'link' }));
}
async function loadThreads(state, more = false) {
  if (state !== chat) return;
  const out = await api(state.admin ? 'admin.conversations' : 'conversations.list', {
    limit: 50,
    ...(more && state.cursor ? { after: state.cursor } : {}),
  });
  if (state !== chat) return;
  const incoming = (out.conversations || []).filter((c) => state.admin || c.members.includes('owner'));
  const entries = new Map((more ? state.threads : []).map((c) => [c.id, c]));
  for (const c of incoming) entries.set(c.id, c);
  state.threads = [...entries.values()];
  state.cursor = out.next;
  state.lastDirectoryCheck = Date.now();
  drawThreads(state);
}
async function chatPage(admin, token) {
  const list = el('div', { id: 'conversation-list' }),
    detail = el('section', {
      class: 'panel conversation',
      'aria-label': admin ? 'Inspected conversation' : 'Selected conversation',
    });
  const state = { admin, threads: [], list, detail, selection: 0 };
  chat = state;
  if (admin) actions.append(btn('Audit log', auditLog));
  if (!admin)
    actions.append(
      btn('New DM', () => navigate('directory')),
      btn('New group', groupForm, { class: 'primary' }),
    );
  const intro = admin
    ? el(
        'p',
        { class: 'information' },
        'Read-only conversation inspector. Opening the index, a conversation, or another page of messages records an administrative access event.',
      )
    : null;
  content.replaceChildren(
    ...(intro ? [intro] : []),
    el(
      'div',
      { class: 'chat-layout' },
      panel(admin ? 'All conversations' : 'Your conversations', list),
      detail,
    ),
  );
  detail.append(
    empty(
      admin
        ? 'Select a conversation to inspect its messages.'
        : 'Choose a conversation or start a DM from Directory.',
    ),
  );
  await loadThreads(state);
  if (token !== revision) return;
  // An explicit selection is required before any administrative transcript read.
  if (!admin) {
    const target = pendingConversation || state.threads[0];
    pendingConversation = null;
    if (target?.members.includes('owner')) {
      if (!state.threads.some((c) => c.id === target.id)) state.threads.unshift(target);
      await selectThread(state, target);
    } else scheduleRefresh(state, 15000);
  }
}
async function auditLog() {
  const rows = el('div');
  const events = [];
  let after;
  const more = btn('Load more events', load);
  async function load() {
    more.disabled = true;
    try {
      const result = await api('admin.activity', { limit: 40, ...(after ? { after } : {}) });
      events.push(...result.events);
      after = result.next;
      more.hidden = !after;
      rows.replaceChildren(eventList(events, true));
    } finally {
      more.disabled = false;
    }
  }
  showDialog(
    'Audit log',
    el('p', { class: 'section-note' }, 'Company-wide event metadata. Each read is audited.'),
    rows,
    more,
  );
  await load();
}
async function deliveryStatus(message) {
  const result = await api('messages.status', {
    conversationId: message.conversationId,
    messageId: message.id,
  });
  showDialog(
    'Reply delivery',
    el(
      'ul',
      { class: 'rows' },
      result.deliveries.map((delivery) =>
        el(
          'li',
          { class: 'row' },
          el('strong', {}, nameOf(delivery.recipientId)),
          el(
            'p',
            {},
            label(delivery.status) +
              ' · ' +
              delivery.attempts +
              ' attempt' +
              (delivery.attempts === 1 ? '' : 's'),
          ),
        ),
      ),
    ),
    btn('Refresh', () => deliveryStatus(message)),
  );
}
function transcriptMessage(msg, showDelivery = false) {
  const own = msg.senderId === 'owner';
  return el(
    'article',
    { class: 'message ' + (own ? 'own' : 'employee'), 'data-message-id': msg.id },
    el(
      'header',
      {},
      nameOf(msg.senderId),
      ' · ',
      el('time', { datetime: msg.createdAt }, date(msg.createdAt)),
    ),
    el('p', { class: 'bubble' }, protectedMessageText(msg.text)),
    showDelivery && own && msg.responders?.length
      ? btn('Delivery', () => deliveryStatus(msg), { class: 'link delivery' })
      : null,
  );
}
function renderMessages(state, keepScroll = false) {
  const transcript = state.timeline;
  if (!transcript) return;
  const bottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 50;
  const first = transcript.firstElementChild,
    offset = first?.getBoundingClientRect().top;
  const prevId = first?.dataset.messageId;
  const rows = [...state.messages.values()].sort((a, b) => a.seq - b.seq);
  transcript.replaceChildren(
    ...(rows.length ? rows.map((msg) => transcriptMessage(msg, !state.admin)) : [empty('No messages yet.')]),
  );
  if (keepScroll && prevId) {
    const next = [...transcript.children].find((n) => n.dataset.messageId === prevId);
    if (next) transcript.scrollTop += next.getBoundingClientRect().top - offset;
  } else if (bottom || state.scrollAfterSend) transcript.scrollTop = transcript.scrollHeight;
  state.scrollAfterSend = false;
}
async function readMessages(state, older = false) {
  const selection = state.selection;
  const payload = { conversationId: state.id, ...(older ? { beforeSeq: state.before } : { latest: true }) };
  const data = await api(state.admin ? 'admin.messages' : 'messages.list', payload);
  if (chat !== state || state.selection !== selection) return;
  const beforeCount = state.messages.size;
  const oldMin = beforeCount ? Math.min(...[...state.messages.values()].map((m) => m.seq)) : Infinity;
  for (const m of data.messages) state.messages.set(m.id, m);
  if (older || !beforeCount || !data.messages.length || data.messages[0].seq <= oldMin)
    state.before = data.previousBeforeSeq;
  // A long absence can leave a gap between the cached transcript and the latest window.
  let reset = false;
  if (!older && data.messages.length && beforeCount) {
    const first = data.messages[0].seq,
      min = Math.min(first, oldMin);
    if (first > min && ![...state.messages.values()].some((m) => m.seq === first - 1)) {
      reset = true;
      state.messages = new Map(data.messages.map((m) => [m.id, m]));
      state.before = data.previousBeforeSeq;
    }
  }
  state.earlier.hidden = !state.before;
  if (older || reset || state.messages.size !== beforeCount || !beforeCount || state.scrollAfterSend)
    renderMessages(state, older);
}
function scheduleRefresh(state, ms = 10000) {
  clearTimeout(refreshTimer);
  if (state.admin || chat !== state) return;
  refreshTimer = setTimeout(async () => {
    if (chat !== state) return;
    try {
      if (!document.hidden && !dialog.open) {
        if (!state.lastDirectoryCheck || Date.now() - state.lastDirectoryCheck > 60000) {
          // Refresh the first page without discarding conversation pages the owner already loaded.
          const result = await api('conversations.list', { limit: 50 });
          if (chat !== state) return;
          const existing = new Set(state.threads.map((c) => c.id));
          const added = result.conversations.filter(
            (c) => c.members.includes('owner') && !existing.has(c.id),
          );
          if (added.length) {
            state.threads.unshift(...added);
            if (!state.cursor) state.cursor = result.next;
            drawThreads(state);
          }
          state.lastDirectoryCheck = Date.now();
        }
        if (state.id) await readMessages(state);
      }
    } catch (error) {
      if (chat === state) notify(error.message);
    } finally {
      if (chat === state) scheduleRefresh(state, Date.now() < (state.fastUntil || 0) ? 1600 : 30000);
    }
  }, ms);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && chat && !chat.admin) scheduleRefresh(chat, 100);
});
async function selectThread(state, c) {
  if (chat !== state || (!state.admin && !c.members.includes('owner'))) return;
  const selection = ++state.selection;
  clearTimeout(refreshTimer);
  state.id = c.id;
  state.messages = new Map();
  state.before = null;
  drawThreads(state);
  const earlier = btn(
    'Load earlier messages',
    async () => {
      earlier.disabled = true;
      try {
        await readMessages(state, true);
      } finally {
        earlier.disabled = false;
      }
    },
    { class: 'link', hidden: true },
  );
  const timeline = el('div', { id: 'timeline', class: 'transcript', tabindex: 0, 'aria-label': 'Messages' });
  state.earlier = earlier;
  state.timeline = timeline;
  const peer = c.members.find((id) => id !== 'owner');
  const head = el(
    'div',
    { class: 'section-head' },
    el(
      'div',
      {},
      el('h2', {}, convoTitle(c, state.admin)),
      el('small', {}, c.members.map(nameOf).join(' · ')),
    ),
    !state.admin && c.type === 'dm' ? btn('Memory', () => showMemory(c, peer), { id: 'memoryButton' }) : null,
  );
  const foot = el('div', { class: 'chat-tools' }, earlier);
  state.detail.replaceChildren(head, foot, timeline);
  if (!state.admin) {
    const archived = c.type === 'dm' && c.members.some((id) => person(id)?.desiredState === 'fired');
    if (archived) state.detail.append(empty('This conversation is archived.'));
    else state.detail.append(composer(state, c));
  }
  await readMessages(state);
  if (chat === state && selection === state.selection && !state.admin) scheduleRefresh(state);
}
function composer(state, c) {
  const form = byId('compose-template').content.firstElementChild.cloneNode(true);
  const text = form.querySelector('textarea'),
    send = form.querySelector('#send');
  const current = drafts.get(c.id) || { text: '', responders: [] };
  text.value = current.text;
  form.querySelector('.composer-foot').before(fileLinkPicker(text));
  if (c.type === 'group') {
    const options = c.members
      .filter((id) => id !== 'owner' && person(id)?.desiredState !== 'fired')
      .map((id) => [id, nameOf(id)]);
    form.querySelector('#responders').append(checks('Request a reply from', 'responders', options));
    for (const check of form.querySelectorAll('[name=responders]'))
      check.checked = current.responders.includes(check.value);
  }
  const responders = () => [...form.querySelectorAll('[name=responders]:checked')].map((b) => b.value);
  const cache = () => {
    drafts.set(c.id, { text: text.value, responders: responders() });
    send.disabled = !text.value.trim();
  };
  cache();
  form.addEventListener('input', cache);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (send.disabled || !text.value.trim()) return;
    const message = text.value.trim(),
      selection = state.selection;
    send.disabled = true;
    text.readOnly = true;
    try {
      await change('messages.post', {
        conversationId: c.id,
        text: message,
        ...(c.type === 'group' ? { responders: responders() } : {}),
      });
      drafts.delete(c.id);
      text.value = '';
      state.scrollAfterSend = true;
      if (chat === state && state.selection === selection) {
        state.fastUntil = Date.now() + 60000;
        await readMessages(state);
        scheduleRefresh(state, 500);
        text.focus();
      }
    } catch (error) {
      notify(error.message);
    } finally {
      text.readOnly = false;
      send.disabled = !text.value.trim();
    }
  });
  return form;
}
async function showMemory(conversation, employeeId) {
  let after;
  const list = el('ul', { class: 'rows' }),
    more = btn('More notes', load);
  async function load() {
    more.disabled = true;
    try {
      const result = await api('memory.list', {
        conversationId: conversation.id,
        employeeId,
        limit: 30,
        ...(after ? { after } : {}),
      });
      for (const item of result.memories) {
        const source = btn(
          'Source message',
          async () => {
            const { message } = await api('messages.get', {
              conversationId: conversation.id,
              messageId: item.sourceMessageId,
            });
            showDialog(
              'Source message',
              transcriptMessage(message),
              btn('Back to memory', () => showMemory(conversation, employeeId), { class: 'link' }),
            );
          },
          { class: 'link' },
        );
        list.append(el('li', { class: 'row' }, el('p', {}, item.text), source));
      }
      if (!list.childElementCount)
        list.append(el('li', { class: 'empty' }, 'No notes saved in this conversation.'));
      after = result.next;
      more.hidden = !after;
    } finally {
      more.disabled = false;
    }
  }
  showDialog(
    'Conversation memory',
    el('p', { class: 'section-note' }, nameOf(employeeId) + '’s notes from this direct message.'),
    list,
    more,
  );
  await load();
}
void render();
