import { createHash } from 'node:crypto';

export const repository = 'The-CarL/perottino-co-projects';
export function projectsRepository(value = repository) {
  insist(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) &&
    !value.endsWith('.') && !value.endsWith('.git') && value.toLowerCase() !== 'the-carl/perottino-co-platform',400,'Configure a projects repository as owner/name.');
  return value;
}
export const shaFormat = /^[a-f0-9]{40}$/;
export const projectFormat = /^p-[a-f0-9]{32}$/;
const jobFormat = /^j-[a-f0-9]{32}$/;
export const fault = (status, message) => Object.assign(new Error(message), { status });
export function insist(condition, status, message) {
  if (!condition) throw fault(status, message);
}
export function stableId(prefix, ...parts) {
  return prefix + '-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}
export function sourceFiles(input) {
  insist(Array.isArray(input) && input.length > 0 && input.length <= 64, 400, 'Supply 1–64 project files.');
  const paths = new Set();
  let bytes = 0;
  const files = input.map(item => {
    const path = item?.path, content = item?.content;
    insist(typeof path === 'string' && path.length <= 150 && path.split('/').every(
      part => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(part) && !part.endsWith('.') &&
        !['node_modules','__proto__','constructor','prototype'].includes(part.toLowerCase())), 400, 'Invalid project file path.');
    insist(typeof content === 'string' && content.isWellFormed() && !content.includes('\0'), 400, 'Project source must be UTF-8 text.');
    bytes += Buffer.byteLength(path) + Buffer.byteLength(content);
    const folded = path.toLowerCase();
    insist(!paths.has(folded) && bytes <= 65_536, 400, 'Duplicate project path or source exceeds 64 KiB.');
    paths.add(folded);
    return { path, content };
  });
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      insist(!paths.has(parts.join('/')), 400, 'A project file cannot also be a directory.');
    }
  }
  return files.sort((a,b) => a.path < b.path ? -1 : 1);
}
export function jobSpec(value) {
  insist(projectFormat.test(value?.projectId) && jobFormat.test(value?.jobId) && shaFormat.test(value?.baseSha),400,'Invalid Git job identity.');
  for (const key of ['agentId','taskId'])
    insist(typeof value[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value[key]),400,'Invalid Git provenance.');
  insist(typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt)),400,'Invalid commit date.');
  const {projectId,jobId,agentId,taskId,baseSha,createdAt} = value;
  return {projectId,jobId,agentId,taskId,baseSha,createdAt,files:sourceFiles(value.files)};
}
export const branchFor = job => 'jobs/' + job.projectId + '/' + job.jobId;
export const pathFor = projectId => 'apps/' + projectId;
export const commitMessage = job => `Update ${job.projectId}\n\nAgent: ${job.agentId}\nTask: ${job.taskId}\nJob: ${job.jobId}`;
export const author = {name:'Perottino Projects',email:'projects@users.noreply.github.com'};
