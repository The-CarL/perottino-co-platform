import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { createCloudStore } from './cloud-store.mjs';

function jobKeys(agentId, jobId) {
  if (typeof agentId !== 'string' || !agentId.length || typeof jobId !== 'string' || !/^[a-f0-9]{64}$/.test(jobId)) {
    throw new TypeError('Invalid durable job identifiers');
  }
  return { agentId, jobId };
}

export function createDispatchHandlers({ startExecution, stateMachineArn, getStore, reportFailure = console.warn }) {
  return {
    async handler(event) {
      if (!Array.isArray(event?.Records)) throw new TypeError('Expected a DynamoDB Streams batch');
      for (const record of event.Records) {
        const image = record.dynamodb?.NewImage;
        if (record.eventSource !== 'aws:dynamodb' || record.eventName !== 'INSERT'
            || image?.kind?.S !== 'job' || image.state?.S !== 'queued') continue;
        const sequence = record.dynamodb.SequenceNumber;
        if (typeof sequence !== 'string' || !/^\d+$/.test(sequence)) throw new TypeError('Missing stream sequence number');
        try {
          const job = jobKeys(image.agentId?.S, image.jobId?.S);
          if (image.pk?.S !== 'AGENT#' + job.agentId || !/^PENDING#\d{16}$/.test(image.sk?.S ?? '')) {
            throw new TypeError('Invalid durable job key');
          }
          if (!stateMachineArn) throw new Error('Missing PEROTTINO_STATE_MACHINE_ARN');
          await startExecution({ stateMachineArn, name: 'turn-' + job.jobId, input: JSON.stringify(job) });
        } catch (error) {
          // Standard workflows accept the same name/input while running and report
          // ExecutionAlreadyExists after closing. Both acknowledge this immutable job.
          if (error?.name === 'ExecutionAlreadyExists') continue;
          reportFailure('Retrying durable job dispatch', { sequence, error: error?.name ?? 'Error' });
          // Lambda checkpoints at this sequence and replays the remaining shard suffix.
          return { batchItemFailures: [{ itemIdentifier: sequence }] };
        }
      }
      return { batchItemFailures: [] };
    },
    async admit(event) {
      const { agentId, jobId } = jobKeys(event?.agentId, event?.jobId);
      return { status: await getStore().turnAdmission(agentId, jobId) };
    },
    async terminal(event) {
      const { agentId, jobId } = jobKeys(event?.agentId, event?.jobId);
      return getStore().finishTurnWithError(agentId, jobId);
    },
  };
}

const sfn = new SFNClient({});
let store;
export const { handler, admit, terminal } = createDispatchHandlers({
  stateMachineArn: process.env.PEROTTINO_STATE_MACHINE_ARN,
  startExecution: input => sfn.send(new StartExecutionCommand(input)),
  getStore: () => store ??= createCloudStore({ tableName: process.env.PEROTTINO_STATE_TABLE }),
});
