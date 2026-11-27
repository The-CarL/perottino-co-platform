import { sourceFiles } from './project-source.mjs';

export const templateId = 'static-site-v1';
export const mediaTypes = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8',
}));

export function publicFiles(files) {
  const result = sourceFiles(files).filter(file => file.path.startsWith('public/'));
  if (!result.some(file => file.path === 'public/index.html') ||
      result.some(file => !mediaTypes.has(file.path.slice(file.path.lastIndexOf('.'))))) {
    throw new Error('invalid_public_files');
  }
  if (Buffer.byteLength(JSON.stringify(result))>230_000) throw new Error('invalid_public_files');
  return result;
}

export const buildReasons = new Set(['invalid_source', 'invalid_public_files', 'invalid_module',
  'build_failed', 'missing_tests', 'test_failed', 'time_limit', 'invalid_result']);

export function validateReport(report) {
  if (report?.status === 'failed' && buildReasons.has(report.reason)) {
    return { status: 'failed', testsPassed: 0, reason: report.reason };
  }
  if (report?.status !== 'passed' || !Number.isInteger(report.testsPassed) ||
      report.testsPassed < 1 || report.testsPassed > 1024) throw new Error('Invalid executor report.');
  return { status: 'passed', testsPassed: report.testsPassed, files: publicFiles(report.files) };
}
