'use strict';

async function projectsPage(token) {
  const { projects, next } = await api('project.list', { limit: 40 });
  if (token !== revision) return;
  actions.append(btn('Create project', () => projectForm(), { class: 'primary' }));
  const rows = el('ul', { class: 'resource-list' });
  function append(projects) {
    for (const p of projects)
      rows.append(
        rowChoice(
          p.name,
          nameOf(p.ownerId) + ' · ' + p.repo,
          () => projectDialog(p.id),
          p.latestSha ? p.latestSha.slice(0, 8) : null,
        ),
      );
  }
  append(projects);
  let after = next;
  const more = btn('More projects', async () => {
    const page = await api('project.list', { limit: 40, after });
    append(page.projects);
    after = page.next;
    more.hidden = !after;
  });
  more.hidden = !after;
  content.replaceChildren(
    panel(
      'Company projects',
      el(
        'div',
        {},
        rows,
        rows.children.length ? null : empty('Projects connect a goal to its source, builds and deployments.'),
        el('div', { class: 'page-more' }, more),
      ),
    ),
  );
}
async function projectForm(project) {
  const goals = (await collect('goal.list', 'goals', { status: 'active' })).filter(
    (g) => !project?.goalIds?.includes(g.id),
  );
  if (!goals.length) {
    showDialog(
      'Project goals',
      empty('Create an active goal before linking it to a project.'),
      btn('Create goal', goalForm),
    );
    return;
  }
  form(
    project ? 'Link another goal' : 'Create project',
    [
      ...(project ? [] : [field('Project name', textControl('name', '', { max: 160 }))]),
      field(
        'Goal',
        optionSelect(
          'goalId',
          goals.map((g) => [g.id, g.outcome]),
        ),
      ),
    ],
    project ? 'Link goal' : 'Create project',
    async (data) => {
      const result = await change(project ? 'project.attach' : 'project.create', {
        ...Object.fromEntries(data),
        ...(project && { projectId: project.id }),
      });
      await render();
      await projectDialog(result.project.id);
    },
  );
}
async function projectDialog(projectId) {
  const { project: p } = await api('project.get', { projectId });
  const handoffs = await collect('project.history', 'handoffs', { projectId });
  const body = el('div', { class: 'stack' });
  showDialog(
    p.name,
    facts([
      ['Accountable employee', nameOf(p.ownerId)],
      ['Project ID', p.id],
      ['Repository', p.repo],
      ['Directory', p.path],
    ]),
    el(
      'div',
      { class: 'actions' },
      btn('Project conversation', () => projectConversations(p)),
      btn('Project decisions', () => knowledgeDialog(null, p.id)),
      btn('Sandbox resources', () => projectResources(p)),
      btn('Link goal', () => projectForm(p)),
    ),
    el('h3', {}, 'Linked goals'),
    el(
      'div',
      { class: 'actions' },
      (p.goalIds || [p.goalId]).map((id, i) => btn('Open goal ' + (i + 1), () => showWork('goals', id))),
    ),
    el('h3', {}, 'Source handoffs'),
    resourceList(
      handoffs,
      (h) =>
        rowChoice(
          h.sha.slice(0, 12),
          [h.branch, nameOf(h.agentId), date(h.createdAt)].filter(Boolean).join(' · '),
          () => handoffDialog(p, h),
          label(h.status),
        ),
      'No committed handoffs yet.',
    ),
    body,
  );
  if (p.latestSha && p.latestTaskId) await deliveryPanel(p, p.latestTaskId, p.latestSha, body);
}
async function projectConversations(project) {
  const conversations = await collect('conversations.list', 'conversations');
  const matches = conversations.filter((c) => c.type === 'group' && c.title === project.name);
  if (!matches.length) return groupForm(project.name);
  showDialog(
    'Project conversations',
    sectionNote(project.name),
    resourceList(
      matches,
      (c) =>
        rowChoice(c.title, c.members.map(nameOf).join(', '), () => {
          pendingConversation = c;
          return navigate('chat');
        }),
      'No matching groups.',
    ),
    btn('Create another group', () => groupForm(project.name)),
  );
}

