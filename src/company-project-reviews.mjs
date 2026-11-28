import { randomUUID } from 'node:crypto';
import { eventRows } from './company-events.mjs';
import { fault, insist, shaFormat, stableId } from './project-source.mjs';

const catalog = 'projects:catalog';
const requests = 'projects:peer-requests';
const reviewKey = id => 'projects:reviews:'+id;
const write = (pk,sk,old,value) => ({pk,sk,expect:old?.version??null,value});
const fields = ({pk,sk,version,...value}) => value;
const busy = () => fault(409,'Project review changed. Refresh and retry.');
const audit = (actor,h,status) => ({actor,projectId:h.projectId,taskId:h.taskId,goalId:h.goalId,
  jobId:h.jobId,commitSha:h.sha,prNumber:h.pr.number,status});

export function createProjectReviews({records,work,git,getBuild,project,claimed,request,now}) {
  async function target(actor,input) {
    const p=await project(actor,input.projectId);
    insist(typeof input.commitSha==='string' && shaFormat.test(input.commitSha),400,'An exact handoff commit SHA is required.');
    const h=p.latestHandoff?.sha===input.commitSha ? p.latestHandoff :
      (await records.get('projects:snapshots:'+p.id,input.commitSha))?.handoff;
    insist(h && h.taskId===input.taskId,404,'Project handoff not found.');
    return {p,h,state:await records.get(reviewKey(p.id),h.sha)};
  }
  async function authorize(actor,h,p,reviewTaskId) {
    insist(actor!=='owner' && actor!==h.agentId,403,'A different employee must review or merge this change.');
    if (reviewTaskId) {
      const task=await claimed(actor,reviewTaskId);
      insist(p.goalIds.includes(task.goalId),403,'Review task does not belong to this project.');
    } else {
      const {task}=await work.execute(actor,'task.get',{taskId:h.taskId});
      insist(task.reviewerId===actor,403,'Claim a review task on this project.');
    }
  }
  function current(p,h) {
    insist(p.latestSha===h.sha && p.latestTaskId===h.taskId && h.status==='current',409,'Only the latest current handoff can be reviewed or merged.');
  }
  async function status(actor,input) {
    const {state}=await target(actor,input);
    return {review:state?.review??null,merge:state?.merge??null};
  }
  async function recordPublication(h,review,dispatchId,publication,error) {
    const key=review.reviewId;
    const pk=reviewKey(h.projectId);
    for (let attempt=0;attempt<5;attempt++) {
      const [state,record]=await Promise.all([records.get(pk,h.sha),records.get(requests,key)]);
      if (record?.review.publication) return record.review;
      insist(state?.reviewDispatch===dispatchId && state.review.reviewId===key,409,'Another worker is reconciling this review.');
      const refused=[400,403,409,422].includes(error?.status);
      const result={...review,publicationStatus:publication?'published':refused?'refused':'pending',publication};
      const changes=[write(pk,h.sha,state,{review:result}),
        write(requests,key,record,{signature:record.signature,review:result})];
      if (publication || refused) changes.push(...eventRows(publication?'project.review_published':'project.review_refused',
        audit(review.reviewerId,h,result.publicationStatus),dispatchId));
      if (await records.transact(changes)) {
        if (error) throw error;
        return result;
      }
    }
    throw busy();
  }
  async function publish(h,review,dispatchId) {
    let proof;
    try {
      insist(typeof git?.publishReview==='function',503,'Project review publication is unavailable.');
      const {reviewerId,decision,reviewId}=review;
      const result=await git.publishReview(h,{reviewerId,decision,reviewId});
      const validId=h.pr.local===true && h.repo==='local:projects' ? result?.id===reviewId && result.url===null :
        Number.isSafeInteger(result?.id) && result.id>0 && result.url===h.pr.url+'#pullrequestreview-'+result.id;
      const expectedState=decision==='approve' ? 'APPROVED' : 'CHANGES_REQUESTED';
      insist(validId && result.sha===h.sha && result.prNumber===h.pr.number &&
        (result.state==='COMMENTED' || result.state===expectedState),502,'Invalid Git review receipt.');
      proof={id:result.id,url:result.url,sha:h.sha,prNumber:h.pr.number,state:result.state};
    } catch (error) {
      return recordPublication(h,review,dispatchId,null,error);
    }
    return recordPublication(h,review,dispatchId,proof);
  }
  async function review(actor,input) {
    const key=stableId('r',actor,'review',request(input));
    const {decision}=input;
    const note=typeof input.note==='string' ? input.note.trim() : '';
    insist(['approve','changes'].includes(decision) && note.length>0 && note.length<=2000,400,'Supply a review decision and a note of at most 2000 characters.');
    const signature=stableId('r',input.projectId,input.taskId,input.commitSha,decision,note,input.reviewTaskId??null);
    for (let attempt=0;attempt<8;attempt++) {
      const {p,h,state}=await target(actor,input);
      const prior=await records.get(requests,key);
      if (prior) {
        insist(prior.signature===signature,409,'Project review request already used.');
        if (prior.review.publication) return {review:prior.review};
        insist(state?.review?.reviewId===key,409,'This review has been superseded.');
      }
      await authorize(actor,h,p,input.reviewTaskId);
      if (!prior) current(p,h);
      insist(!state?.merge && !p.pendingMerge,409,'This merge has already started.');
      insist(!(state?.reviewLeaseUntil>now()),409,'A review is being published. Retry to reconcile it.');
      const pending=state?.review?.publicationStatus==='pending' || prior?.review.publicationStatus==='refused';
      const result=pending?state.review:{projectId:p.id,taskId:h.taskId,commitSha:h.sha,prNumber:h.pr.number,
        reviewerId:actor,decision,note,at:new Date(now()).toISOString(),reviewId:key,publicationStatus:'pending',publication:null,
        ...(input.reviewTaskId && {reviewTaskId:input.reviewTaskId})};
      const dispatchId=randomUUID();
      // Record the new decision before contacting GitHub. This atomically revokes an older approval.
      const changes=[write(catalog,p.id,p,fields(p)),write(reviewKey(p.id),h.sha,state,{review:result,reviewDispatch:dispatchId,reviewLeaseUntil:now()+90_000})];
      if (!pending) changes.push(write(requests,key,null,{signature,review:result}),...eventRows('project.reviewed',audit(actor,h,decision),key));
      if (!await records.transact(changes)) continue;
      const confirmed=await publish(h,result,dispatchId);
      if (result.reviewId===key) return {review:confirmed};
      // An earlier worker lost the response. Its publication has been reconciled. Now
      // recheck the current head and record this caller's decision under its own ID.
    }
    throw busy();
  }

  async function finish(h,dispatchId,outcome,error) {
    const pk=reviewKey(h.projectId);
    for (let attempt=0;attempt<8;attempt++) {
      const [p,state]=await Promise.all([records.get(catalog,h.projectId),records.get(pk,h.sha)]);
      if (state?.merge?.status==='merged') return {merge:state.merge};
      insist(p?.pendingMerge===h.sha && state?.dispatchId===dispatchId,409,'Another worker is reconciling this merge.');
      const {pendingMerge,...unlocked}=fields(p);
      const pending=state.merge;
      let changes;
      if (outcome) {
        const merged={...pending,status:'merged',mergeSha:outcome.mergeSha,mergedAt:new Date(now()).toISOString()};
        changes=[write(pk,h.sha,state,{review:state.review,merge:merged}),write(catalog,p.id,p,unlocked),
          ...eventRows('project.merged',{...audit(pending.mergedBy,h,'merged'),reviewerId:pending.reviewerId,mergeSha:merged.mergeSha},h.jobId)];
        if (await records.transact(changes)) return {merge:merged};
      } else {
        // A conclusive rejection permits a revised PR. For an unknown provider outcome,
        // retain the approved intent and let the next worker reconcile the exact PR.
        const denied=[400,403,409,422].includes(error?.status);
        changes=[write(pk,h.sha,state,denied?{review:state.review}:{review:state.review,merge:pending})];
        if (denied) changes.push(write(catalog,p.id,p,unlocked),
          ...eventRows('project.merge_refused',audit(pending.mergedBy,h,'refused'),dispatchId));
        if (await records.transact(changes)) throw error;
      }
    }
    throw busy();
  }

  async function merge(actor,input) {
    const key=stableId('r',actor,'merge',request(input));
    const signature=stableId('r',input.projectId,input.taskId,input.commitSha,input.reviewTaskId??null);
    for (let attempt=0;attempt<5;attempt++) {
      const {p,h,state}=await target(actor,input);
      const prior=await records.get(requests,key);
      insist(!prior || prior.signature===signature,409,'Project merge request already used.');
      if (prior && state?.merge?.status==='merged') return {merge:state.merge};
      await authorize(actor,h,p,input.reviewTaskId);
      if (state?.merge?.status==='merged') return {merge:state.merge};
      current(p,h);
      insist(state?.review?.decision==='approve' && state.review.publication,409,'A published independent approval of this commit is required.');
      insist(!p.pendingMerge || p.pendingMerge===h.sha,409,'A different merge is in progress.');
      insist(!(state.leaseUntil>now()),409,'This merge is in progress. Retry to reconcile it.');
      insist(typeof git?.merge==='function' && typeof getBuild==='function',503,'Project merge services are unavailable.');
      let pending=state.merge;
      if (!pending) {
        const build=await getBuild(actor,{projectId:p.id,taskId:h.taskId,commitSha:h.sha});
        insist(build?.status==='passed' && build.testsPassed>0 && build.taskId===h.taskId &&
          build.projectId===p.id && build.commitSha===h.sha,409,'A passing build for this task and exact commit is required.');
        pending={projectId:p.id,taskId:h.taskId,sha:h.sha,prNumber:h.pr.number,buildId:build.buildId,status:'pending',
          reviewerId:state.review.reviewerId,mergedBy:actor,requestedAt:new Date(now()).toISOString()};
      }
      // Write the merge intent before contacting Git. Its fence survives process loss.
      const dispatchId=randomUUID();
      const changes=[write(catalog,p.id,p,{...fields(p),pendingMerge:h.sha}),
        write(reviewKey(p.id),h.sha,state,{review:state.review,merge:pending,dispatchId,leaseUntil:now()+90_000})];
      if (!prior) changes.push(write(requests,key,null,{signature}));
      if (!state.merge) changes.push(...eventRows('project.merge_requested',{...audit(actor,h,'pending'),reviewerId:pending.reviewerId},dispatchId));
      if (!await records.transact(changes)) continue;
      let result;
      try {
        result=await git.merge(h,{reviewerId:pending.reviewerId,mergedBy:pending.mergedBy});
        insist(result?.sha===h.sha && result.prNumber===h.pr.number && shaFormat.test(result.mergeSha),502,'Invalid Git merge receipt.');
      } catch (error) {
        return finish(h,dispatchId,null,error);
      }
      return finish(h,dispatchId,result);
    }
    throw busy();
  }
  return {review,status,merge};
}
