import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';

test('the pilot network provisions two independently routed /23 subnets in separate zones', () => {
  const stack = new Stack(new App(), 'Network');
  new CfnInclude(stack, 'Source', {
    templateFile: fileURLToPath(new URL('../infra/pilot-network.yaml', import.meta.url)),
  });
  const { Resources: r, Outputs: outputs, Parameters: params, Rules: rules } = Template.fromStack(stack).toJSON();
  assert.deepEqual(Object.values(r).map(x => x.Type).sort(), [
    'AWS::EC2::InternetGateway', 'AWS::EC2::Route', 'AWS::EC2::RouteTable',
    'AWS::EC2::Subnet', 'AWS::EC2::Subnet', 'AWS::EC2::SubnetRouteTableAssociation',
    'AWS::EC2::SubnetRouteTableAssociation', 'AWS::EC2::VPC', 'AWS::EC2::VPCGatewayAttachment',
  ]);
  const ref = Ref => ({ Ref });
  assert.equal(params.VpcCidr.Default, '10.230.0.0/22');
  assert.deepEqual(r.Network.Properties, {
    CidrBlock: ref('VpcCidr'), EnableDnsSupport: true, EnableDnsHostnames: true,
  });
  assert.deepEqual(rules.DistinctZones.Assertions[0].Assert, {
    'Fn::Not': [{ 'Fn::Equals': [ref('AvailabilityZoneA'), ref('AvailabilityZoneB')] }],
  });
  for (const [index, suffix] of ['A', 'B'].entries()) {
    assert.equal(params['AvailabilityZone' + suffix].Type, 'AWS::EC2::AvailabilityZone::Name');
    assert.deepEqual(r['Subnet' + suffix].Properties, {
      VpcId: ref('Network'), AvailabilityZone: ref('AvailabilityZone' + suffix),
      CidrBlock: { 'Fn::Select': [index, { 'Fn::Cidr': [ref('VpcCidr'), 2, 9] }] },
      MapPublicIpOnLaunch: false,
    });
    assert.deepEqual(r['RouteAssociation' + suffix].Properties, {
      RouteTableId: ref('Routes'), SubnetId: ref('Subnet' + suffix),
    });
  }
  assert.deepEqual(r.GatewayAttachment.Properties, { VpcId: ref('Network'), InternetGatewayId: ref('Gateway') });
  assert.deepEqual(r.Routes.Properties, { VpcId: ref('Network') });
  assert.deepEqual(r.InternetRoute.DependsOn, ['GatewayAttachment']);
  assert.deepEqual(r.InternetRoute.Properties, {
    DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref('Gateway'), RouteTableId: ref('Routes'),
  });
  assert.deepEqual(outputs, {
    VpcId: { Value: ref('Network') }, PublicSubnetA: { Value: ref('SubnetA') }, PublicSubnetB: { Value: ref('SubnetB') },
  });
});
