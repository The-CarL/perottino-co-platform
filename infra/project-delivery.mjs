import { CfnOutput } from 'aws-cdk-lib';

export const deliveryTagIds=['DeliveryExecutorRole','DeliveryReaderRole','DeliveryExecutor','DeliveryReader','DeliveryApi','DeliveryStage'];

// The broker provisions logical sites under a single reviewed static template.
// It cannot create arbitrary cloud resources or select another AWS account.
export function addProjectDelivery({stack,resource,role,fn,arn,allow,logWrite,state,prefix,account,region}) {
  const execRole=role('DeliveryExecutorRole','lambda.amazonaws.com',[logWrite]);
  const readerRole=role('DeliveryReaderRole','lambda.amazonaws.com',[logWrite,{
    ...allow('dynamodb:GetItem',arn(state)),Condition:{'ForAllValues:StringEquals':{
      'dynamodb:LeadingKeys':['V2#PUBLICSITE#PREVIEW','V2#PUBLICSITE#PRODUCTION']},Null:{'dynamodb:LeadingKeys':'false'}},
  }]);
  const executor=fn('DeliveryExecutor','b','src/delivery-executor.handler',execRole,{},6);
  const reader=fn('DeliveryReader','u','src/company-deployments.publicHandler',readerRole,{PEROTTINO_STATE_TABLE:state.ref},6);
  const api=resource('DeliveryApi','ApiGatewayV2::Api',{Name:prefix+'sites',ProtocolType:'HTTP'},true);
  const integration=resource('DeliveryIntegration','ApiGatewayV2::Integration',{ApiId:api.ref,IntegrationType:'AWS_PROXY',
    IntegrationUri:arn(reader),PayloadFormatVersion:'2.0',TimeoutInMillis:6500});
  for(const method of ['GET','HEAD']) resource('DeliveryRoute'+method,'ApiGatewayV2::Route',{
    ApiId:api.ref,RouteKey:method+' /{proxy+}',Target:'integrations/'+integration.ref});
  resource('DeliveryStage','ApiGatewayV2::Stage',{ApiId:api.ref,StageName:'$default',AutoDeploy:true,
    DefaultRouteSettings:{ThrottlingRateLimit:10,ThrottlingBurstLimit:20}},true);
  resource('DeliveryReaderPermission','Lambda::Permission',{FunctionName:arn(reader),Action:'lambda:InvokeFunction',
    Principal:'apigateway.amazonaws.com',SourceAccount:account,SourceArn:'arn:aws:execute-api:'+region+':'+account+':'+api.ref+'/*'});
  const origin=api.getAtt('ApiEndpoint').toString();
  new CfnOutput(stack,'ProjectDeliveryOrigin',{value:origin});
  return {origin,executorArn:arn(executor),invokeStatement:allow('lambda:InvokeFunction',arn(executor))};
}
