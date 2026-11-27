import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,msg)=>{throw Object.assign(new Error(msg),{status});};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const price=(input,output,rate)=>Math.max(1,Math.ceil((input*rate.inputCentsPerMillion+output*rate.outputCentsPerMillion)/1_000_000));
function checkedRate(r) {
  if(!r||!integer(r.maxInputTokens,1,10_000_000)||!integer(r.maxOutputTokens,1,10_000_000)||
    !integer(r.inputCentsPerMillion,1,1_000_000)||!integer(r.outputCentsPerMillion,1,1_000_000))
    fail(503,'Configure verified Bedrock price and token ceilings before enabling paid model calls.');
  return {maxInputTokens:r.maxInputTokens,maxOutputTokens:r.maxOutputTokens,inputCentsPerMillion:r.inputCentsPerMillion,outputCentsPerMillion:r.outputCentsPerMillion};
}

// Only the trusted execution loop can request permits. The model cannot choose
// a price, release an in-flight hold, or assert token usage in its decision.
export function makeModelMeter({records,governance,settings,tariffs=JSON.parse(process.env.PEROTTINO_MODEL_TARIFFS||'{}')}) {
  return {async execute(actor,op,input={}) {
    if(actor==='owner'||!/^\w[\w.:-]{0,159}$/.test(input.requestId??'')) fail(400,'Invalid model attempt.');
    const pk='model-meter#'+actor,sk=input.requestId;
    for(let attempt=0;attempt<8;attempt++) {
      const row=await records.get(pk,sk);
      if(!row) {
        if(op!=='budget.model.begin') fail(404,'Model attempt missing.');
        const current=await settings.effective(actor,{});
        if(current.version!==input.settingsVersion||current.settings.modelId!==input.modelId) fail(409,'Model settings changed.');
        const rate=checkedRate(tariffs[input.modelId]);
        const value={modelId:input.modelId,settingsVersion:current.version,rate,maximum:price(rate.maxInputTokens,rate.maxOutputTokens,rate),state:'created'};
        await records.transact([{pk,sk,expect:null,value}]);
        continue;
      }
      const {version,pk:ignoredPk,sk:ignoredSk,...data}=row;
      if(op==='budget.model.begin') {
        if(row.modelId!==input.modelId ||row.settingsVersion!==input.settingsVersion) fail(409,'Model attempt already used.');
        if(row.state!=='created')return {permitted:false,settled:row.state==='settled'};
        const current=await settings.effective(actor,{});
        if(current.version!==row.settingsVersion || current.settings.modelId!==row.modelId ||
            digest(checkedRate(tariffs[row.modelId]))!==digest(row.rate)) fail(409,'Model settings or tariff changed.');
        const {reservation}=await governance.execute(actor,'budget.reserve',{purpose:'model',amountCents:row.maximum,requestId:digest([actor,sk,'hold'])});
        if(await records.transact([{pk,sk,expect:version,value:{...data,state:'issued',reservationId:reservation.id}}]))
          return {permitted:true};
        continue;
      }
      if(op!=='budget.model.finish') fail(404,'Unknown model meter operation.');
      if(row.state==='settled')return {chargedCents:row.charge};
      if(row.state==='created') fail(409,'Model permit has not been issued.');
      if(row.state==='issued') {
        const u=input.usage, r=row.rate;
        const known=integer(u?.input_tokens,0,r.maxInputTokens)&&integer(u?.output_tokens,0,r.maxOutputTokens)&&
          // A provider failing to report usage for a charged attempt must not release the hold.
          (u.input_tokens>0 || u.output_tokens>0);
        const charge=known?price(u.input_tokens,u.output_tokens,r):row.maximum;
        await records.transact([{pk,sk,expect:version,value:{...data,state:'settling',charge}}]);
        continue;
      }
      await governance.execute(actor,'budget.settle',{reservationId:row.reservationId,actualCents:row.charge,requestId:digest([actor,sk,'charge'])});
      if(await records.transact([{pk,sk,expect:version,value:{...data,state:'settled'}}]))return {chargedCents:row.charge};
    }
    fail(503,'Model meter is busy.');
  }};
}
