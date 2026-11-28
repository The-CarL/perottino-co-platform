'use strict';

function routeOption(key) {
  return new URLSearchParams(location.hash.split('?')[1] || '').get(key);
}

function routeTo(section, params) {
  return '#' + section + '?' + new URLSearchParams(params).toString();
}

function optionSelect(name, choices, selected, required = true) {
  const control = select(name, choices);
  control.required = required;
  if (selected !== undefined && selected !== null) control.value = String(selected);
  return control;
}

function textControl(name, value = '', options = {}) {
  const control = options.multiline
    ? el('textarea', { name, rows: options.rows || 4 })
    : el('input', { name, type: options.type || 'text' });
  control.value = value == null ? '' : String(value);
  control.required = options.required !== false;
  if (options.max) control.maxLength = options.max;
  if (options.min !== undefined) control.min = options.min;
  if (options.step) control.step = options.step;
  return control;
}

function rowChoice(title, detail, open, trailing) {
  return el(
    'li',
    {},
    el(
      'button',
      { type: 'button', class: 'resource-row', onClick: open },
      el(
        'span',
        { class: 'resource-copy' },
        el('strong', {}, title),
        detail ? el('small', {}, detail) : null,
      ),
      trailing,
    ),
  );
}

function resourceList(items, view, emptyText) {
  return items.length ? el('ul', { class: 'resource-list' }, items.map(view)) : empty(emptyText);
}

function saveAndClose(fn) {
  return async (data) => {
    await fn(data);
    await render();
  };
}

function webLink(url, title, local = false) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url, local ? location.origin : undefined);
  } catch {
    return null;
  }
  const sameOrigin = local && parsed.origin === location.origin;
  const loopback = local && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (sameOrigin || loopback)))
  )
    return null;
  return el('a', { href: parsed.href, target: '_blank', rel: 'noopener noreferrer' }, title);
}

function sectionNote(text) {
  return el('p', { class: 'section-note' }, text);
}
