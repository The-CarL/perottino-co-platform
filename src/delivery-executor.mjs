import { posix } from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { sourceFiles } from './project-source.mjs';
import { buildReasons, publicFiles, templateId } from './static-template.mjs';

const testModule = `
let passed = 0;
export function test(name, fn) {
  if (typeof name !== 'string' || typeof fn !== 'function') throw Error();
  const result = fn();
  if (result && typeof result.then === 'function') throw Error();
  if (++passed > 1024) throw Error();
}
export {passed as count};
export default test;
`;
const assertModule = `
export function ok(value) { if (!value) throw Error(); }
export function strictEqual(a,b) { if (!Object.is(a,b)) throw Error(); }
function same(a,b) {
  if (Object.is(a,b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a)!==Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length===Object.keys(b).length && keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
}
export function deepStrictEqual(a,b) { if (!same(a,b)) throw Error(); }
export default Object.assign(ok,{ok,strictEqual,deepStrictEqual,equal:strictEqual,deepEqual:deepStrictEqual});
`;
const builtin = new Map([['node:test',testModule], ['node:assert/strict',assertModule]]);
const fail = reason => { throw new Error(reason); };

// Project source executes only inside a new WebAssembly guest. None of Node's
// objects, environment, filesystem, AWS SDK, sockets, timers or callbacks are injected.
async function evaluate(files, source, phase, deadline) {
  const engine = await getQuickJS();
  const rt = engine.newRuntime();
  rt.setMemoryLimit(16 * 1024 * 1024);
  rt.setMaxStackSize(256 * 1024);
  rt.setInterruptHandler(() => performance.now() >= deadline);
  const ctx = rt.newContext();
  let badModule = false;
  const unknown = () => { badModule = true; throw new Error('invalid_module'); };
  rt.setModuleLoader(name => {
    if (builtin.has(name)) return builtin.get(name);
    const content = files.get(name);
    if (content === undefined) return unknown();
    if (name.endsWith('.json')) return 'export default JSON.parse(' + JSON.stringify(content) + ')';
    return content;
  }, (base, name) => {
    if (builtin.has(name)) return name;
    if (!/^\.\.?\//.test(name) || name.includes('\\')) return unknown();
    const resolved = posix.join(posix.dirname(base),name);
    if (!files.has(resolved) || !/\.(?:m?js|json)$/.test(resolved)) return unknown();
    return resolved;
  });
  try {
    const result = ctx.evalCode(source, '__entry.mjs', { type: 'module' });
    if (result.error) {
      result.error.dispose();
      fail(performance.now() >= deadline ? 'time_limit' : badModule ? 'invalid_module' : phase);
    }
    try {
      const state = ctx.getPromiseState(result.value);
      if (state.type !== 'fulfilled' || !state.notAPromise || rt.hasPendingJob()) {
        state.error?.dispose();
        if (state.value && !state.notAPromise) state.value.dispose();
        fail(phase);
      }
      const output = ctx.getProp(result.value,'output');
      try {
        if (phase==='test_failed') {
          if(ctx.typeof(output)!=='number') fail(phase);
          return ctx.getNumber(output);
        }
        if (ctx.typeof(output) !== 'string') fail(phase);
        return ctx.getString(output);
      } finally { output.dispose(); }
    } finally { result.value.dispose(); }
  } finally { ctx.dispose(); rt.dispose(); }
}

export async function handler({ template, files } = {}) {
  try {
    if (template !== templateId) fail('invalid_source');
    let source;
    try { source = sourceFiles(files); } catch { fail('invalid_source'); }
    const modules = new Map(source.map(({path,content}) => [path,content]));
    const tests = [...modules.keys()].filter(name => /^test\/.+\.test\.m?js$/.test(name));
    if (!tests.length) fail('missing_tests');
    const deadline = performance.now() + 1800;
    if (modules.has('build.mjs')) {
      const built = await evaluate(modules, "import build from './build.mjs'; export const output=JSON.stringify(build());",
        'build_failed',deadline);
      let outputs;
      try { outputs = sourceFiles(JSON.parse(built)); } catch { fail('invalid_public_files'); }
      for (const file of outputs) {
        if (!file.path.startsWith('public/')) fail('invalid_public_files');
        modules.set(file.path,file.content);
      }
    }
    let output;
    try { output = publicFiles([...modules].map(([path,content])=>({path,content}))); } catch { fail('invalid_public_files'); }
    const suite = tests.map(path => 'import ' + JSON.stringify('./' + path) + ';').join('\n');
    const count = Number(await evaluate(modules, suite + "\nimport {count} from 'node:test'; export {count as output};",
      'test_failed',deadline));
    if (!Number.isInteger(count) || count < 1 || count > 1024) fail('missing_tests');
    return { status:'passed', testsPassed:count, files:output };
  } catch (error) {
    return { status:'failed', testsPassed:0, reason:buildReasons.has(error?.message) ? error.message : 'invalid_result' };
  }
}
