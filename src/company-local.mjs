import { join } from 'node:path';
import { makeSqliteRecords } from './foundation-records.mjs';
import { createCompanyService } from './company-service.mjs';
import { runCompanyPulse } from './company-worker.mjs';

import { reconcileInfrastructure } from './company-infrastructure.mjs';
import { expirePreviews } from './company-deployments.mjs';
import { localAdapters } from './company-adapters.mjs';

function denied() { return Object.assign(new Error('Employee action denied.'), { status: 403 }); }

export function createLocalCompany({ dataDir, store, mode = 'local', decide, browse, turnTimeoutMs }) {
  const records = makeSqliteRecords({ filename: join(dataDir, 'company.sqlite') });
  const resources=localAdapters({dataDir,records});
  const {adapters}=resources;
  const active = new Map();
  const pending = new Set();
  const nextPulse = new Map();
  let scheduled, stopping = false;

  function controlFor(binding) {
    return (actor, op, input, permit) => {
      const operation = op.slice('employee.'.length);
      if (operation === 'hire') {
        if (actor !== 'owner' && (!binding || actor !== binding.id)) throw denied();
        const employee = store.hireCompanyEmployee(actor, binding?.generation, input, permit);
        wake();
        return { employee };
      }
      if (actor !== 'owner' && (!binding || binding.id !== actor || operation !== 'fire')) throw denied();
      const result = store.setEmployeeState({ governancePermit:permit, agentId: input.agentId, operation,
        requestId: 'company/' + actor + '/' + input.requestId,
        ...(actor !== 'owner' && { callerId: actor, generation: binding.generation }) });
      if (!result.ok) throw Object.assign(new Error('Employment change declined.'), { status: result.status });
      if (result.employee.desiredState !== 'active') suspend(result.employee.id);
      wake();
      return { employee: result.employee };
    };
  }

  const company = createCompanyService({ records, store, adapters, control: controlFor() });
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
    const service = createCompanyService({ records: guarded, store, adapters, control: controlFor(person) });
    return runCompanyPulse({ actor: person, mode, decide, browse, signal, workerId: 'local-' + person.id,
      onSettings:runtime=>nextPulse.set(person.id,Date.now()+1000*(runtime?.settings?.pulseSeconds ?? 30)),
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
  function wake(onlyDue=false) {
    if (stopping || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      for (const employee of store.listEmployees()) {
        if (employee.desiredState === 'active' && (!onlyDue || (nextPulse.get(employee.id) ?? 0)<=Date.now()) && !active.has(employee.id)) pending.add(employee.id);
      }
      pump();
    });
  }
  const timer = setInterval(()=>wake(true), 5000);
  let maintenance;
  const cleanup = setInterval(()=>{
    maintenance ??= Promise.all([reconcileInfrastructure(records,adapters.infrastructure),expirePreviews(records)])
      .catch(()=>console.error('Local project expiry check failed.')).finally(()=>{maintenance=undefined;});
  },300000);
  cleanup.unref();
  timer.unref();
  wake();
  return { company, wake, suspend, start:resources.listen, close: records.close, async stop() {
    stopping = true;
    clearInterval(timer);
    clearInterval(cleanup);
    await maintenance;
    clearImmediate(scheduled);
    pending.clear();
    const jobs = [...active.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.done));
    await resources.close();
  } };
}
