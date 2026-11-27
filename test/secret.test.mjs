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
  // The Git worker's owner-supplied value has a separate lifecycle from infrastructure.
  assert.deepEqual(Object.keys(secret.Properties).sort(), ['Description', 'Name']);
  assert.deepEqual(template.Outputs.ProjectsGitTokenArn.Value, { Ref: 'ProjectsGitToken' });
});

test('founder mail enrollment generates a retained routing token in AWS and publishes only the secret reference', () => {
  const stack = new Stack(new App(), 'FounderMailContract');
  new CfnInclude(stack, 'Template', {
    templateFile: fileURLToPath(new URL('../infra/founder-mail-secret.yaml', import.meta.url)),
  });
  const template = Template.fromStack(stack).toJSON();
  const { FounderEmail } = template.Parameters;
  assert.equal(FounderEmail.NoEcho, true);
  assert.equal(FounderEmail.MaxLength, 254);
  assert.equal(FounderEmail.Default, undefined);
  const address = new RegExp('^(?:' + FounderEmail.AllowedPattern + ')$');
  for (const example of ['Founder+Pilot@example.invalid', "founder's.box@co.example.invalid", 'a'.repeat(64)+'@example.invalid'])
    assert.match(example, address);
  for (const example of ['first..last@example.invalid', 'a'.repeat(65)+'@example.invalid', 'first@example-.invalid',
    'address@localhost', 'a"b@example.invalid', 'A Name <founder@example.invalid>', 'x@example.invalid\nBcc: y@else.invalid'])
    assert.doesNotMatch(example, address);

  assert.deepEqual(Object.keys(template.Resources).sort(), ['FounderMail', 'FounderRecipient']);
  const secret = template.Resources.FounderMail;
  assert.equal(secret.Type, 'AWS::SecretsManager::Secret');
  assert.equal(secret.DeletionPolicy, 'Retain');
  assert.equal(secret.UpdateReplacePolicy, 'Retain');
  const generator = secret.Properties.GenerateSecretString;
  assert.deepEqual(generator.SecretStringTemplate, {'Fn::Sub':'{"address":"${FounderEmail}"}'});
  assert.equal(generator.GenerateStringKey, 'token');
  assert.equal(generator.PasswordLength, 52);
  assert.equal(generator.ExcludeUppercase, true);
  assert.equal(generator.ExcludePunctuation, true);
  assert.equal(generator.IncludeSpace, false);
  assert.equal(generator.RequireEachIncludedType, false);
  assert.ok(!generator.ExcludeLowercase && !generator.ExcludeNumbers);
  const alphabet = [...'abcdefghijklmnopqrstuvwxyz0123456789'].filter(c => !generator.ExcludeCharacters.includes(c));
  assert.equal(alphabet.join(''), 'abcdefghijklmnopqrstuvwxyz234567');
  assert.ok(generator.PasswordLength * Math.log2(alphabet.length) >= 256);
  assert.deepEqual(Object.keys(template.Outputs), ['OwnerMailSecretArn']);
  assert.deepEqual(template.Outputs.OwnerMailSecretArn.Value, {Ref:'FounderMail'});
  assert.equal(template.Parameters.VerifySandboxRecipient.Default, 'false');
  assert.deepEqual(template.Conditions.EnrollRecipient, {'Fn::Equals':[{Ref:'VerifySandboxRecipient'},'true']});
  const recipient = template.Resources.FounderRecipient;
  assert.equal(recipient.Type, 'AWS::SES::EmailIdentity');
  assert.equal(recipient.Condition, 'EnrollRecipient');
  assert.deepEqual(recipient.Properties, {EmailIdentity:{Ref:'FounderEmail'}});
  assert.equal(recipient.DeletionPolicy, 'Retain');
  assert.equal(recipient.UpdateReplacePolicy, 'Retain');
  assert.ok(!JSON.stringify(secret.Properties).includes('VerifySandboxRecipient'));
});
