import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { author, branchFor, commitMessage, fault, insist, jobSpec, mergeAttribution, mergeSpec, mergeTrailers, pathFor, reviewSpec, shaFormat } from './project-source.mjs';

async function git(repo, args, input = '', env = {}) {
  const child = spawn('git', ['-c','core.hooksPath=/dev/null','--git-dir='+repo,...args], {
    env:{ PATH:'/usr/bin:/bin', LANG:'C', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
      GIT_TERMINAL_PROMPT:'0', ...env }, stdio:['pipe','pipe','pipe'], timeout:15_000,
  });
  const out = [];
  child.stdout.on('data', part => out.push(part));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const done = new Promise((ok,fail) => {
    child.once('error', fail);
    child.once('close', code => code === 0 ? ok() : fail(Object.assign(fault(503,'Local Git operation failed.'),{gitExitCode:code})));
  });
  child.stdin.end(input);
  await done;
  return Buffer.concat(out).toString('utf8');
}
function identity(at) {
  return { GIT_AUTHOR_NAME:author.name,GIT_AUTHOR_EMAIL:author.email,GIT_AUTHOR_DATE:at,
    GIT_COMMITTER_NAME:author.name,GIT_COMMITTER_EMAIL:author.email,GIT_COMMITTER_DATE:at };
}
export function createLocalProjectGit({ directory }) {
  const repo=resolve(directory);
  let init;
  async function initialize() {
    try { if ((await stat(join(repo,'HEAD'))).isFile()) return; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(dirname(repo),{recursive:true,mode:0o700});
    const temp=await mkdtemp(join(dirname(repo),'.initialize-git-'));
    try {
      await git(temp,['init','--bare','--initial-branch=main',temp]);
      const tree=(await git(temp,['mktree'])).trim();
      const commit=(await git(temp,['commit-tree',tree,'-m','Initialize projects'], '', identity('2001-01-01T00:00:00Z'))).trim();
      await git(temp,['update-ref','refs/heads/main',commit]);
      try { await rename(temp,repo); } catch (error) {
        if (!['ENOTEMPTY','EEXIST'].includes(error.code)) throw error;
      }
    } finally { await rm(temp,{recursive:true,force:true}); }
  }
  function ready() { return init ??= initialize().catch(error=>{init=undefined;throw error;}); }
  async function publishRef(ref, sha) {
    try { await git(repo,['update-ref',ref,sha,'0'.repeat(40)]); }
    catch (error) {
      const existing=(await git(repo,['rev-parse','--verify',ref])).trim();
      insist(existing===sha,409,'Existing job branch has different content.');
    }
  }
  function localHandoff(input) {
    const handoff = mergeSpec(input, 'local:projects');
    insist(handoff.pr.number === parseInt(handoff.jobId.slice(2,14),16) + 1, 409, 'Local PR number does not match the job.');
    return handoff;
  }
  async function readPull(handoff, additionalRef) {
    const {branch,jobId,sha} = handoff;
    const head = 'refs/heads/' + branch;
    const review = 'refs/perottino/reviews/' + jobId;
    const merged = 'refs/perottino/merges/' + jobId;
    const output = await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', head, review, merged, additionalRef]);
    const refs = new Map(output.trim().split('\n').map(line => line.split(' ')));
    insist(refs.get(head) === sha && refs.get(review) === sha, 409, 'Local PR no longer matches the reviewed commit.');
    return {refs,head,review,merged};
  }
  return {
    async head() {
      await ready();
      return (await git(repo,['rev-parse','--verify','refs/heads/main'])).trim();
    },
    async deliver(input) {
      const job=jobSpec(input);await ready();
      const prefix=pathFor(job.projectId)+'/';
      const temp=await mkdtemp(join(tmpdir(),'perottino-job-'));
      try {
        // The private Git index is this job's working copy. No project files execute or touch the host filesystem.
        const env={GIT_INDEX_FILE:join(temp,'index'),...identity(job.createdAt)};
        await git(repo,['read-tree',job.baseSha],'',env);
        const previous=await git(repo,['ls-tree','-r','--name-only','-z',job.baseSha,'--',prefix]);
        const entries=previous.split('\0').filter(Boolean).map(path=>'0 '+ '0'.repeat(40)+'\t'+path+'\0');
        for (const file of job.files) {
          const blob=(await git(repo,['hash-object','-w','--stdin'],file.content)).trim();
          entries.push('100644 '+blob+'\t'+prefix+file.path+'\0');
        }
        await git(repo,['update-index','-z','--index-info'],entries.join(''),env);
        const tree=(await git(repo,['write-tree'],'',env)).trim();
        const sha=(await git(repo,['commit-tree',tree,'-p',job.baseSha,'-m',commitMessage(job)],'',env)).trim();
        insist(shaFormat.test(sha),503,'Git did not return a commit.');
        const branch=branchFor(job);
        await publishRef('refs/heads/'+branch,sha);
        await publishRef('refs/perottino/reviews/'+job.jobId,sha);
        return {repo:'local:projects',path:pathFor(job.projectId),baseSha:job.baseSha,branch,sha,
          pr:{number:parseInt(job.jobId.slice(2,14),16)+1,url:null,local:true}};
      } finally { await rm(temp,{recursive:true,force:true}); }
    },
    async publishReview(input, assessment) {
      const handoff = localHandoff(input);
      const {reviewId,reviewerId,decision} = reviewSpec(assessment);
      await ready();
      const {jobId,sha,pr} = handoff;
      const ref = 'refs/perottino/peer-reviews/' + jobId + '/' + reviewId;
      const value = JSON.stringify({reviewId,reviewerId,decision,sha,prNumber:pr.number});
      const blob = (await git(repo, ['hash-object','-w','--stdin'],value)).trim();
      const receipt = {id:reviewId,url:null,sha,prNumber:pr.number,state:'COMMENTED'};
      for (let attempt = 0; attempt < 6; attempt++) {
        const {refs,head,review,merged} = await readPull(handoff,ref);
        if (refs.has(ref)) {
          insist(refs.get(ref) === blob, 409, 'Local PR review ID already has a different decision.');
          return receipt;
        }
        insist(!refs.has(merged), 409, 'Local pull request has already merged.');
        const tx = ['verify '+head+' '+sha, 'verify '+review+' '+sha, 'verify '+merged+' '+'0'.repeat(40), 'create '+ref+' '+blob];
        try {
          await git(repo,['update-ref','--stdin'],tx.join('\n')+'\n');
          return receipt;
        } catch (error) {
          if (attempt === 5) throw error;
        }
      }
    },
    async merge(input, attribution) {
      const actors = mergeAttribution(attribution);
      const handoff = localHandoff(input);
      const {sha,pr} = handoff;
      await ready();
      const main = 'refs/heads/main';
      for (let attempt = 0; attempt < 6; attempt++) {
        const {refs,head,review,merged} = await readPull(handoff,main);
        if (refs.has(merged)) return {sha, mergeSha:refs.get(merged), prNumber:pr.number};
        const base = refs.get(main);
        insist(shaFormat.test(base), 503, 'Local default branch is unavailable.');
        let mergeSha = sha;
        const common = (await git(repo, ['merge-base', base, sha])).trim();
        if (common !== sha) {
          let tree;
          try {
            tree = (await git(repo, ['merge-tree', '--write-tree', '--no-messages', base, sha])).trim();
          } catch (error) {
            if (error.gitExitCode === 1) throw fault(409, 'Local pull request has merge conflicts.');
            throw error;
          }
          insist(shaFormat.test(tree), 503, 'Invalid local merge tree.');
          const message = 'Merge project PR ' + pr.number + (actors ? '\n\n' + mergeTrailers(actors) : '');
          mergeSha = (await git(repo, ['commit-tree', tree, '-p', base, '-p', sha, '-m', message],
            '', identity(new Date().toISOString()))).trim();
        }
        // Compare all refs and record completion atomically, including when another PR has incorporated this head.
        const update = common === sha ? 'verify ' + main + ' ' + base : 'update ' + main + ' ' + mergeSha + ' ' + base;
        const transaction = ['verify ' + head + ' ' + sha, 'verify ' + review + ' ' + sha, update, 'create ' + merged + ' ' + mergeSha];
        try {
          await git(repo, ['update-ref','--stdin'], transaction.join('\n') + '\n');
          return {sha, mergeSha, prNumber:pr.number};
        } catch (error) {
          if (attempt === 5) throw error;
          // A concurrent merge may have advanced main or written the receipt. Rebuild against the current refs.
        }
      }
    },
    repo:'local:projects',
  };
}
