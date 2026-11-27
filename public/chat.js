'use strict';

const get = id => document.getElementById(id);
const picker = get('picker');
const historyPane = get('history');
const input = get('messageText');
const narrow = matchMedia('(max-width: 700px)');
const overlayMemory = matchMedia('(max-width: 1050px)');
const timeLabel = new Intl.DateTimeFormat(undefined, {hour:'numeric', minute:'2-digit'});
const dayLabel = new Intl.DateTimeFormat(undefined, {month:'long', day:'numeric', year:'numeric'});
const state = {
  agents: [], agent: null, recent: [], messages: [], memories: [], status: 'idle',
  drafts: new Map(), requests: new Map(), sending: new Set(), sendErrors: new Map(),
  loaded: false, directoryLoaded: false, readError: '', memoryError: '', pollVersion: 0
};
let directoryRequest = null;
let pollTimer;
let directoryCheckedAt = 0;
let lastFocus = null;
let noteAction = null;
let sourceRequest = 0;
const employment = new Map();
const employeeRequests = new Map();
let profileRead = 0;
let actionPending = false;
const pages = {
  messages:{button:get('earlierMessages'),label:'Load earlier messages',items:'messages'},
  memory:{button:get('moreNotes'),label:'More notes',items:'memories'}
};
function resetPages() {
  for (const page of Object.values(pages)) {
    page.cursor = null;
    page.expanded = false;
    page.button.hidden = true;
    page.button.disabled = false;
    page.button.textContent = page.label;
  }
}
function uniqueRows(rows) {
  return Array.from(new Map(rows.map(row => [row.id,row])).values());
}
function applyLatest(kind, data) {
  const page = pages[kind];
  const previous = state[page.items];
  const head = data[page.items];
  let rows = head;
  if (page.expanded && data.nextCursor && head.length) {
    const boundary = kind === 'messages' ? head[0] : head.at(-1);
    const at = previous.findIndex(row => row.id === boundary.id);
    if (at >= 0) rows = kind === 'messages' ? [...previous.slice(0,at),...head] : [...head,...previous.slice(at+1)];
    else page.expanded = false;
  } else page.expanded = false;
  if (!page.expanded) page.cursor = data.nextCursor;
  page.button.hidden = !page.cursor;
  state[page.items] = rows;
  return JSON.stringify(previous) !== JSON.stringify(rows);
}
async function loadEarlier(kind) {
  const page = pages[kind];
  const agent = state.agent;
  const cursor = page.cursor;
  if (!agent || !cursor || page.button.disabled) return;
  page.button.disabled = true;
  try {
    const response = await api(url(agent.id,kind) + '?cursor=' + encodeURIComponent(cursor));
    const data = await response.json();
    if (state.agent?.id !== agent.id || page.cursor !== cursor) return;
    const older = data[page.items];
    const previous = state[page.items];
    state[page.items] = uniqueRows(kind === 'messages' ? [...older,...previous] : [...previous,...older]);
    page.expanded = true;
    page.cursor = data.nextCursor;
    page.button.hidden = !page.cursor;
    page.button.textContent = page.label;
    if (kind === 'messages') {
      renderTimeline(false);
      historyPane.scrollTop = 0;
    } else renderMemory();
  } catch {
    if (state.agent?.id === agent.id) page.button.textContent = 'Retry loading ' + (kind === 'messages' ? 'messages' : 'notes');
  } finally { page.button.disabled = false; }
}
async function openSource(messageId) {
  const source = get('message-' + messageId);
  if (source) {
    if (overlayMemory.matches) toggleMemory(false);
    source.focus({preventScroll:true});
    source.scrollIntoView({block:'center'});
    return;
  }
  const version = ++sourceRequest;
  get('sourceMeta').textContent = '';
  get('sourceBody').textContent = 'Loading source message…';
  get('sourceDialog').showModal();
  try {
    const response = await api(url(state.agent.id,'messages/' + encodeURIComponent(messageId)));
    const {message} = await response.json();
    if (version !== sourceRequest) return;
    const stamp = new Date(message.createdAt);
    const date = Number.isNaN(stamp.getTime()) ? '' : dayLabel.format(stamp);
    get('sourceMeta').textContent = [messageAuthor(message),date].filter(Boolean).join(' · ');
    get('sourceBody').textContent = message.text;
  } catch {
    if (version === sourceRequest) get('sourceBody').textContent = 'The source message is unavailable.';
  }
}

