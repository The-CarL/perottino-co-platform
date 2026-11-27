import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { author, branchFor, commitMessage, fault, insist, jobSpec, pathFor, shaFormat } from './project-source.mjs';

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
    child.once('close', code => code === 0 ? ok() : fail(fault(503,'Local Git operation failed.')));
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
    repo:'local:projects',
  };
}
