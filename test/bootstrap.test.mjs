import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { Template } from 'aws-cdk-lib/assertions';

test('runtime bootstrap allocates an account-local registry, owner slot and scoped Lambda image access', () => {
  for (const env of [{ account: '111111111111', region: 'us-east-1' }, { account: '222222222222', region: 'eu-west-1' }]) {
    const stack = new Stack(new App(), 'RuntimeBootstrap', { env });
    new CfnInclude(stack, 'Resources', { templateFile: fileURLToPath(new URL('../infra/runtime-bootstrap.yaml', import.meta.url)) });
    const { Resources, Outputs } = Template.fromStack(stack).toJSON();
    assert.deepEqual(Object.keys(Resources).sort(), ['ConsoleOwner', 'Images']);
    for (const r of Object.values(Resources)) {
      assert.equal(r.DeletionPolicy, 'Retain');
      assert.equal(r.UpdateReplacePolicy, 'Retain');
    }
    assert.equal(Resources.Images.Properties.ImageTagMutability, 'IMMUTABLE');
    assert.equal(Resources.Images.Properties.RepositoryName, undefined);
    assert.deepEqual(Object.keys(Resources.ConsoleOwner.Properties).sort(), ['Description', 'Tags']);
    for (const [id, purpose] of Object.entries({ ConsoleOwner: 'owner-verifier', Images: 'runtime-images' })) {
      assert.deepEqual(Resources[id].Properties.Tags, [{ Key: 'perottino:purpose', Value: purpose }]);
    }
    const [pull] = Resources.Images.Properties.RepositoryPolicyText.Statement;
    assert.deepEqual(pull.Principal, { Service: 'lambda.amazonaws.com' });
    assert.deepEqual(pull.Action, ['ecr:BatchGetImage','ecr:GetDownloadUrlForLayer']);
    const sources = pull.Condition.ArnEquals['aws:SourceArn'];
    assert.deepEqual(sources.map(a => a['Fn::Sub'].split('-r-').at(-1)).sort(), ['a','d','i','t']);
    assert.ok(sources.every(a => a['Fn::Sub'].includes('${AWS::AccountId}:function:factory-${ProjectScope}')));
    assert.deepEqual(Outputs.ImageRepositoryUri.Value, { 'Fn::GetAtt': ['Images', 'RepositoryUri'] });
    assert.deepEqual(Outputs.OwnerSecretArn.Value, { Ref: 'ConsoleOwner' });
    assert.doesNotMatch(JSON.stringify({ Resources, Outputs }), /\d{12}:|carloperottino\.com|\/github\/pat/);
  }
});
