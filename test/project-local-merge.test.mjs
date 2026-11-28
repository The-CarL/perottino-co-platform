import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createLocalProjectGit} from '../src/project-git-local.mjs';

const exec = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'perottino-local-peer-merge-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const repo = join(directory, 'projects.git');
  const open = () => createLocalProjectGit({directory:repo});
  const git = open();
  const initial = await git.head();
  const inspect = async (...args) => (await exec('git', ['--git-dir='+repo, ...args])).stdout.trim();
  async function deliver(project, jobDigit, content) {
    const job = {
      agentId:'engineer', taskId:'task-'+jobDigit,
      projectId:'p-'+project.repeat(32), jobId:'j-'+jobDigit.repeat(32),
      createdAt:'2026-01-12T12:00:00.000Z', baseSha:initial,
      files:[{path:'public/index.html', content}],
    };
    return {...job, ...await git.deliver(job)};
  }
  return {open, git, initial, inspect, deliver};
}

test('concurrent local PR merges preserve both projects and replay their individual Git receipts', async t => {
  const {open, git, initial, inspect, deliver} = await fixture(t);
  const [a,b] = await Promise.all([deliver('a','1','First app'), deliver('b','2','Second app')]);
  const actors = {reviewerId:'reviewer', mergedBy:'ceo'};
  const [first,second,duplicate] = await Promise.all([git.merge(a,actors), open().merge(b), open().merge(a,actors)]);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await open().merge(a), first);
  assert.deepEqual(await open().merge(b), second);
  assert.equal(first.sha, a.sha);
  assert.equal(first.prNumber, a.pr.number);
  assert.equal(await inspect('rev-parse', first.mergeSha + '^2'), a.sha);
  assert.match(await inspect('show', '-s', '--format=%B', first.mergeSha), /Project-Reviewer: reviewer\nProject-Merger: ceo/);
  assert.equal(await inspect('rev-parse', second.mergeSha + '^2'), b.sha);
  assert.equal(await inspect('rev-list', '--first-parent', '--count', initial+'..main'), '2');
  assert.equal(await inspect('show', 'main:'+a.path+'/public/index.html'), 'First app');
  assert.equal(await inspect('show', 'main:'+b.path+'/public/index.html'), 'Second app');
});

test('a conflict or ref mismatch cannot move main or create a merge receipt', async t => {
  const {git, initial, inspect, deliver} = await fixture(t);
  const a = await deliver('a','1','First version');
  const b = await deliver('a','2','Conflicting version');
  const id = await git.merge(a);
  const conflict = err => err.status === 409;
  await assert.rejects(git.merge(b), conflict);
  assert.equal(await git.head(), id.mergeSha);
  assert.equal(await inspect('for-each-ref','--format=%(objectname)','refs/perottino/merges/'+b.jobId), '');

  await inspect('update-ref', 'refs/heads/'+b.branch, initial, b.sha);
  await assert.rejects(git.merge(b), conflict);
  await inspect('update-ref', 'refs/heads/'+b.branch, b.sha, initial);
  await inspect('update-ref', 'refs/perottino/reviews/'+b.jobId, initial, b.sha);
  await assert.rejects(git.merge(b), conflict);
  assert.equal(await git.head(), id.mergeSha);
});

test('a local peer review records the exact decision once and rejects a changed head or decision on retry', async t => {
  const {git, open, initial, inspect, deliver} = await fixture(t);
  const handoff = await deliver('a','1','An app');
  const reviewId = 'r-' + 'd'.repeat(32);
  const review = {reviewerId:'reviewer', decision:'approve', reviewId};
  const receipt = {id:reviewId, url:null, sha:handoff.sha, prNumber:handoff.pr.number,state:'COMMENTED'};
  assert.deepEqual(await Promise.all([git.publishReview(handoff,review), open().publishReview(handoff,review)]), [receipt, receipt]);
  const marker = 'refs/perottino/peer-reviews/'+handoff.jobId+'/'+reviewId;
  assert.deepEqual(JSON.parse(await inspect('cat-file','-p',marker)), {...review,sha:handoff.sha,prNumber:handoff.pr.number});
  assert.equal(await git.head(), initial);

  const conflict = err => err.status === 409;
  await assert.rejects(git.publishReview(handoff,{...review,decision:'changes'}), conflict);
  await inspect('update-ref','refs/heads/'+handoff.branch,initial,handoff.sha);
  await assert.rejects(git.publishReview(handoff,review), conflict);
  await inspect('update-ref','refs/heads/'+handoff.branch,handoff.sha,initial);
  await git.merge(handoff);
  assert.deepEqual(await open().publishReview(handoff,review),receipt);
  await assert.rejects(git.publishReview(handoff,{...review,reviewId:'r-'+'e'.repeat(32)}), conflict);
});