function element(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = content;
  return result;
}
function messageAuthor(message) {
  if (message.author === 'owner') return 'You';
  if (message.author === 'employee') return state.agents.find(person => person.id === message.senderAgentId)?.name || 'Coworker';
  if (message.author === 'external') return message.email?.from ? 'Email from ' + message.email.from : 'External email';
  return state.agent.name;
}
function showEmployeeState(profile) {
  employment.set(profile.id, profile.desiredState);
  if (state.agent?.id !== profile.id) return;
  input.disabled = profile.desiredState === 'fired';
  updateComposer();
  renderStatus();
}
function renderEmployee({employee, goals}) {
  showEmployeeState(employee);
  const manager = state.agents.find(person => person.id === employee.managerId);
  const fields = [['Employment', employee.desiredState], ['Runtime', employee.runtimeStatus],
    ['Reports to', manager?.name || employee.managerId || 'Owner'], ['Can hire', employee.canHire ? 'Yes' : 'No']];
  get('employeeFacts').replaceChildren(...fields.flatMap(([key,value]) => [element('dt','',key), element('dd','',value)]));
  const archived = employee.desiredState === 'fired';
  get('toggleEmployment').hidden = archived;
  get('toggleEmployment').textContent = employee.desiredState === 'paused' ? 'Resume employee' : 'Pause employee';
  get('fireEmployee').hidden = archived;
  get('goalForm').hidden = archived;
  const rows = goals.map(goal => {
    const article = element('article','goal-summary');
    article.append(element('strong','',goal.text), element('p','muted',goal.status + ' · ' + goal.stepCount + (goal.stepCount === 1 ? ' step' : ' steps')));
    if (goal.checkpoint) {
      let progress = goal.checkpoint;
      try {
        const checkpoint = JSON.parse(progress);
        if (Array.isArray(checkpoint?.progress)) progress = checkpoint.progress.filter(item => typeof item === 'string').join('\n');
      } catch { /* Local checkpoints contain human-readable progress. */ }
      if (progress) article.append(element('p','',progress));
    }
    if (goal.status === 'waiting' && goal.nextRunAt) {
      const next = new Date(goal.nextRunAt);
      if (Number.isFinite(next.getTime())) article.append(element('p','muted','Next check ' + next.toLocaleString()));
    }
    return article;
  });
  get('employeeGoals').replaceChildren(...(rows.length ? rows : [element('p','muted','No goals assigned.')]));
}
async function refreshEmployee() {
  const id = state.agent?.id;
  const version = ++profileRead;
  try {
    const result = await (await api(url(id,'employee'))).json();
    if (version === profileRead && id === state.agent?.id && get('employeeDialog').open) renderEmployee(result);
  } catch {
    if (version === profileRead && get('employeeDialog').open) get('employeeStatus').textContent = 'Employee details could not be loaded. Select Refresh to try again.';
  }
}
function openEmployee() {
  const agent = state.agent;
  if (!agent) return;
  get('employeeHeading').textContent = agent.name;
  get('employeeRole').textContent = fullRole(agent);
  get('goalText').value = employeeRequests.get(agent.id + '/goals')?.text || '';
  get('employeeFacts').replaceChildren();
  get('employeeGoals').replaceChildren();
  get('toggleEmployment').hidden = get('fireEmployee').hidden = get('goalForm').hidden = true;
  get('employeeStatus').textContent = '';
  get('employeeDialog').showModal();
  void refreshEmployee();
}
async function employeeAction(operation) {
  const agent = state.agent;
  if (!agent || actionPending) return;
  const goal = operation === 'goals';
  const text = goal ? get('goalText').value.trim() : '';
  if (goal && !text) return;
  if (operation === 'fire' && !window.confirm('Fire ' + agent.name + '? Their work will stop permanently. Their history will remain available.')) return;
  const resource = goal ? operation : 'lifecycle/' + operation;
  const key = agent.id + '/' + resource;
  let request = employeeRequests.get(key);
  if (!request || (goal && request.text !== text)) {
    request = {requestId:crypto.randomUUID(), ...(goal ? {text} : {})};
    employeeRequests.set(key,request);
  }
  actionPending = true;
  const controls = ['assignGoal','toggleEmployment','fireEmployee','refreshEmployee','goalText'];
  for (const id of controls) get(id).disabled = true;
  const sameEmployee = () => state.agent?.id === agent.id && get('employeeDialog').open;
  get('employeeStatus').textContent = 'Saving…';
  try {
    const response = await api(url(agent.id,resource),{method:'POST',
      headers:{'Content-Type':'application/json','X-Requested-With':'owner-console'}, body:JSON.stringify(request)});
    const result = await response.json();
    employeeRequests.delete(key);
    if (result.employee) showEmployeeState(result.employee);
    if (sameEmployee()) {
      if (goal) get('goalText').value = '';
      get('employeeStatus').textContent = goal ? 'Goal assigned.' : 'Employment updated.';
      await refreshEmployee();
    }
  } catch (error) {
    if (sameEmployee()) {
      get('employeeStatus').textContent = error.status === 409 ? 'This action conflicts with the current employee state or a previous request.' :
        'The action could not be confirmed. Retry it to check the same request.';
      if (error.status === 409) await refreshEmployee();
    }
  } finally {
    actionPending = false;
    for (const id of controls) get(id).disabled = false;
  }
}
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  const use = document.createElementNS(svg.namespaceURI,'use');
  use.setAttribute('href','#i-' + id);
  svg.setAttribute('aria-hidden','true');
  svg.append(use);
  return svg;
}
async function api(path, options = {}) {
  const r = await fetch(path, {credentials:'same-origin', cache:'no-store', ...options});
  if (!r.ok) {
    const e = new Error('Request failed');
    e.status = r.status;
    throw e;
  }
  return r;
}
function url(id, resource) {
  return '/api/agents/' + encodeURIComponent(id) + '/' + resource;
}
function handle(agent) { return '@' + String(agent.handle || agent.id).replace(/^@/, ''); }
function fullRole(agent) { return [agent.role, handle(agent)].filter(Boolean).join(' · '); }
function headerMeta(agent) {
  return [fullRole(agent), get('runtime').textContent === 'Local simulator' ? 'Local simulator' : ''].filter(Boolean).join(' · ');
}
function initials(name) {
  return String(name).trim().split(/\s+/).slice(0,2).map(part => Array.from(part)[0]).join('').toUpperCase() || '·';
}
function identifyAvatar(node, agent) {
  const tone = /^(ceo|chief executive officer)$/i.test(agent.role) ? 0 :
    Array.from(String(agent.id)).reduce((sum, c) => sum + c.codePointAt(0), 0) % 4;
  node.classList.remove('tone-0','tone-1','tone-2','tone-3');
  node.classList.add('tone-' + tone);
  node.textContent = initials(agent.name);
}
function avatar(agent) {
  const node = element('span','avatar');
  node.setAttribute('aria-hidden','true');
  identifyAvatar(node, agent);
  return node;
}
function agentRow(agent, active, select, arrow = false) {
  const button = element('button','contact-row');
  button.type = 'button';
  if (active) button.setAttribute('aria-current','page');
  const info = element('span','contact-info');
  info.append(element('strong','',agent.name), element('small','',fullRole(agent)));
  button.append(avatar(agent),info);
  if (arrow) button.append(icon('arrow'));
  button.addEventListener('click', select);
  return button;
}
function renderNav() {
  const rows = state.recent.map(id => state.agents.find(a => a.id === id)).filter(Boolean)
    .map(a => agentRow(a, state.agent?.id === a.id, () => selectAgent(a)));
  if (!rows.length && state.directoryLoaded) rows.push(element('p','no-results','No conversations yet.'));
  get('conversations').replaceChildren(...rows);
}
function renderResults() {
  const query = get('search').value.trim().toLowerCase().replace(/^@/, '');
  const matches = state.agents.filter(agent => {
    const role = String(agent.role || '').toLowerCase();
    const alias = role === 'chief executive officer' ? 'ceo' : '';
    return [agent.name, handle(agent), role, alias].some(s => String(s).toLowerCase().includes(query));
  });
  const content = matches.map(a => agentRow(a,false,() => { picker.close(); selectAgent(a, true); },true));
  if (!content.length) content.push(element('p','no-results',
    !state.directoryLoaded ? 'The employee directory is loading.' :
      query ? 'No employees match your search.' : 'The directory has no employees yet.'));
  get('results').replaceChildren(...content);
}
function showPicker(title) {
  closeNavigation();
  get('pickerTitle').textContent = title;
  get('search').value = '';
  renderResults();
  picker.showModal();
  get('search').focus();
  void loadDirectory();
}
function showNavigation() {
  lastFocus = document.activeElement;
  get('sidebar').classList.add('open');
  get('sidebarShade').hidden = false;
  get('openSidebar').setAttribute('aria-expanded','true');
  updateOverlay();
  get('closeSidebar').focus();
}
function closeNavigation() {
  if (!get('sidebar').classList.contains('open')) return;
  get('sidebar').classList.remove('open');
  get('sidebarShade').hidden = true;
  get('openSidebar').setAttribute('aria-expanded','false');
  updateOverlay();
  if (lastFocus?.isConnected) lastFocus.focus();
  lastFocus = null;
}
function toggleMemory(open) {
  get('memoryPanel').hidden = !open;
  get('memoryButton').setAttribute('aria-expanded', String(open));
  get('memoryButton').setAttribute('aria-label', open ? 'Close memory' : 'Open memory');
  updateOverlay();
  if (open) {
    get('closeMemory').focus();
    void refresh(false);
  } else get('memoryButton').focus();
}
function updateOverlay() {
  const sideOpen = narrow.matches && get('sidebar').classList.contains('open');
  const memoryOpen = !get('memoryPanel').hidden && overlayMemory.matches;
  get('memoryShade').hidden = !memoryOpen;
  document.querySelector('.chat').inert = sideOpen || memoryOpen;
  get('sidebar').inert = memoryOpen;
  get('memoryPanel').inert = sideOpen;
}
function selectAgent(agent, focus = false) {
  closeNavigation();
  const changed = state.agent?.id !== agent.id;
  if (changed) {
    state.agent = agent;
    resetPages();
    state.messages = [];
    state.memories = [];
    state.loaded = false;
    state.readError = '';
    state.memoryError = '';
    state.status = 'idle';
    state.pollVersion++;
    input.value = state.drafts.get(agent.id) || '';
    get('timeline').replaceChildren();
    get('memoryButton').disabled = false;
    get('employeeButton').disabled = false;
    get('memoryOwner').textContent = agent.name + '’s notes';
    renderMemory();
  }
  state.recent = [agent.id, ...state.recent.filter(id => id !== agent.id)];
  renderNav();
  get('contactName').textContent = agent.name;
  get('contactMeta').textContent = headerMeta(agent);
  identifyAvatar(get('headerAvatar'),agent);
  input.disabled = employment.get(agent.id) === 'fired';
  input.placeholder = 'Message ' + agent.name + '…';
  document.title = agent.name + ' · Company chat · Perottino & Co.';
  renderStatus();
  updateComposer();
  if (focus) input.focus();
  if (changed) void refresh(true);
}
function renderStatus() {
  const agent = state.agent;
  const notice = state.sendErrors.get(agent?.id) || state.readError;
  get('notice').hidden = !notice;
  get('notice').textContent = notice || '';
  const welcome = get('welcome');
  welcome.hidden = !!state.messages.length || (!state.loaded && !!agent);
  if (!welcome.hidden) {
    get('starters').hidden = !agent;
    get('welcomeAvatar').hidden = !agent;
    if (agent) identifyAvatar(get('welcomeAvatar'),agent);
    get('welcomeTitle').textContent = agent ? 'Your conversation with ' + agent.name : 'Company chat';
    get('welcomeCopy').textContent = agent ? 'Send a brief, ask a question, or share something to remember.' :
      state.directoryLoaded ? 'Your employees will appear here when they join the company.' : 'Loading your workspace…';
  }
  const activity = get('activity');
  const busy = state.status === 'queued' || state.status === 'working';
  activity.classList.toggle('busy', busy);
  activity.textContent = !agent ? '' : state.sending.has(agent.id) ? 'Sending…' :
    employment.get(agent.id) === 'fired' ? 'Employment ended. This conversation is archived.' :
    employment.get(agent.id) === 'paused' ? 'Employee paused. New work will wait until they resume.' :
    state.status === 'queued' ? 'Message queued for ' + agent.name + '.' :
    state.status === 'working' ? agent.name + ' is working…' :
    state.status === 'error' ? 'The last agent run encountered an error.' :
    !state.loaded && !state.readError ? 'Loading conversation…' : '';
}
function renderTimeline(scrollToBottom) {
  const previousEnd = historyPane.scrollHeight - historyPane.scrollTop - historyPane.clientHeight < 90;
  let previousDate = '';
  const fragment = document.createDocumentFragment();
  for (const msg of state.messages) {
    const date = new Date(msg.createdAt);
    const valid = !Number.isNaN(date.getTime());
    const day = valid ? dayLabel.format(date) : '';
    if (day && day !== previousDate) {
      fragment.append(element('div','date-line',day));
      previousDate = day;
    }
    const owner = msg.author === 'owner';
    const row = element('article','message ' + (owner ? 'owner' : 'employee'));
    row.id = 'message-' + msg.id;
    row.tabIndex = -1;
    const body = element('div','message-body');
    const meta = element('div','message-meta');
    const author = messageAuthor(msg);
    meta.append(element('strong','',author));
    if (valid) {
      const time = element('time','',timeLabel.format(date));
      time.dateTime = date.toISOString();
      meta.append(time);
    }
    body.append(meta);
    if (msg.author === 'external' && msg.email?.subject) body.append(element('p','email-subject',msg.email.subject));
    body.append(element('div','bubble',msg.text));
    if (msg.status === 'error') body.append(element('small','failed-message','Reply failed'));
    const sender = msg.author === 'agent' ? state.agent : state.agents.find(person => person.id === msg.senderAgentId);
    if (sender) row.append(avatar(sender));
    row.append(body);
    fragment.append(row);
  }
  get('timeline').replaceChildren(fragment);
  if (scrollToBottom || previousEnd) historyPane.scrollTop = historyPane.scrollHeight;
}
function renderMemory() {
  if (state.memoryError) {
    get('memories').replaceChildren(element('p','empty-note',state.memoryError));
    return;
  }
  const cards = state.memories.map(note => {
    const card = element('article','memory-note');
    card.append(element('p','',note.text));
    const stamp = new Date(note.updatedAt || note.createdAt);
    if (!Number.isNaN(stamp.getTime())) {
      const time = element('time','',(note.updatedBy === 'owner' ? 'Edited by you · ' : '') + dayLabel.format(stamp));
      time.dateTime = stamp.toISOString();
      card.append(time);
    }
    if (note.sourceMessageId) {
      const link = element('button','source','Source message');
      link.type = 'button';
      link.append(icon('arrow'));
      link.addEventListener('click', () => void openSource(note.sourceMessageId));
      card.append(link);
    }
    const controls = element('div','memory-controls');
    for (const [label, method] of [['Edit','PATCH'], ['Forget','DELETE']]) {
      const button = element('button','note-action',label);
      button.type = 'button';
      button.addEventListener('click', () => openNote(note, method));
      controls.append(button);
    }
    card.append(controls);
    return card;
  });
  get('memories').replaceChildren(...(cards.length ? cards : [element('p','empty-note', 'No saved notes yet.')]));
}
function openNote(note, method) {
  noteAction = {agentId:state.agent.id, noteId:note.id, method, request:null, saving:false};
  const edit = method === 'PATCH';
  get('noteTitle').textContent = edit ? 'Edit note' : 'Forget this note?';
  get('noteField').hidden = !edit;
  get('noteText').disabled = !edit;
  get('noteText').value = note.text;
  get('forgetPreview').hidden = edit;
  get('forgetText').textContent = note.text;
  get('saveNote').textContent = edit ? 'Save changes' : 'Forget note';
  get('saveNote').classList.toggle('destructive',!edit);
  get('saveNote').disabled = false;
  get('noteError').textContent = '';
  get('noteEditor').showModal();
  (edit ? get('noteText') : get('cancelNote')).focus();
}
async function saveNote(event) {
  event.preventDefault();
  const action = noteAction;
  if (!action || action.saving) return;
  const edit = action.method === 'PATCH';
  const value = edit ? get('noteText').value.trim() : '';
  if (edit && !value) return;
  if (!action.request || action.request.text !== (edit ? value : undefined)) {
    action.request = edit ? {text:value,requestId:crypto.randomUUID()} : {requestId:crypto.randomUUID()};
  }
  action.saving = true;
  get('saveNote').disabled = true;
  get('noteError').textContent = '';
  try {
    await api(url(action.agentId,'memory/' + encodeURIComponent(action.noteId)), {
      method:action.method, headers:{'Content-Type':'application/json','X-Requested-With':'owner-console'},
      body:JSON.stringify(action.request)
    });
    if (noteAction === action) get('noteEditor').close();
    if (state.agent?.id === action.agentId) {
      if (edit) state.memories = state.memories.map(row => row.id === action.noteId ? {...row,text:value,updatedAt:new Date().toISOString(),updatedBy:'owner'} : row);
      else state.memories = state.memories.filter(row => row.id !== action.noteId);
      renderMemory();
      await refresh(false);
    }
    get('announcer').textContent = edit ? 'Memory note updated.' : 'Memory note removed.';
  } catch (error) {
    if (noteAction === action) {
      get('noteError').textContent = error.status === 409 ? 'This change conflicts with a saved note. Check the text and try again.' :
        error.status === 404 ? 'This note is no longer available.' : 'The change could not be confirmed. Try again.';
    }
  } finally {
    action.saving = false;
    if (noteAction === action) get('saveNote').disabled = false;
  }
}
async function refresh(scrollToBottom) {
  if (!state.agent) return;
  const agent = state.agent;
  const version = ++state.pollVersion;
  const memoryOpen = !get('memoryPanel').hidden;
  const tasks = [api(url(agent.id, 'messages')).then(r => r.json())];
  if (memoryOpen) tasks.push(api(url(agent.id, 'memory')).then(r => r.json()));
  const [messages, notes] = await Promise.allSettled(tasks);
  if (version !== state.pollVersion) return;
  if (messages.status === 'fulfilled') {
    const data = messages.value;
    const before = state.messages.at(-1)?.id;
    const changed = applyLatest('messages',data) || !state.loaded;
    state.loaded = true;
    state.readError = '';
    const statusChanged = state.status !== data.status;
    state.status = data.status;
    if (statusChanged) schedulePoll();
    renderStatus();
    if (changed) {
      renderTimeline(scrollToBottom);
      const latest = state.messages.at(-1);
      if (before && latest?.id !== before && latest?.author === 'agent') get('announcer').textContent = 'New message from ' + agent.name;
    }
  } else {
    state.readError = 'Conversation updates are unavailable. Reconnecting…';
    renderStatus();
  }
  if (notes) {
    const changed = notes.status === 'fulfilled' && applyLatest('memory',notes.value);
    const oldError = state.memoryError;
    state.memoryError = notes.status === 'fulfilled' ? '' : 'Notes are unavailable. Reconnecting…';
    if (changed || oldError !== state.memoryError) renderMemory();
  }
}
async function loadDirectory() {
  if (directoryRequest) return directoryRequest;
  directoryRequest = (async () => {
    try {
      const r = await api('/api/directory');
      const {agents, mode} = await r.json();
      get('runtime').textContent = mode === 'local' ? 'Local simulator' : mode === 'bedrock' ? 'Bedrock' : 'Workspace owner';
      state.agents = agents;
      state.directoryLoaded = true;
      const current = agents.find(a => a.id === state.agent?.id);
      if (!current && agents.length) {
        selectAgent(agents.find(a => /^(ceo|chief executive officer)$/i.test(a.role)) || agents[0]);
      } else if (current) {
        state.agent = current;
        get('contactName').textContent = current.name;
        get('contactMeta').textContent = headerMeta(current);
        renderNav();
      } else {
        state.pollVersion++;
        state.agent = null;
        resetPages();
        state.messages = [];
        state.memories = [];
        state.status = 'idle';
        state.readError = '';
        get('timeline').replaceChildren();
        get('memoryPanel').hidden = true;
        get('memoryButton').setAttribute('aria-expanded','false');
        get('contactName').textContent = 'Company chat';
        get('contactMeta').textContent = 'Private workspace';
        get('headerAvatar').textContent = '·';
        input.value = '';
        input.placeholder = 'Write a message…';
        document.title = 'Company chat · Perottino & Co.';
        updateOverlay();
        input.disabled = true;
        get('send').disabled = true;
        get('memoryButton').disabled = true;
        get('employeeButton').disabled = true;
        renderNav();
        renderStatus();
      }
    } catch {
      if (!state.directoryLoaded) {
        state.readError = 'The employee directory is unavailable. Reconnecting…';
        renderStatus();
      }
    }
    if (picker.open) renderResults();
  })();
  try { await directoryRequest; } finally { directoryRequest = null; }
}
function updateComposer() {
  const agent = state.agent;
  get('send').disabled = !agent || input.disabled || !input.value.trim() || state.sending.has(agent?.id);
  input.rows = 1;
  // Size to the text while keeping long drafts scrollable under a restrictive CSP.
  const style = getComputedStyle(input);
  const lineHeight = parseFloat(style.lineHeight) || 22;
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  input.classList.remove('multiline');
  const rows = Math.max(1, Math.ceil((input.scrollHeight - padding) / lineHeight));
  input.rows = Math.min(7, rows);
  if (rows > 1) input.classList.add('multiline');
}
async function send(event) {
  event.preventDefault();
  const agent = state.agent;
  const text = input.value.trim();
  if (!agent || input.disabled || !text || state.sending.has(agent.id)) return;
  let request = state.requests.get(agent.id);
  if (!request || request.text !== text) {
    request = {text, requestId:crypto.randomUUID()};
    state.requests.set(agent.id,request);
  }
  state.sendErrors.delete(agent.id);
  state.sending.add(agent.id);
  updateComposer();
  renderStatus();
  try {
    await api(url(agent.id, 'messages'), {
      method:'POST', headers:{'Content-Type':'application/json','X-Requested-With':'owner-console'},
      body:JSON.stringify(request)
    });
    state.requests.delete(agent.id);
    if (state.drafts.get(agent.id)?.trim() === text) state.drafts.delete(agent.id);
    if (state.agent.id === agent.id) {
      if (input.value.trim() === text) input.value = '';
      get('announcer').textContent = 'Message sent to ' + agent.name;
      await refresh(true);
      schedulePoll();
    }
  } catch (error) {
    state.sendErrors.set(agent.id,
      error.status === 400 || error.status === 413 ? 'The message could not be accepted. Check its length and try again.' :
      error.status === 409 ? 'This message conflicts with an earlier request or the employee has left the company. Open Employee for details.' :
      'The send could not be confirmed. Try sending the same message again.');
  } finally {
    state.sending.delete(agent.id);
    updateComposer();
    renderStatus();
  }
}
function setDraft(text) {
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.focus();
}
get('newMessage').addEventListener('click', () => showPicker('New message'));
get('directory').addEventListener('click', () => showPicker('Directory'));
get('employeeButton').addEventListener('click',openEmployee);
get('closeEmployee').addEventListener('click',() => get('employeeDialog').close());
get('employeeDialog').addEventListener('close',() => { profileRead++; });
get('refreshEmployee').addEventListener('click',() => { get('employeeStatus').textContent = ''; void refreshEmployee(); });
get('toggleEmployment').addEventListener('click',() => void employeeAction(employment.get(state.agent?.id) === 'paused' ? 'resume' : 'pause'));
get('fireEmployee').addEventListener('click',() => void employeeAction('fire'));
get('goalForm').addEventListener('submit',event => { event.preventDefault(); void employeeAction('goals'); });
get('earlierMessages').addEventListener('click',() => void loadEarlier('messages'));
get('moreNotes').addEventListener('click',() => void loadEarlier('memory'));
get('closeSource').addEventListener('click',() => get('sourceDialog').close());
get('sourceDialog').addEventListener('close',() => { sourceRequest++; });
get('closePicker').addEventListener('click', () => picker.close());
picker.addEventListener('click', event => {
  if (event.target !== picker) return;
  const bounds = picker.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) picker.close();
});
get('search').addEventListener('input',renderResults);
get('openSidebar').addEventListener('click', showNavigation);
get('closeSidebar').addEventListener('click', closeNavigation);
get('sidebarShade').addEventListener('click', closeNavigation);
get('memoryButton').addEventListener('click', () => toggleMemory(get('memoryPanel').hidden));
get('closeMemory').addEventListener('click', () => toggleMemory(false));
get('memoryShade').addEventListener('click', () => toggleMemory(false));
narrow.addEventListener('change', () => { if (!narrow.matches) closeNavigation(); updateOverlay(); });
overlayMemory.addEventListener('change', updateOverlay);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || picker.open || get('noteEditor').open || get('sourceDialog').open || get('employeeDialog').open) return;
  if (!get('memoryPanel').hidden) toggleMemory(false);
  else closeNavigation();
});
get('cancelNote').addEventListener('click', () => get('noteEditor').close());
get('closeNote').addEventListener('click', () => get('noteEditor').close());
get('noteEditor').addEventListener('close', () => { noteAction = null; });
get('noteForm').addEventListener('submit', saveNote);
get('composer').addEventListener('submit', send);
input.addEventListener('input', () => {
  if (state.agent) state.drafts.set(state.agent.id, input.value);
  updateComposer();
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!get('send').disabled) get('composer').requestSubmit();
  }
});
get('intro').addEventListener('click', () => setDraft('Introduce yourself and tell me how we can work together.'));
get('brief').addEventListener('click', () => setDraft('I’d like your help with '));

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  const busy = state.status === 'queued' || state.status === 'working';
  const retry = !state.agent || state.readError;
  pollTimer = window.setTimeout(poll, delay ?? (busy ? 2500 : retry ? 10000 : 60000));
}
async function poll() {
  if (document.hidden) return;
  const selected = state.agent?.id;
  try {
    if (!selected || Date.now() - directoryCheckedAt >= 300000) {
      await loadDirectory();
      directoryCheckedAt = Date.now();
    }
    // Selecting an employee in loadDirectory already fetches the first message page.
    if (selected && state.agent?.id === selected) await Promise.all([refresh(false),
      get('employeeDialog').open && !actionPending ? refreshEmployee() : undefined]);
  } finally { schedulePoll(); }
}
document.addEventListener('visibilitychange', () => schedulePoll(0));
renderStatus();
void poll();
