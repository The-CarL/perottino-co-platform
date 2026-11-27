'use strict';
const configFields = {
  mandate: 'Company mandate',
  modelId: 'Bedrock model',
  reasoningEffort: 'Reasoning effort',
  pulseSeconds: 'Pulse interval (seconds)',
  maxSteps: 'Maximum steps per pulse',
  networkAccess: 'Web access',
};
const currency = (cents) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
function usdField(name, cents) {
  return textControl(name, (cents / 100).toFixed(2), { type: 'number', min: 0, step: '0.01' });
}
function centsOf(data, name) {
  const value = String(data.get(name));
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw Error('Enter a USD amount with at most two decimal places.');
  const [integer, decimals = ''] = value.split('.');
  const cents = Number(integer) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw Error('That USD amount is too large.');
  return cents;
}
async function settingsPage(token) {
  const tab = routeOption('tab') || 'configuration';
  const tabs = el(
    'div',
    { class: 'resource-tabs' },
    ...[
      ['configuration', 'Agent configuration'],
      ['policy', 'Policy and budget'],
      ['promotions', 'Promotions'],
    ].map(([id, name]) =>
      btn(
        name,
        () => {
          location.hash = routeTo('settings', { tab: id });
        },
        { 'aria-pressed': String(tab === id) },
      ),
    ),
  );
  const body = el('div', { class: 'stack' });
  content.replaceChildren(tabs, body);
  if (tab === 'policy') return policyPage(body, token);
  if (tab === 'promotions') return promotionsPage(body, token);
  const scopes = [
    ['company', 'Company defaults'],
    ['role', 'Role override'],
    ['employee', 'Employee override'],
  ];
  const scope = routeOption('scope') || 'company';
  const targets =
    scope === 'employee'
      ? roster.map((a) => [a.id, a.name + ' · ' + a.role])
      : [...new Set(roster.map((a) => a.role))].map((v) => [v, v]);
  const target = scope === 'company' ? null : routeOption('target') || targets[0]?.[0];
  const chooser = optionSelect('scope', scopes, scope),
    choice = optionSelect('target', targets, target);
  function move() {
    const params = { tab: 'configuration', scope: chooser.value };
    if (chooser.value === scope && scope !== 'company' && choice.value) params.target = choice.value;
    location.hash = routeTo('settings', params);
  }
  chooser.onchange = move;
  choice.onchange = move;
  const controls = el('div', { class: 'resource-toolbar' }, field('Configuration scope', chooser));
  if (scope !== 'company') controls.append(field(scope === 'role' ? 'Role' : 'Employee', choice));
  body.append(controls);
  if (scope !== 'company' && !target) {
    body.append(empty('No employees available.'));
    return;
  }
  const args = { scope, ...(target && { target }) };
  const config = await api('settings.get', args);
  const effective = await api('settings.effective', scope === 'employee' ? { employeeId: target } : {});
  if (token !== revision) return;
  const affected = roster.filter(
    (a) =>
      a.desiredState === 'active' &&
      (scope === 'company' || (scope === 'role' ? a.role === target : a.id === target)),
  );
  const factsList = Object.entries(configFields).map(([key, name]) => {
    const set = Object.hasOwn(config.settings, key);
    return [
      name,
      set
        ? String(config.settings[key])
        : scope === 'company'
          ? String(effective.settings[key]) + ' · Default'
          : 'Inherited',
    ];
  });
  body.append(
    panel(
      scope === 'company' ? 'Company defaults' : 'Scoped configuration',
      el(
        'div',
        { class: 'resource-body' },
        facts(factsList),
        sectionNote(
          'Revision ' +
            config.version +
            ' · ' +
            affected.length +
            ' active ' +
            (affected.length === 1 ? 'employee' : 'employees') +
            ' in this scope.',
        ),
        el(
          'div',
          { class: 'actions' },
          btn('Edit configuration', () => editScope(args, config, affected), { class: 'primary' }),
          btn('Revision history', () => settingsHistory(args, config.version)),
          scope === 'employee' ? btn('Effective settings', () => effectiveSettingsDialog(target)) : null,
        ),
      ),
    ),
  );
}
function editScope(args, config, affected) {
  const v = config.settings,
    inherited = args.scope === 'company' ? 'Use default' : 'Inherit';
  const controls = Object.entries(configFields).map(([key, title]) => {
    let control;
    if (key === 'modelId' || key === 'reasoningEffort')
      control = optionSelect(
        key,
        [
          ['', inherited],
          ...(key === 'modelId' ? config.modelIds : ['low', 'medium', 'high']).map((x) => [x, x]),
        ],
        v[key] || '',
        false,
      );
    else if (key === 'networkAccess')
      control = optionSelect(
        key,
        [
          ['', inherited],
          ['true', 'Allowed'],
          ['false', 'Disabled'],
        ],
        v[key] === undefined ? '' : String(v[key]),
        false,
      );
    else if (key === 'mandate')
      control = textControl(key, v[key], { multiline: true, required: false, max: 4000 });
    else
      control = textControl(key, v[key], {
        type: 'number',
        min: key === 'pulseSeconds' ? 5 : 1,
        step: '1',
        required: false,
      });
    return field(title, control);
  });
  form(
    'Publish agent configuration',
    [
      sectionNote('Changes apply on the next pulse. Empty fields use the inherited value.'),
      sectionNote(
        affected.length
          ? 'Applies within the scope of ' + affected.map((a) => a.name).join(', ') + '.'
          : 'No active employees in this scope.',
      ),
      ...controls,
    ],
    'Publish configuration',
    saveAndClose(async (data) => {
      const settings = {};
      for (const key of Object.keys(configFields)) {
        const value = data.get(key);
        settings[key] =
          value === ''
            ? null
            : key === 'networkAccess'
              ? value === 'true'
              : ['maxSteps', 'pulseSeconds'].includes(key)
                ? Number(value)
                : value;
      }
      await change('settings.update', { ...args, settings, expectedVersion: config.version });
    }),
  );
}
async function settingsHistory(args, version) {
  const list = await collect('settings.history', 'revisions', args);
  showDialog(
    'Configuration revisions',
    resourceList(
      list,
      (r) =>
        el(
          'li',
          { class: 'row' },
          el('strong', {}, 'Revision ' + r.version),
          sectionNote(date(r.at)),
          facts(Object.entries(r.settings).map(([k, v]) => [configFields[k] || k, v])),
          r.version !== version
            ? btn('Restore revision ' + r.version, () =>
                form(
                  'Restore configuration',
                  [sectionNote('Publish the settings from revision ' + r.version + ' as a new revision.')],
                  'Restore revision',
                  saveAndClose(() =>
                    change('settings.restore', { ...args, revision: r.version, expectedVersion: version }),
                  ),
                ),
              )
            : null,
        ),
      'No published revisions yet.',
    ),
  );
}
async function effectiveSettingsDialog(employeeId) {
  const result = await api('settings.effective', { employeeId });
  showDialog(
    'Effective settings',
    sectionNote(nameOf(employeeId)),
    facts(
      Object.entries(configFields).map(([key, title]) => {
        const origin = result.origins[key].split('#'),
          source = origin[0] === 'employee' ? nameOf(origin[1]) : origin.join(' · ');
        return [
          title,
          el(
            'div',
            {},
            String(result.settings[key]),
            el('small', { class: 'field-note' }, ' · ' + label(source)),
          ),
        ];
      }),
    ),
  );
}
async function policyPage(body, token) {
  const { policy } = await api('policy.get');
  if (token !== revision) return;
  body.append(
    panel(
      'Company policy',
      el(
        'div',
        { class: 'resource-body' },
        facts([
          ['Company budget', currency(policy.totalBudgetCents)],
          ['CEO promotion approval', policy.allowCeoPromotions ? 'Allowed' : 'Owner approval required'],
          ['Direct report limit', policy.maxDirectReports],
          ['Allocation ceiling', currency(policy.maxAllocationCents)],
        ]),
        btn('Edit policy', () => editPolicy(policy), { class: 'primary' }),
      ),
    ),
  );
  body.append(
    panel(
      'Employee budgets and grants',
      resourceList(roster, (a) => rowChoice(a.name, a.role, () => employeeAuthority(a.id)), 'No employees.'),
    ),
  );
}
function editPolicy(p) {
  const ceo = el('input', { type: 'checkbox', name: 'allowCeoPromotions' });
  ceo.checked = p.allowCeoPromotions;
  form(
    'Company policy',
    [
      field('Company budget (USD)', usdField('totalBudgetCents', p.totalBudgetCents)),
      field(
        'Maximum direct reports',
        textControl('maxDirectReports', p.maxDirectReports, { type: 'number', min: 1, step: '1' }),
      ),
      field('Allocation ceiling (USD)', usdField('maxAllocationCents', p.maxAllocationCents)),
      el('label', {}, ceo, ' Allow the CEO to approve promotions within policy'),
    ],
    'Save policy',
    saveAndClose((data) =>
      change('policy.set', {
        totalBudgetCents: centsOf(data, 'totalBudgetCents'),
        maxAllocationCents: centsOf(data, 'maxAllocationCents'),
        maxDirectReports: Number(data.get('maxDirectReports')),
        allowCeoPromotions: data.has('allowCeoPromotions'),
      }),
    ),
  );
}
async function employeeAuthority(employeeId) {
  const { grant, budget } = await api('governance.get', { employeeId });
  const employee = person(employeeId);
  const controls = el('div', { class: 'actions' });
  if (employee?.managerId)
    controls.append(
      btn('Allocate budget', () =>
        form(
          'Allocate budget',
          [
            sectionNote(
              'Transfer existing funds from ' +
                nameOf(employee.managerId) +
                ' to ' +
                nameOf(employeeId) +
                '.',
            ),
            field('Amount (USD)', usdField('amount', 0)),
          ],
          'Allocate',
          async (data) => {
            await change('budget.allocate', { employeeId, amountCents: centsOf(data, 'amount') });
            await employeeAuthority(employeeId);
          },
        ),
      ),
    );
  if (grant?.active)
    controls.append(
      btn(
        'Revoke hiring authority',
        () =>
          form(
            'Revoke hiring authority',
            [
              sectionNote(
                'Revoke ' + nameOf(employeeId) + '’s hiring grant. Current work and reports are preserved.',
              ),
            ],
            'Revoke grant',
            async () => {
              await change('grant.revoke', { employeeId });
              await employeeAuthority(employeeId);
            },
          ),
        { class: 'danger' },
      ),
    );
  if (employeeId === 'ceo' && grant && !grant.active)
    controls.append(
      btn('Restore CEO grant', () =>
        form(
          'Restore CEO grant',
          [sectionNote('Restore the CEO’s hiring authority within the current company policy.')],
          'Restore grant',
          async () => {
            await change('grant.restore', { employeeId });
            await employeeAuthority(employeeId);
          },
        ),
      ),
    );
  showDialog(
    'Authority and budget',
    sectionNote(nameOf(employeeId)),
    el('h3', {}, 'Budget'),
    facts([
      ['Available', currency(budget.availableCents)],
      ['Reserved', currency(budget.reservedCents)],
      ['Spent', currency(budget.spentCents)],
      ['Delegated', currency(budget.delegatedCents)],
      ['Received', currency(budget.receivedCents)],
    ]),
    el('h3', {}, 'Hiring grant'),
    grant
      ? facts([
          ['Status', grant.active ? 'Active' : 'Revoked'],
          ['Project', grant.projectId === '*' ? 'All projects' : grant.projectId],
          ['Permitted roles', grant.roles.includes('*') ? 'All roles' : grant.roles.join(', ')],
          ['Direct report limit', grant.maxDirectReports],
          ['Allocation ceiling', currency(grant.maxAllocationCents)],
          ['Already allocated', currency(grant.allocatedCents)],
        ])
      : sectionNote('Individual contributor. No hiring grant.'),
    controls,
  );
}
async function promotionsPage(body, token) {
  const rows = await collect('promotion.list', 'proposals');
  if (token !== revision) return;
  actions.append(btn('Propose promotion', promotionCandidate, { class: 'primary' }));
  body.append(
    panel(
      'Promotion proposals',
      resourceList(
        rows,
        (p) => rowChoice(nameOf(p.employeeId), p.firstHireCase, () => proposalDialog(p), status(p.status)),
        'No promotion proposals.',
      ),
    ),
  );
}
function promotionCandidate() {
  const people = activeEmployees().filter((a) => a.id !== 'ceo');
  if (!people.length) {
    showDialog('Propose promotion', empty('A non-CEO employee is needed to propose a promotion.'));
    return;
  }
  form(
    'Select a candidate',
    [
      field(
        'Employee',
        optionSelect(
          'id',
          people.map((a) => [a.id, a.name + ' · ' + a.role]),
        ),
      ),
    ],
    'Continue',
    (data) => promotionForm(data.get('id')),
  );
}
async function promotionForm(employeeId) {
  const evidence = await collect('task.list', 'tasks', { assigneeId: employeeId, status: 'done' });
  if (!evidence.length) {
    showDialog(
      'Propose promotion',
      sectionNote(nameOf(employeeId)),
      empty('This employee needs a completed, independently reviewed task.'),
    );
    return;
  }
  form(
    'Propose promotion',
    [
      sectionNote(nameOf(employeeId)),
      checks(
        'Completed work',
        'taskIds',
        evidence.map((t) => [t.id, t.title]),
      ),
      field('First hire case', textControl('firstHireCase', '', { multiline: true })),
      field('Project ID', textControl('projectId', '')),
      field('Permitted roles, separated by commas', textControl('roles', '')),
      field('Direct report limit', textControl('reports', 1, { type: 'number', min: 1, step: '1' })),
      field('Allocation ceiling (USD)', usdField('alloc', 0)),
    ],
    'Submit proposal',
    saveAndClose((data) =>
      change('promotion.propose', {
        employeeId,
        evidenceTaskIds: data.getAll('taskIds'),
        firstHireCase: data.get('firstHireCase'),
        projectId: data.get('projectId'),
        roles: data
          .get('roles')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        maxDirectReports: Number(data.get('reports')),
        maxAllocationCents: centsOf(data, 'alloc'),
      }),
    ),
  );
}
function proposalDialog(p) {
  showDialog(
    'Promotion proposal',
    facts([
      ['Candidate', nameOf(p.employeeId)],
      ['Proposed by', nameOf(p.proposedBy)],
      ['Status', label(p.status)],
      ['First hire case', p.firstHireCase],
      ['Project', p.projectId],
      ['Roles', p.roles.join(', ')],
      ['Direct report limit', p.maxDirectReports],
      ['Allocation ceiling', currency(p.maxAllocationCents)],
      ['Approved by', p.approvedBy && nameOf(p.approvedBy)],
    ]),
    el('h3', {}, 'Completed work'),
    el(
      'div',
      { class: 'actions' },
      p.evidenceTaskIds.map((id, i) => btn('Inspect evidence ' + (i + 1), () => showWork('tasks', id))),
    ),
    p.status === 'pending'
      ? btn(
          'Approve promotion',
          () =>
            form(
              'Approve promotion',
              [
                sectionNote(
                  'Grant ' +
                    nameOf(p.employeeId) +
                    ' the project-scoped hiring authority shown in this proposal.',
                ),
              ],
              'Confirm approval',
              saveAndClose(() => change('promotion.approve', { proposalId: p.id })),
            ),
          { class: 'primary' },
        )
      : null,
  );
}
