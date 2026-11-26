// Standard Workflows persist these waits without keeping a container running.
export function turnWorkflow({ cluster, task, subnets, securityGroup, admit, terminal, failureBucket }) {
  const ids = { 'agentId.$': '$.agentId', 'jobId.$': '$.jobId' };
  const serviceRetry = [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException',
    'Lambda.SdkClientException', 'Lambda.TooManyRequestsException', 'States.TaskFailed'], IntervalSeconds: 3, MaxAttempts: 3, BackoffRate: 2 }];
  const failed = Next => [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next }];
  const counters = (attempts, waits, Next) => ({ Type: 'Pass',
    Parameters: { 'attempts.$': attempts, 'waits.$': waits, 'finalWaits.$': '$.control.finalWaits' }, ResultPath: '$.control', Next });
  return { Comment: 'Run a bounded employee turn after cheap ordered admission', StartAt: 'Initialize', TimeoutSeconds: 36000, States: {
    Initialize: { Type: 'Pass', Result: { waits: 0, attempts: 0, finalWaits: 0 }, ResultPath: '$.control', Next: 'CheckAdmission' },
    CheckAdmission: { Type: 'Task', Resource: admit, Parameters: ids, ResultPath: '$.admission',
      Retry: serviceRetry, Catch: failed('RecordFailure'), Next: 'Admission' },
    Admission: { Type: 'Choice', Choices: [
      { Variable: '$.admission.status', StringEquals: 'done', Next: 'Complete' },
      { Variable: '$.admission.status', StringEquals: 'failed', Next: 'TurnFailed' },
      { And: [{ Variable: '$.admission.status', StringEquals: 'ready' },
        { Variable: '$.control.attempts', NumericLessThan: 3 }], Next: 'CountLaunch' },
      { And: [{ Variable: '$.admission.status', StringEquals: 'wait' },
        { Variable: '$.control.waits', NumericLessThan: 240 }], Next: 'CountWait' },
    ], Default: 'RecordFailure' },
    CountWait: counters('$.control.attempts', 'States.MathAdd($.control.waits, 1)', 'WaitLength'),
    WaitLength: { Type: 'Choice', Choices: [
      { Variable: '$.control.waits', NumericLessThanEquals: 2, Next: 'ShortWait' },
      { Variable: '$.control.waits', NumericLessThanEquals: 6, Next: 'MediumWait' },
    ], Default: 'WaitForAgent' },
    ShortWait: { Type: 'Wait', Seconds: 5, Next: 'CheckAdmission' },
    MediumWait: { Type: 'Wait', Seconds: 20, Next: 'CheckAdmission' },
    WaitForAgent: { Type: 'Wait', Seconds: 90, Next: 'CheckAdmission' },
    CountLaunch: counters('States.MathAdd($.control.attempts, 1)', '$.control.waits', 'RunEmployee'),
    RunEmployee: { Type: 'Task', Resource: 'arn:aws:states:::ecs:runTask.sync', TimeoutSeconds: 600,
      Parameters: { Cluster: cluster, TaskDefinition: task, LaunchType: 'FARGATE', PlatformVersion: '1.4.0',
        PropagateTags: 'TASK_DEFINITION', EnableECSManagedTags: true,
        NetworkConfiguration: { AwsvpcConfiguration: { Subnets: subnets, SecurityGroups: [securityGroup], AssignPublicIp: 'ENABLED' } },
        Overrides: { ContainerOverrides: [{ Name: 'worker', Environment: [
          { Name: 'AGENT_ID', 'Value.$': '$.agentId' }, { Name: 'TURN_ID', 'Value.$': '$.jobId' },
        ] }] } }, ResultPath: '$.taskResult', Catch: failed('RecoverLease'), Next: 'CheckExit' },
    CheckExit: { Type: 'Choice', Choices: [
      { And: [{ Variable: '$.taskResult.Containers[0].ExitCode', IsPresent: true },
        { Variable: '$.taskResult.Containers[0].ExitCode', NumericEquals: 0 }], Next: 'CheckAdmission' },
    ], Default: 'RecoverLease' },
    RecoverLease: { Type: 'Wait', Seconds: 20, Next: 'CheckAdmission' },
    RecordFailure: { Type: 'Task', Resource: terminal, Parameters: ids, ResultPath: '$.terminal', Retry: serviceRetry,
      Catch: failed('PrepareRecoveryRecord'), Next: 'TerminalResult' },
    TerminalResult: { Type: 'Choice', Choices: [
      { Variable: '$.terminal.status', StringEquals: 'done', Next: 'Complete' },
      { Variable: '$.terminal.status', StringEquals: 'failed', Next: 'TurnFailed' },
      { And: [{ Variable: '$.terminal.status', StringEquals: 'active' }, { Variable: '$.control.finalWaits', NumericLessThan: 4 }], Next: 'CountFinalWait' },
    ], Default: 'PrepareRecoveryRecord' },
    CountFinalWait: { Type: 'Pass', Parameters: { 'attempts.$': '$.control.attempts', 'waits.$': '$.control.waits',
      'finalWaits.$': 'States.MathAdd($.control.finalWaits, 1)' }, ResultPath: '$.control', Next: 'WaitForLeaseExpiry' },
    WaitForLeaseExpiry: { Type: 'Wait', Seconds: 90, Next: 'RecordFailure' },
    PrepareRecoveryRecord: { Type: 'Pass', Parameters: { ...ids, 'executionArn.$': '$$.Execution.Id' }, Next: 'ArchiveRecoveryRecord' },
    ArchiveRecoveryRecord: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:s3:putObject',
      Parameters: { Bucket: failureBucket, 'Key.$': "States.Format('workflow-failures/{}.json', $$.Execution.Name)",
        'Body.$': 'States.JsonToString($)', ContentType: 'application/json' }, ResultPath: null,
      Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 3, BackoffRate: 2 }], Next: 'TurnFailed' },
    TurnFailed: { Type: 'Fail', Error: 'EmployeeTurnFailed', Cause: 'Check the durable turn and workflow recovery records.' },
    Complete: { Type: 'Succeed' },
  } };
}
