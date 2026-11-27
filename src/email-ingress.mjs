import PostalMime from 'postal-mime';
import { createCloudStore } from './cloud-store.mjs';

const maxBytes = 150 * 1024;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';

function route(address, domain, employees) {
  if (typeof address !== 'string') return;
  const parts = address.toLowerCase().split('@');
  if (parts.length !== 2 || parts[1] !== domain) return;
  // A role shared by several employees has no individual alias. Personal handles are stable.
  const [handle] = parts;
  if (handle === 'ceo') return employees.find(employee => employee.id === 'ceo');
  const named = employees.find(employee => employee.handle === handle);
  if (named) return named;
  const role = employees.filter(employee => employee.role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === handle);
  if (role.length === 1) return role[0];
}

export function createEmailIngress({ store, domain, topicArn }) {
  if (!domainPattern.test(domain ?? '') || !topicArn) throw new Error('Incomplete email configuration.');
  return async event => {
    if (!Array.isArray(event?.Records) || !event.Records.length) throw new Error('Expected an SNS delivery.');
    let delivered = 0;
    let ignored = 0;
    for (const record of event.Records) {
      if (record.EventSource !== 'aws:sns' || record.Sns?.TopicArn !== topicArn) throw new Error('Unexpected mail event source.');
      if (record.Sns.Subject === 'Amazon SES Setup Notification') { ignored++; continue; }
      const message = JSON.parse(record.Sns.Message);
      if (message.notificationType !== 'Received' || !Array.isArray(message.receipt?.recipients) ||
          typeof message.mail?.messageId !== 'string' || !/^[a-zA-Z0-9-]{1,200}$/.test(message.mail.messageId)) {
        throw new Error('Malformed receipt.');
      }
      if (message.receipt.virusVerdict?.status !== 'PASS' || message.receipt.spamVerdict?.status !== 'PASS') {
        ignored++;
        continue;
      }
      const employees = (await store.listEmployees()).filter(employee => employee.desiredState !== 'fired');
      const recipients = new Map();
      for (const address of message.receipt.recipients) {
        const employee = route(address, domain, employees);
        if (employee && !recipients.has(employee.id)) recipients.set(employee.id, address.toLowerCase());
      }
      if (!recipients.size) { ignored++; continue; }
      if (typeof message.content !== 'string' || !message.content.length || message.content.length > Math.ceil(maxBytes / 3) * 4) {
        throw new Error('Invalid mail content size.');
      }
      const raw = Buffer.from(message.content, 'base64');
      if (raw.length > maxBytes || raw.toString('base64') !== message.content) throw new Error('Invalid mail encoding.');
      const mime = await PostalMime.parse(raw);
      const text = clean(mime.text, 12_000) || '[Message has no plain-text part.]';
      for (const [id, to] of recipients) {
        try {
          const result = await store.enqueueEmail(id, { messageId: message.mail.messageId,
            from: clean(message.mail.source, 254) || '<>', to, subject: clean(mime.subject, 250), text });
          if (result?.conflict) throw new Error('Conflicting receipt.');
          delivered++;
        } catch (error) {
          if (error.code !== 'EMPLOYEE_FIRED') throw error;
          ignored++;
        }
      }
    }
    return { delivered, ignored };
  };
}

let receive;
export async function handler(event) {
  receive ??= createEmailIngress({ store: createCloudStore({ resident: true }), domain: process.env.PEROTTINO_MAIL_DOMAIN,
    topicArn: process.env.PEROTTINO_MAIL_TOPIC_ARN });
  return receive(event);
}
