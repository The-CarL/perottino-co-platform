import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';

test('bootstrap creates one retained secret slot and leaves its value to the owner', () => {
  const stack = new Stack(new App(), 'SecretContract');
  new CfnInclude(stack, 'Template', {
    templateFile: fileURLToPath(new URL('../infra/github-pat.yaml', import.meta.url)),
  });
  const template = Template.fromStack(stack).toJSON();
  assert.deepEqual(Object.keys(template.Resources), ['ProjectsGitToken']);
  const secret = template.Resources.ProjectsGitToken;
  assert.equal(secret.Type, 'AWS::SecretsManager::Secret');
  assert.equal(secret.Properties.Name, '/perottino-co/github/pat');
  assert.equal(secret.DeletionPolicy, 'Retain');
  assert.equal(secret.UpdateReplacePolicy, 'Retain');
  assert.equal('GenerateSecretString' in secret.Properties, false);
  assert.equal('SecretString' in secret.Properties, false);
  assert.deepEqual(template.Outputs.ProjectsGitTokenArn.Value, { Ref: 'ProjectsGitToken' });
});
