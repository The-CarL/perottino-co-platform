'use strict';
function mailModeLabel(mode) {
  return (
    {
      capture: 'External messages are captured locally.',
      disabled: 'External sending is disabled.',
      ses: 'External mail is sent through Amazon SES.',
    }[mode] || ''
  );
}
async function mailPage(token) {
  const selected = routeOption('employeeId') || '';
  const employees = optionSelect(
    'employeeId',
    [['', 'All employee mail'], ...roster.map((a) => [a.id, a.name + ' · ' + a.role])],
    selected,
    false,
  );
  employees.onchange = () => {
    location.hash = routeTo('mail', employees.value ? { employeeId: employees.value } : {});
  };
  const rows = el('ul', { class: 'resource-list' }),
    list = el('div', {}, rows),
    mode = sectionNote('');
  let after;
  const more = btn('More threads', load);
  async function load() {
    more.disabled = true;
    try {
      const result = await api('mail.list', {
        ...(selected && { employeeId: selected }),
        limit: 40,
        ...(after && { after }),
      });
      if (token !== revision) return;
      mode.textContent = [result.domain, mailModeLabel(result.outbound)].filter(Boolean).join(' · ');
      for (const t of result.threads)
        rows.append(
          rowChoice(
            t.subject || '(No subject)',
            t.contact || t.members.map(nameOf).join(', '),
            () => mailThread(t.id),
            date(t.updatedAt),
          ),
        );
      if (!rows.children.length) list.prepend(empty('No email threads for this selection.'));
      after = result.next;
      more.hidden = !after;
    } finally {
      more.disabled = false;
    }
  }
  list.append(el('div', { class: 'page-more' }, more));
  actions.append(btn('Compose email', () => composeEmail(selected), { class: 'primary' }));
  content.replaceChildren(
    el('div', { class: 'resource-toolbar' }, field('Mailbox', employees)),
    mode,
    panel('Email threads', list),
  );
  await load();
}

async function composeEmail(preselected) {
  const { domain, outbound } = await api('mail.list', { limit: 1 });
  const sender = optionSelect(
    'employeeId',
    activeEmployees()
      .filter((a) => a.desiredState === 'active')
      .map((a) => [a.id, a.name + ' · ' + a.role]),
    preselected || undefined,
  );
  const to = textControl('to', '', { type: 'email' });
  const body = textControl('text', '', { multiline: true, rows: 7 });
  const files = fileLinkPicker(body);
  files.hidden = true;
  to.addEventListener('input', () => {
    files.hidden = !to.value
      .trim()
      .toLowerCase()
      .endsWith('@' + domain);
  });
  form(
    'Compose email',
    [
      sectionNote([domain, mailModeLabel(outbound)].filter(Boolean).join(' · ')),
      field('Send as', sender),
      field('To', to),
      field('Subject', textControl('subject', '', { max: 200 })),
      field('Email message', body),
      files,
    ],
    'Send email',
    async (data) => {
      const result = await change('mail.send', Object.fromEntries(data));
      await render();
      await mailThread(result.threadId);
    },
  );
}

async function mailThread(threadId) {
  const result = await api('mail.get', { threadId, limit: 60 });
  const thread = result.thread,
    messages = el('div', { class: 'stack' });
  const senders = activeEmployees().filter(
    (a) => a.desiredState === 'active' && thread.members.includes(a.id),
  );
  let after = result.next;
  function add(batch) {
    for (const m of batch.messages)
      messages.append(
        el(
          'article',
          { class: 'panel panel-pad' },
          el('h3', {}, m.from + ' → ' + m.to),
          sectionNote([date(m.createdAt), label(m.direction), label(m.status)].filter(Boolean).join(' · ')),
          el('p', { class: 'mail-text' }, protectedMessageText(m.text)),
          senders.length ? btn('Reply to this message', () => reply(m), { class: 'link' }) : null,
        ),
      );
  }
  function reply(m) {
    const sender = optionSelect(
      'employeeId',
      senders.map((a) => [a.id, a.name + ' · ' + a.role]),
    );
    const body = textControl('text', '', { multiline: true, rows: 7 });
    form(
      'Reply to email',
      [
        sectionNote(thread.subject + ' · ' + mailModeLabel(result.outbound)),
        field('Reply as', sender),
        field('Email reply', body),
        thread.contact ? null : fileLinkPicker(body),
      ],
      'Send reply',
      async (data) => {
        await change('mail.reply', { threadId, messageId: m.id, ...Object.fromEntries(data) });
        await mailThread(threadId);
      },
    );
  }
  add(result);
  const more = btn('More messages', async () => {
    const batch = await api('mail.get', { threadId, limit: 60, after });
    add(batch);
    after = batch.next;
    more.hidden = !after;
  });
  more.hidden = !after;
  showDialog(
    thread.subject || 'Email thread',
    sectionNote([thread.contact, mailModeLabel(result.outbound)].filter(Boolean).join(' · ')),
    messages,
    more,
    btn('Refresh thread', () => mailThread(threadId)),
  );
}
