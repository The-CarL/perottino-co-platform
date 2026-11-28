'use strict';

async function filesPage(token) {
  const prefix = routeOption('prefix') || '';
  const path = routeOption('path');
  const query = textControl('prefix', prefix, { required: false });
  const search = el(
    'form',
    { class: 'resource-toolbar' },
    field('Path prefix', query),
    el('button', { type: 'submit' }, 'Filter files'),
  );
  search.onsubmit = (evt) => {
    evt.preventDefault();
    location.hash = routeTo('files', query.value ? { prefix: query.value } : {});
  };
  actions.append(
    btn('New document', () => editDocument()),
    btn('Upload file', uploadFileDialog, { class: 'primary' }),
  );
  const rows = el('ul', { class: 'resource-list' }),
    container = el('div', {}, rows);
  let after;
  const more = btn('More files', load);
  async function load() {
    more.disabled = true;
    try {
      const result = await api('files.list', { prefix, limit: 40, ...(after && { after }) });
      if (token !== revision) return;
      for (const file of result.files)
        rows.append(
          rowChoice(
            file.path,
            file.size + ' bytes · Version ' + file.version,
            () => showFile(file.path),
            date(file.updatedAt),
          ),
        );
      if (!rows.children.length)
        container.prepend(empty(prefix ? 'No files match this path prefix.' : 'No shared files yet.'));
      after = result.next;
      more.hidden = !after;
    } finally {
      more.disabled = false;
    }
  }
  container.append(el('div', { class: 'page-more' }, more));
  content.replaceChildren(search, panel('Shared company files', container));
  await load();
  if (path && token === revision) {
    const version = routeOption('version');
    if (version !== null && !validFileVersion(version)) throw Error('Invalid file version.');
    await showFile(path, version === null ? undefined : Number(version));
  }
}

async function showSoul(employeeId) {
  const { file } = await api('soul.get', { employeeId });
  await fileDialog(file);
}

async function showFile(path, version) {
  const { file } = await api('files.read', { path, ...(version && { version }) });
  await fileDialog(file, Boolean(version));
}

async function fileDialog(file, historical = false) {
  const detail = facts([
    ['Path', file.path],
    ['Version', file.version],
    ['Size', file.size + ' bytes'],
    ['Edited by', nameOf(file.authorId)],
    ['Edited', date(file.updatedAt)],
  ]);
  const buttons = el(
    'div',
    { class: 'actions' },
    btn('Download', () => downloadFile(file)),
    btn('Version history', () => fileHistory(file.path)),
    el('a', { href: fileVersionUrl(file), class: 'button' }, 'Link to version ' + file.version),
  );
  if (!historical && file.encoding === 'utf8' && typeof file.text === 'string')
    buttons.prepend(btn('Edit document', () => editDocument(file), { class: 'primary' }));
  if (historical)
    buttons.prepend(
      btn('Restore this version', async () => {
        const { file: head } = await api('files.read', { path: file.path });
        form(
          'Restore file version',
          [sectionNote('Create a new version of ' + file.path + ' from version ' + file.version + '.')],
          'Restore version',
          async () => {
            if (typeof file.text === 'string')
              await change('files.write', {
                path: file.path,
                expectedVersion: head.version,
                text: file.text,
              });
            else await uploadBlob(file.path, await fileBlob(file), head.version);
            await showFile(file.path);
          },
        );
      }),
    );
  showDialog(
    file.path.split('/').at(-1),
    detail,
    typeof file.text === 'string'
      ? el('pre', { class: 'file-content' }, file.text)
      : sectionNote('Download to open this file.'),
    buttons,
  );
}

async function fileHistory(path) {
  const versions = await collect('files.versions', 'versions', { path });
  showDialog(
    'Version history',
    sectionNote(path),
    resourceList(
      versions,
      (v) =>
        rowChoice(
          'Version ' + v.version,
          [nameOf(v.authorId), date(v.updatedAt)].filter(Boolean).join(' · '),
          () => showFile(path, v.version),
        ),
      'No versions available.',
    ),
  );
}