async function handoffDialog(p, h) {
  const snapshot = await api('project.snapshot', { projectId: p.id, taskId: h.taskId, commitSha: h.sha });
  const body = el('div', { class: 'stack' });
  showDialog(
    'Source handoff',
    sectionNote(p.name),
    facts([
      ['Commit', h.sha],
      ['Base commit', h.baseSha],
      ['Branch', h.branch],
      ['Employee', nameOf(h.agentId)],
      [
        'Pull request',
        h.pr?.local ? 'Local PR ' + h.pr.number : h.pr?.url && webLink(h.pr.url, 'Open PR ' + h.pr.number),
      ],
    ]),
    el('h3', {}, 'Committed files'),
    resourceList(
      snapshot.files,
      (f) =>
        rowChoice(f.path, null, () =>
          showDialog(
            f.path,
            el('pre', { class: 'file-content' }, f.content),
            btn('Back to handoff', () => handoffDialog(p, h)),
          ),
        ),
      'Empty snapshot.',
    ),
    body,
  );
  await deliveryPanel(p, h.taskId, h.sha, body);
}
async function deliveryPanel(p, taskId, commitSha, body) {
  const args = { projectId: p.id, taskId, commitSha };
  const result = await api('delivery.status', args);
  const build = result.build;
  function operation(title, fields, button, op, params) {
    form(title, [sectionNote(p.name + ' · ' + commitSha.slice(0, 12)), ...fields], button, async (data) => {
      await change(op, { ...params, ...(data.has('hours') ? { ttlHours: Number(data.get('hours')) } : {}) });
      await projectDialog(p.id);
    });
  }
  const commands = el(
    'div',
    { class: 'actions' },
    btn('Build and test', () => operation('Build committed source', [], 'Run build', 'delivery.build', args)),
  );
  if (build?.status === 'passed')
    commands.append(
      btn('Create preview', () =>
        operation(
          'Create preview',
          [field('Lifetime (hours)', textControl('hours', 24, { type: 'number', min: 1, step: '1' }))],
          'Create preview',
          'delivery.preview',
          { projectId: p.id, buildId: build.buildId },
        ),
      ),
      btn('Release build', () =>
        operation(
          'Release build',
          [sectionNote('Publish the approved build at the production URL.')],
          'Publish release',
          'delivery.release',
          { projectId: p.id, buildId: build.buildId },
        ),
      ),
    );
  if (result.preview?.buildId)
    commands.append(
      btn(
        'Remove preview',
        () =>
          operation(
            'Remove preview',
            [sectionNote('Withdraw the current temporary preview.')],
            'Confirm removal',
            'delivery.expire',
            { projectId: p.id, buildId: result.preview.buildId },
          ),
        { class: 'danger' },
      ),
    );
  if (result.production?.buildId)
    commands.append(
      btn(
        'Withdraw production release',
        () =>
          operation(
            'Withdraw production release',
            [sectionNote('The production URL will stop serving this release.')],
            'Confirm withdrawal',
            'delivery.withdraw',
            { projectId: p.id, buildId: result.production.buildId },
          ),
        { class: 'danger' },
      ),
    );
  if (result.production?.previousBuildId)
    commands.append(
      btn('Roll back release', () =>
        operation(
          'Roll back release',
          [sectionNote('Restore the previous successful production build.')],
          'Confirm rollback',
          'delivery.rollback',
          { projectId: p.id },
        ),
      ),
    );
  const details = [
    ['Build', build ? label(build.status) : 'No recorded build'],
    ['Build detail', build?.reason],
    ['Preview', result.preview && webLink(result.preview.url, 'Open preview', true)],
    ['Expires', result.preview?.expiresAt && date(result.preview.expiresAt)],
    ['Production', result.production && webLink(result.production.url, 'Open release', true)],
  ];
  body.replaceChildren(el('h3', {}, 'Builds and deployment'), facts(details), commands);
}

async function projectResources(project) {
  const projectId = project.id;
  const page = await api('infra.list', { projectId });
  if (!page.enabled) {
    showDialog(
      'Sandbox resources',
      sectionNote(project.name),
      empty('A provisioning sandbox has not been configured for this project.'),
    );
    return;
  }
  const resources = el('ul', { class: 'resource-list' });
  function append(rows) {
    for (const resource of rows) {
      resources.append(
        rowChoice(
          resource.resourceId,
          'Private queue · Expires ' + date(resource.expiresAt),
          () => inspectResource(project, resource.resourceId),
          status(resource.status),
        ),
      );
    }
  }
  append(page.resources);
  let cursor = page.next;
  const more = btn('More resources', async () => {
    const nextPage = await api('infra.list', { projectId, after: cursor });
    append(nextPage.resources);
    cursor = nextPage.next;
    more.hidden = !cursor;
  });
  more.hidden = !cursor;
  showDialog(
    'Sandbox resources',
    sectionNote(project.name),
    resources,
    resources.children.length ? null : empty('No resources provisioned.'),
    more,
    btn(
      'Provision temporary queue',
      () =>
        form(
          'Provision temporary queue',
          [
            sectionNote('Create a private encrypted queue in the project sandbox.'),
            field('Lifetime (hours)', textControl('hours', 24, { type: 'number', min: 1, step: '1' })),
          ],
          'Create queue',
          async (data) => {
            const resource = await change('infra.provision', {
              projectId,
              template: 'temporary-queue-v1',
              ttlHours: Number(data.get('hours')),
            });
            await inspectResource(project, resource.resourceId);
          },
        ),
      { class: 'primary' },
    ),
  );
}
async function inspectResource(project, resourceId) {
  const resource = await api('infra.status', { projectId: project.id, resourceId });
  showDialog(
    'Private queue',
    sectionNote(project.name),
    facts([
      ['Resource ID', resource.resourceId],
      ['Template', resource.template],
      ['Status', label(resource.status)],
      ['Expires', date(resource.expiresAt)],
      ['Queue URL', resource.url],
    ]),
    el(
      'div',
      { class: 'actions' },
      btn('Back to resources', () => projectResources(project)),
      resource.status === 'active'
        ? btn(
            'Remove queue',
            () =>
              form(
                'Remove queue',
                [sectionNote('Remove this project queue and its messages.'), sectionNote(resourceId)],
                'Confirm queue removal',
                async () => {
                  await change('infra.remove', { projectId: project.id, resourceId });
                  await projectResources(project);
                },
              ),
            { class: 'danger' },
          )
        : null,
    ),
  );
}
