import { join } from 'node:path';
import { makeSqliteRecords } from './foundation-records.mjs';
import { createCompanyService } from './company-service.mjs';
import { runCompanyPulse } from './company-worker.mjs';

function denied() { return Object.assign(new Error('Employee action denied.'), { status: 403 }); }

export function createLocalCompany({ dataDir, store, mode = 'local', decide, browse, turnTimeoutMs }) {
  const records = makeSqliteRecords({ filename: join(dataDir, 'company.sqlite') });
  const active = new Map();
  const pending = new Set();
  let scheduled, stopping = false;

  function controlFor(binding) {
    return (actor, op, input) => {
      const operation = op.slice('employee.'.length);
      if (operation === 'hire') {
        if (actor !== 'owner' && (!binding || actor !== binding.id)) throw denied();
        const employee = store.hireCompanyEmployee(actor, binding?.generation, input);
        wake();
        return { employee };
      }
      if (actor !== 'owner' && (!binding || binding.id !== actor || operation !== 'fire')) throw denied();
      const result = store.setEmployeeState({ agentId: input.agentId, operation,
        requestId: 'company/' + actor + '/' + input.requestId,
        ...(actor !== 'owner' && { callerId: actor, generation: binding.generation }) });
      if (!result.ok) throw Object.assign(new Error('Employment change declined.'), { status: result.status });
      if (result.employee.desiredState !== 'active') suspend(result.employee.id);
      wake();
      return { employee: result.employee };
    };
  }

  const company = createCompanyService({ records, store, control: controlFor() });
  function suspend(id) {
    pending.delete(id);
    active.get(id)?.controller.abort();
  }
  function pulse(person, signal) {
    function check() {
      signal.throwIfAborted();
      const current = store.employee(person.id);
      if (current?.desiredState !== 'active' || current.generation !== person.generation) throw denied();
    }
    // Recheck the binding inside each SQLite write transaction, including after asynchronous model/tool calls.
    const guarded = { get: records.get, list: records.list, transact: changes => records.transact(changes, check) };
    const service = createCompanyService({ records: guarded, store, control: controlFor(person) });
    return runCompanyPulse({ actor: person, mode, decide, browse, signal, workerId: 'local-' + person.id,
      execute(op, input) { check(); return service.execute(person.id, op, input); } });
  }
  function pump() {
    while (!stopping && active.size < 4 && pending.size) {
      const id = pending.values().next().value;
      pending.delete(id);
      const person = store.employee(id);
      if (!person || person.desiredState !== 'active' || active.has(id)) continue;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(turnTimeoutMs)]);
      const done = Promise.resolve().then(() => pulse(person, signal)).then(state => {
        const prior = store.getPulse(id);
        if (state === 'worked' || prior?.generation !== person.generation || Date.now() - prior.at >= 120_000) {
          store.recordLocalPulse(id, person.generation, state);
        }
        if (state === 'worked') wake();
      }).catch(() => {
        // Back off until the next poll. Durable leases and journals retain interrupted work.
        if (!stopping && !controller.signal.aborted) console.error('Local company employee pulse failed.');
      }).finally(() => { active.delete(id); pump(); });
      active.set(id, { controller, done });
    }
  }
  function wake() {
    if (stopping || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      for (const employee of store.listEmployees()) {
        if (employee.desiredState === 'active' && !active.has(employee.id)) pending.add(employee.id);
      }
      pump();
    });
  }
  const timer = setInterval(wake, 5000);
  timer.unref();
  wake();
  return { company, wake, suspend, close: records.close, async stop() {
    stopping = true;
    clearInterval(timer);
    clearImmediate(scheduled);
    pending.clear();
    const jobs = [...active.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
  } };
}