function editDocument(file) {
  const name = textControl('path', file?.path || '', { max: 512 });
  if (file) name.readOnly = true;
  const body = textControl('text', file?.text || '', { multiline: true, rows: 12, required: false });
  form(
    file ? 'Edit document' : 'New document',
    [field('File path', name), field('Contents', body)],
    'Save document',
    async (data) => {
      const path = data.get('path');
      await change('files.write', { path, text: data.get('text'), expectedVersion: file?.version || 0 });
      if (page === 'files') await render();
      await showFile(path);
    },
  );
}

function uploadFileDialog() {
  const upload = el('input', { type: 'file', required: true, name: 'upload' });
  const path = textControl('path', '', { max: 512 });
  upload.onchange = () => {
    if (!path.value && upload.files[0]) path.value = upload.files[0].name;
  };
  form(
    'Upload file',
    [field('Select file', upload), field('Destination path', path)],
    'Upload',
    async (data) => {
      const file = upload.files[0];
      if (!file) throw Error('Select a file.');
      await uploadBlob(data.get('path'), file, 0);
      await render();
      await showFile(data.get('path'));
    },
  );
}

const fileChunkBytes = 60 * 1024;
async function uploadBlob(path, blob, expectedVersion) {
  const total = Math.max(1, Math.ceil(blob.size / fileChunkBytes));
  if (total > 256) throw Error('A file may be up to 15 MiB.');
  const parts = [];
  for (let part = 0; part < total; part++) {
    const bytes = new Uint8Array(
      await blob.slice(part * fileChunkBytes, (part + 1) * fileChunkBytes).arrayBuffer(),
    );
    const contentBase64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
    if (total === 1) return change('files.write', { path, contentBase64, expectedVersion });
    const result = await api('files.part', { contentBase64 });
    parts.push(result.sha256);
  }
  return change('files.commit', { path, parts, expectedVersion });
}

