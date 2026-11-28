import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
function requireValue(condition,message) { if (!condition) throw new Error(message); }
async function cli(service, operation, ...args) {
  try {
    const {stdout} = await run('aws',[service,operation,...args,'--output','json','--no-cli-pager'],{
      timeout:90_000,maxBuffer:2*1024*1024,env:{...process.env,AWS_PAGER:''},
    });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const code = /\(([A-Za-z0-9_.-]+)\)/.exec(error.stderr??'')?.[1] ?? 'CLIError';
    throw Object.assign(new Error(service+'.'+operation+' failed ('+code+').'),{code});
  }
}
export async function stageHostedTemplate({assembly,account,region,scope,source,bootstrapStack},aws=cli) {
  requireValue(/^[0-9]{12}$/.test(account??'') && /^[a-z]{2}-[a-z]+-[1-9][0-9]*$/.test(region??'') &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-z][a-z0-9-]{0,30}$/.test(scope??'') &&
    /^[0-9a-f]{40}$/.test(source??''),'Select the release account, commercial region, project scope and full source SHA.');
  const hostedStack='factory-'+scope+'-r-events';
  bootstrapStack ??= 'factory-'+scope+'-r-runtime';
  requireValue(/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(bootstrapStack),'Invalid bootstrap stack name.');
  const manifest=JSON.parse(await readFile(join(assembly,'manifest.json'),'utf8'));
  const target=manifest.artifacts?.Hosted;
  requireValue(target?.environment==='aws://'+account+'/'+region && target.properties?.stackName===hostedStack &&
    target.properties.templateFile==='Hosted.template.json','Assembly does not match the selected account, region and hosted stack.');
  const bytes=await readFile(join(assembly,target.properties.templateFile));
  requireValue(bytes.length>0 && bytes.length<=1024*1024,'Template exceeds the 1 MiB CloudFormation S3 limit.');
  const resources=JSON.parse(bytes).Resources;
  const app=resources?.WebFn?.Properties;
  const worker=resources?.WorkerTask?.Properties?.ContainerDefinitions?.[0];
  requireValue(app?.Environment?.Variables?.PEROTTINO_SCOPE===scope && app.Environment.Variables.PEROTTINO_RELEASE===source &&
    worker?.Environment?.some(e=>e.Name==='PEROTTINO_RELEASE' && e.Value===source),'Template provenance does not match the selected project and source commit.');
  const request=(service,op,...args)=>aws(service,op,'--region',region,...args);
  const identity=await request('sts','get-caller-identity');
  requireValue(identity.Account===account,'AWS caller account does not match the assembly.');
  const {Stacks}=await request('cloudformation','describe-stacks','--stack-name',bootstrapStack);
  const stack=Stacks?.[0],tags=Object.fromEntries((stack?.Tags??[]).map(t=>[t.Key,t.Value]));
  requireValue(stack?.StackName===bootstrapStack && stack.StackId?.startsWith('arn:aws:cloudformation:'+region+':'+account+':stack/'+bootstrapStack+'/') &&
    tags['factory:s']===scope && ['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus),'Bootstrap stack is not ready for this scope.');
  const outputs=Object.fromEntries((stack.Outputs??[]).map(o=>[o.OutputKey,o.OutputValue]));
  const bucket=outputs.ReleaseTemplateBucketName, registry=outputs.ImageRepositoryUri;
  requireValue(typeof bucket==='string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket),'Update runtime-bootstrap.yaml to provision the private release bucket.');
  const digest='@sha256:',images=[app.Code?.ImageUri,worker.Image];
  requireValue(typeof registry==='string' && registry.startsWith(account+'.dkr.ecr.'+region+'.amazonaws.com/') &&
    images.every(x=>typeof x==='string' && x.startsWith(registry+digest) && /^[a-f0-9]{64}$/.test(x.slice(registry.length+digest.length))),
    'Template images are not pinned to the selected release registry.');
  const bucketArgs=['--bucket',bucket,'--expected-bucket-owner',account];
  const s3=(op,...args)=>request('s3api',op,...bucketArgs,...args);
  const [bt,loc,v,p]=await Promise.all([s3('get-bucket-tagging'),s3('get-bucket-location'),s3('get-bucket-versioning'),s3('get-public-access-block')]);
  const btMap=Object.fromEntries((bt.TagSet??[]).map(t=>[t.Key,t.Value]));
  const location=loc.LocationConstraint==='EU'?'eu-west-1':loc.LocationConstraint??'us-east-1';
  requireValue(btMap['factory:s']===scope && btMap['perottino:purpose']==='release-templates' && location===region &&
    v.Status==='Enabled' && ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']
      .every(k=>p.PublicAccessBlockConfiguration?.[k]===true),'Release bucket ownership, region, versioning or public-access controls do not match.');
  const checksum=createHash('sha256').update(bytes).digest(), sha256=checksum.toString('hex');
  const key='releases/'+source+'/'+sha256+'/Hosted.template.json';
  const folder=await mkdtemp(join(tmpdir(),'perottino-release-'));
  let published;
  try {
    const file=join(folder,'template.json');
    await writeFile(file,bytes,{mode:0o600,flag:'wx'});
    try {
      published=await s3('put-object','--key',key,'--body',file,'--if-none-match','*','--server-side-encryption','AES256',
        '--content-type','application/json','--checksum-sha256',checksum.toString('base64'),
        '--tagging',new URLSearchParams({'factory:s':scope,'factory:last-source-commit':source}).toString());
    } catch (error) {
      if (error.code!=='PreconditionFailed') throw error;
    }
  } finally { await rm(folder,{recursive:true,force:true}); }
  if (published) requireValue(typeof published.VersionId==='string' && published.VersionId!=='null','S3 did not return a pinned version.');
  const head=await s3('head-object','--key',key,'--checksum-mode','ENABLED',...(published?['--version-id',published.VersionId]:[]));
  requireValue(typeof head.VersionId==='string' && head.VersionId.length>0 && head.VersionId!=='null' &&
    (!published || head.VersionId===published.VersionId) && head.ChecksumSHA256===checksum.toString('base64') &&
    head.ServerSideEncryption==='AES256' && head.ContentLength===bytes.length,'S3 did not verify the expected immutable release bytes.');
  const url=new URL('https://s3.'+region+'.amazonaws.com/'+bucket+'/'+key);
  url.searchParams.set('versionId',head.VersionId);
  requireValue(url.href.length<=1024,'Version URL exceeds the CloudFormation limit.');
  return {account,region,scope,source,stack:hostedStack,bootstrapStack,bucket,key,versionId:head.VersionId,sha256,bytes:bytes.length,
    workerImage:worker.Image,lambdaImage:app.Code.ImageUri,templateUrl:url.href};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values}=parseArgs({options:Object.fromEntries(['assembly','account','region','scope','source','bootstrap-stack','receipt'].map(x=>[x,{type:'string'}]))});
    requireValue(values.assembly && values.receipt,'Supply --assembly and a private --receipt file.');
    const receipt=await stageHostedTemplate({...values,bootstrapStack:values['bootstrap-stack']});
    // A receipt already held at the requested path may be reused only for exactly the same object version.
    const text=JSON.stringify(receipt,null,2)+'\n';
    try { await writeFile(values.receipt,text,{mode:0o600,flag:'wx'}); }
    catch(error) { if(error.code!=='EEXIST' || await readFile(values.receipt,'utf8')!==text) throw error; }
    console.log(receipt.templateUrl);
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
