import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { eventRows } from './company-events.mjs';

export const filePartBytes = 60 * 1024;
const maxParts = 256;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function pathName(path, prefix = false) {
  if (typeof path !== 'string' || !path.isWellFormed() || path.normalize('NFC') !== path ||
      Buffer.byteLength(path) > 500 || /[\\\u0000-\u001f\u007f]/u.test(path)) fail(400, 'Invalid corporate file path.');
  const parts = path.split('/');
  if (prefix && parts.at(-1) === '') parts.pop();
  if (parts.some(p => !p.trim() || p === '.' || p === '..' || p !== p.trim())) fail(400, 'Invalid corporate file path.');
  return path;
}
export function fileRequest(id) {
  if (typeof id !== 'string' || !/^[\w.:-]{1,160}$/.test(id)) fail(400,'Supply a unique requestId.');
  return id;
}
const summary = r => ({path:r.path, version:r.revision, size:r.size, encoding:r.encoding,
  updatedAt:r.updatedAt, authorId:r.authorId, sha256:r.sha256, parts:r.parts.length});
function bytes(input) {
  if ((typeof input.text === 'string') === (typeof input.contentBase64 === 'string')) fail(400,'Supply text or contentBase64.');
  const b = typeof input.text === 'string' ? Buffer.from(input.text) : Buffer.from(input.contentBase64, 'base64');
  if (typeof input.contentBase64 === 'string' && b.toString('base64') !== input.contentBase64) fail(400,'Invalid base64.');
  if (b.length > filePartBytes) fail(400,'Use files.part and files.commit for larger files.');
  return b;
}
export function localBlobs(root) {
  return {
    async put(key, body) {
      await mkdir(root,{recursive:true,mode:0o700});
      const temporary = join(root,randomUUID());
      await writeFile(temporary,body,{flag:'wx',mode:0o600});
      try { await link(temporary,join(root,key)); } catch(error) { if(error.code !== 'EEXIST') throw error; }
      finally { await unlink(temporary); }
    },
    get: key => readFile(join(root,key)),
  };
}
export function s3Blobs(bucket, client = new S3Client({maxAttempts:3})) {
  return {
    async put(key, Body) {
      try { await client.send(new PutObjectCommand({Bucket:bucket,Key:'objects/'+key,Body,IfNoneMatch:'*',
        ChecksumSHA256:Buffer.from(key,'hex').toString('base64')})); }
      catch (error) { if (error.$metadata?.httpStatusCode !== 412) throw error; }
    },
    async publish(row,read) {
      const Key='company/'+row.path;
      let head;
      try {head=await client.send(new HeadObjectCommand({Bucket:bucket,Key}));}
      catch(error){if(error.$metadata?.httpStatusCode!==404)throw error;}
      if(Number(head?.Metadata?.revision ?? 0)>=row.revision) return;
      const body=Buffer.concat(await Promise.all(row.parts.map(read)));
      if(hash(body)!==row.sha256) fail(503,'File checksum mismatch.');
      try {
        await client.send(new PutObjectCommand({Bucket:bucket,Key,Body:body,
          ContentType:row.encoding==='utf8'?'text/plain; charset=utf-8':'application/octet-stream',
          Metadata:{revision:String(row.revision),sha256:row.sha256},...(head?{IfMatch:head.ETag}:{IfNoneMatch:'*'})}));
      } catch(error) {if([409,412].includes(error.$metadata?.httpStatusCode)) return false;throw error;}
      return true;
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({Bucket:bucket,Key:'objects/'+key}));
      return Buffer.from(await result.Body.transformToByteArray());
    },
  };
}
export function createCompanyFiles({records,blobs,employee}) {
  const receipt = (actor,id) => 'file-request#'+actor+'#'+fileRequest(id);
  const history = path => 'file-history#'+path;
  const revKey = rev => String(rev).padStart(12,'0');
  // The index and immutable bytes are authoritative. A journal also projects the latest
  // committed contents into human-readable S3 keys. A stopped writer can be repaired by the factory.
  async function publish(path) {
    if(!blobs.publish) return;
    for(let i=0;i<4;i++) {
      const pending=await records.get('file-publish',path);
      if(!pending) return;
      const row=await records.get('file-index',path);
      if((await blobs.publish(row,key=>blobs.get(key)))===false) continue;
      if(await records.transact([{pk:'file-publish',sk:path,expect:pending.version,value:null}])) return;
    }
  }
  async function repair() {
    if(!blobs.publish) return;
    const page=await records.list('file-publish',{limit:12});
    await Promise.all(page.items.map(row=>publish(row.sk)));
  }
  async function write(actor,input,multipart) {
    const path = pathName(input.path);
    const request = receipt(actor,input.requestId);
    let parts, encoding;
    if (multipart) {
      if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > maxParts ||
          input.parts.some(digest=>typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) fail(400,'Invalid file parts.');
      parts = input.parts;
      encoding = 'base64';
    } else {
      const b = bytes(input);
      const digest = hash(b);
      await blobs.put(digest,b);
      parts = [digest];
      encoding = input.text === undefined ? 'base64' : 'utf8';
    }
    const signature = hash(JSON.stringify([path,parts,encoding,input.expectedVersion ?? null]));
    let prepared;
    for (let n=0;n<8;n++) {
      const [done,current] = await Promise.all([records.get(request,'receipt'),records.get('file-index',path)]);
      if (done) {
        if(done.signature !== signature) fail(409,'File requestId already used.');
        await publish(path);
        return {file:done.file};
      }
      if(input.expectedVersion !== undefined && input.expectedVersion !== (current?.revision ?? 0)) fail(409,'File version has changed.');
      if (!prepared) {
        const digest = createHash('sha256'); let size = 0;
        for (const part of parts) {
          if(multipart && !(await records.get('file-parts#'+actor,part))) fail(400,'Upload each file part before committing.');
          const b = await blobs.get(part);
          if (hash(b) !== part) fail(503,'File checksum mismatch.');
          digest.update(b); size += b.length;
        }
        prepared = {size,sha256:digest.digest('hex')};
      }
      const v = {path,revision:(current?.revision ?? 0)+1,parts,encoding,authorId:actor,updatedAt:new Date().toISOString(),...prepared};
      const file = summary(v);
      const pending=blobs.publish && await records.get('file-publish',path);
      const journal=blobs.publish?[{pk:'file-publish',sk:path,expect:pending?.version ?? null,value:{revision:v.revision}}]:[];
      if(await records.transact([...journal,{pk:'file-index',sk:path,expect:current?.version ?? null,value:v},
        {pk:history(path),sk:revKey(v.revision),expect:null,value:v},{pk:request,sk:'receipt',expect:null,value:{file,signature}},
        ...eventRows('file.written',{actor},request)])) {await publish(path);return {file};}
    }
    fail(409,'File has concurrent writers. Retry the same request.');
  }
  async function ensureSoul(person) {
    if(!person) fail(404,'Employee not found.');
    const path = 'agents/'+person.handle+'/SOUL.md';
    if(!await records.get('file-index',path)) {
      try { await write(person.id,{path,expectedVersion:0,requestId:'bootstrap-soul',text:'# '+person.name+'\n\nRole: '+person.role+
        '\n\nCarry out the company mandate within this role. Record decisions and handoffs for coworkers.\n'},false); }
      catch(e) { if(e.status !== 409 || !await records.get('file-index',path)) throw e; }
    }
    return path;
  }
  async function execute(actor,op,input) {
    if(op === 'soul.get') return execute(actor,'files.read',{path:await ensureSoul(await employee(input.employeeId ?? actor))});
    if(op === 'files.write' || op === 'files.commit') return write(actor,input,op === 'files.commit');
    if(op === 'files.part') {
      const b = bytes(input), digest = hash(b);
      await blobs.put(digest,b);
      const pk='file-parts#'+actor;
      if(!await records.get(pk,digest)) await records.transact([{pk,sk:digest,expect:null,value:{size:b.length}}]);
      return {sha256:digest,size:b.length};
    }
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit<1 || limit>100 || (input.after !== undefined && (typeof input.after !== 'string' || !input.after.length || Buffer.byteLength(input.after)>512))) fail(400,'Invalid file page.');
    if(op === 'files.list' || op === 'files.versions') {
      const list = op === 'files.list';
      const page=await records.list(list?'file-index':history(pathName(input.path)),{prefix:list?pathName(input.prefix ?? '',true):'',limit,after:input.after});
      return {[list?'files':'versions']:page.items.map(summary),...(page.next && {next:page.next})};
    }
    if(op !== 'files.read') fail(404,'Unknown file operation.');
    const path=pathName(input.path);
    if(input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version<1)) fail(400,'Invalid file version.');
    const r = input.version === undefined ? await records.get('file-index',path) : await records.get(history(path),revKey(input.version));
    if(!r) fail(404,'File or version not found.');
    const file = summary(r);
    if(input.part === undefined && r.parts.length>1) return {file};
    const i=input.part ?? 0;
    if(!Number.isInteger(i) || i<0 || i>=r.parts.length) fail(400,'Invalid part index.');
    const body=await blobs.get(r.parts[i]);
    if(hash(body)!==r.parts[i]) fail(503,'File checksum mismatch.');
    return {file:{...file,...(r.encoding==='utf8' && input.part === undefined ? {text:body.toString()} : {contentBase64:body.toString('base64')})}};
  }
  return {execute,ensureSoul,repair};
}
