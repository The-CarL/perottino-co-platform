const queue = accountableId => 'goal-notices#' + accountableId;

export function notificationRow(goal,requesterReply) {
  if(goal.status==='done' && goal.sourceMail?.threadId && goal.sourceMail?.messageId)
    return {pk:queue(goal.accountableId),sk:goal.id,expect:null,value:{sourceMail:goal.sourceMail,...(requesterReply && {requesterReply})}};
  if (goal.status !== 'done' || !goal.source?.conversationId || !goal.source.messageId) return null;
  return { pk: queue(goal.accountableId), sk: goal.id, expect: null, value: {
    conversationId: goal.source.conversationId, messageId: goal.source.messageId,
  } };
}

function unavailableOrigin(error) {
  // An inactive employee or expired employment fence can recover after a resume.
  // Those authorization errors must leave the notice queued.
  return error.status === 404 || error.status === 410 || error.code === 'CONVERSATION_ARCHIVED' ||
    (error.status === 403 && error.code === 'CONVERSATION_FORBIDDEN');
}

export async function deliverNextGoalNotice({ actor, records, conversations, mail }) {
  const { items: [notice] } = await records.list(queue(actor), { limit: 1 });
  if (!notice) return false;
  const { pk, sk: goalId, version, conversationId, messageId } = notice;
  try {
    if(notice.sourceMail) {
      if(!mail) throw Object.assign(new Error('Mail delivery is unavailable.'),{status:503});
      if(await mail.canUseSource(actor,notice.sourceMail)) await mail.execute(actor,'mail.reply',{
        ...notice.sourceMail,requestId:'goal-complete-'+goalId,text:notice.requesterReply??'The goal is complete. Goal ID '+goalId+'.'
      });
    } else {
      const { conversation } = await conversations.execute(actor, 'conversations.get', { conversationId });
      if (conversation.members.includes(actor) && !conversation.archivedAt && conversation.status !== 'archived') {
        // The conversation service checks membership again and verifies the original message
        // before committing. Replaying this request after a crash recovers the same reply.
        await conversations.execute(actor, 'messages.post', { conversationId, replyTo: messageId,
          text: 'The goal is complete. Goal ID ' + goalId + '.', responders: [], requestId: 'goal-complete-' + goalId });
      }
    }
  } catch (error) {
    // An unconfigured or paused mail transport may recover. Other work can proceed while
    // the private completion notice remains pending.
    if (notice.sourceMail && error.status === 503) return false;
    if (!unavailableOrigin(error)) throw error;
  }
  if (!await records.transact([{ pk, sk: goalId, expect: version, value: null }]) && await records.get(pk, goalId)) {
    throw Object.assign(new Error('Completion notice changed before acknowledgement.'), { status: 409 });
  }
  return true;
}