async function fileBlob(file) {
  if (typeof file.text === 'string') return new Blob([file.text], { type: 'application/octet-stream' });
  const chunks = [];
  for (let part = 0; part < (file.parts || 1); part++) {
    const current =
      file.contentBase64 !== undefined && (file.parts || 1) === 1
        ? file
        : (await api('files.read', { path: file.path, version: file.version, part })).file;
    chunks.push(Uint8Array.from(atob(current.contentBase64), (c) => c.charCodeAt(0)));
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}
async function downloadFile(file) {
  const url = URL.createObjectURL(await fileBlob(file));
  const a = el('a', { href: url, download: file.path.split('/').at(-1) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function knowledgeDialog(employeeId, projectId) {
  const scope = projectId ? { projectId } : { employeeId };
  const list = await collect('knowledge.list', 'memories', scope);
  const edit = (note) =>
    form(
      note ? 'Correct memory' : 'Save memory',
      [
        field('Memory text', textControl('text', note?.text || '', { multiline: true, max: 4000 })),
        el(
          'label',
          {},
          el('input', { type: 'checkbox', name: 'pinned', checked: note?.pinned }),
          ' Pin memory',
        ),
      ],
      'Save memory',
      async (data) => {
        await change(note ? 'knowledge.correct' : 'knowledge.save', {
          ...scope,
          text: data.get('text'),
          pinned: data.has('pinned'),
          ...(note && { memoryId: note.id, expectedVersion: note.revision }),
        });
        await knowledgeDialog(employeeId, projectId);
      },
    );
  showDialog(
    projectId ? 'Project decisions' : 'Employee memory',
    sectionNote(projectId ? 'Decisions and lessons shared with this project.' : nameOf(employeeId)),
    btn('Add memory', () => edit()),
    resourceList(
      list,
      (n) =>
        el(
          'li',
          { class: 'row' },
          el('p', {}, n.text),
          el(
            'div',
            { class: 'actions' },
            n.source?.path ? btn('Source file', () => showFile(n.source.path, n.source.version)) : null,
            btn('Correct', () => edit(n)),
            btn(
              'Forget',
              () =>
                form('Forget memory', [sectionNote(n.text)], 'Confirm forgetting', async () => {
                  await change('knowledge.forget', { ...scope, memoryId: n.id, expectedVersion: n.revision });
                  await knowledgeDialog(employeeId, projectId);
                }),
              { class: 'danger' },
            ),
          ),
        ),
      'No employee memories yet.',
    ),
  );
}

function validFileVersion(value) {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function fileVersionUrl({ path, version }) {
  return new URL('/' + routeTo('files', { path, version }), location.origin).href;
}

function parseFileVersionUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== location.origin ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    !url.hash.startsWith('#files?')
  )
    return null;
  const query = new URLSearchParams(url.hash.slice('#files?'.length));
  const path = query.get('path'),
    version = query.get('version');
  if (query.size !== 2 || !path || !validFileVersion(version)) return null;
  return { path, version: Number(version) };
}

// Resolve only the two private resource links supported by this portal.
function protectedMessageText(text) {
  const contents = document.createDocumentFragment();
  let start = 0;
  for (const match of text.matchAll(
    /\bhttps?:\/\/[^\s<>"']+|(?<!\S)\/chat#browsers\?sessionId=bs-[a-f0-9]{32}\b/gi,
  )) {
    const candidate = match[0].replace(/[,.!;:?)\]]+$/g, '');
    const ref = parseFileVersionUrl(candidate);
    let anchor;
    if (ref) anchor = el('a', { href: fileVersionUrl(ref) }, ref.path + ' · v' + ref.version);
    else {
      let url;
      try {
        url = new URL(candidate, location.origin);
      } catch {
        continue;
      }
      if (
        url.origin !== location.origin ||
        url.username ||
        url.password ||
        url.pathname !== '/chat' ||
        url.search ||
        !/^#browsers\?sessionId=bs-[a-f0-9]{32}$/.test(url.hash)
      )
        continue;
      anchor = el('a', { href: url.href }, 'Open browser session');
    }
    contents.append(text.slice(start, match.index), anchor);
    start = match.index + candidate.length;
  }
  contents.append(text.slice(start));
  return contents;
}

// Do not attach file bytes to messages. Resolve the named revision with the owner session
// and insert an ordinary protected URL, preserving the employee's existing draft.
function fileLinkPicker(draft) {
  const suggestions = el('datalist', { id: 'file-options-' + crypto.randomUUID() });
  const path = el('input', { type: 'text', list: suggestions.id, autocomplete: 'off', maxlength: 500 });
  const version = el('input', {
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: 'Current',
  });
  const feedback = el('span', { role: 'status' });
  const picker = el(
    'details',
    {},
    el('summary', {}, 'Link a company file'),
    field('Company file path', path),
    suggestions,
    field('File version (optional)', version),
    btn('Insert version link', insert),
    feedback,
  );
  let timer;
  async function suggest() {
    const prefix = path.value;
    try {
      const { files } = await api('files.list', { prefix, limit: 20 });
      if (picker.open && prefix === path.value)
        suggestions.replaceChildren(...files.map((file) => el('option', { value: file.path })));
    } catch {
      /* A complete path can still be entered if suggestions are unavailable. */
    }
  }
  picker.addEventListener('toggle', () => {
    if (picker.open) void suggest();
  });
  path.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(suggest, 200);
  });
  async function insert() {
    feedback.textContent = '';
    if (!path.value || (version.value && !validFileVersion(version.value))) {
      feedback.textContent = 'Enter a file path and a positive whole-number version.';
      return;
    }
    try {
      const result = await api('files.read', {
        path: path.value,
        ...(version.value && { version: Number(version.value) }),
      });
      const url = fileVersionUrl(result.file);
      const from = draft.selectionStart,
        to = draft.selectionEnd;
      const left = draft.value.slice(0, from),
        right = draft.value.slice(to);
      const insertion = (/\S$/.test(left) ? ' ' : '') + url + (/^\S/.test(right) ? ' ' : '');
      draft.setRangeText(insertion, from, to, 'end');
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      picker.open = false;
      draft.focus();
    } catch (error) {
      feedback.textContent = error.message;
    }
  }
  return picker;
}
