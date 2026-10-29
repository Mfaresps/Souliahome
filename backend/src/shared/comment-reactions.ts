import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';

export const COMMENT_REACTIONS = ['like', 'applause', 'strong', 'love', 'fire', 'star', 'angry'] as const;
export const COMMENT_REACTION_LABELS: Record<string, [string, string, string]> = {
  like: ['👍', 'إعجاب', 'Like'], applause: ['👏', 'تسقيفة', 'Applause'], strong: ['💪', 'عاش', 'Well done'],
  love: ['❤️', 'حب', 'Love'], fire: ['🔥', 'جامد', 'Awesome'], star: ['🌟', 'برافو', 'Bravo'],
  angry: ['😠', 'غضب', 'Angry'],
};
export interface CommentReaction {
  commentId: string;
  userId: string;
  userName: string;
  reaction: string;
}
export interface CommentReactionAdded {
  id: string; commentId: string; reaction: string; actorUserId: string; actorName: string;
  authorId: string; authorName: string; text: string; ref: string;
}

/** Stored separately from comments so legacy whole-thread edits cannot erase reactions. */
export async function setCommentReaction(
  model: Model<any>, id: string, commentId: string, embeddedId: boolean,
  userId: string, userName: string, reaction: unknown,
  onAdded?: (event: CommentReactionAdded) => Promise<void>,
): Promise<{ commentId: string; reactions: CommentReaction[] }> {
  if (!userId) throw new ForbiddenException('Authentication required');
  if (reaction !== null && !COMMENT_REACTIONS.includes(reaction as any)) {
    throw new BadRequestException('Invalid reaction');
  }
  if (!/^[a-f\d]{24}$/i.test(id) || (embeddedId
    ? !/^[a-f\d]{24}$/i.test(commentId)
    : !/^\d+$/.test(commentId) || !Number.isSafeInteger(Number(commentId)))) {
    throw new BadRequestException('Invalid comment ID');
  }
  const cid = embeddedId ? commentId.toLowerCase() : String(Number(commentId));
  const entry: CommentReaction = { commentId: cid, userId, userName, reaction: reaction as string };
  // One atomic, idempotent update: changing one user's choice preserves everyone else.
  const doc = await model.findOneAndUpdate({
    _id: new Types.ObjectId(id),
    [embeddedId ? 'comments._id' : 'comments.id']: embeddedId ? new Types.ObjectId(cid) : Number(cid),
  }, [{ $set: { commentReactions: { $concatArrays: [
    { $filter: { input: { $ifNull: ['$commentReactions', []] }, as: 'r', cond: {
      $not: [{ $and: [
        { $eq: ['$$r.commentId', { $literal: cid }] },
        { $eq: ['$$r.userId', { $literal: userId }] },
      ] }],
    } } },
    { $literal: reaction === null ? [] : [entry] },
  ] } } }], { new: false, timestamps: false, projection: { commentReactions: 1, comments: 1, ref: 1, orderRef: 1 } }).lean().exec();
  if (!doc) throw new NotFoundException('Comment not found');
  const previous: CommentReaction[] = ((doc as any).commentReactions || []).filter((r: CommentReaction) => r.commentId === cid);
  const reactions = previous.filter(r => r.userId !== userId).concat(reaction === null ? [] : [entry]);
  // The atomic pre-image distinguishes a new choice from concurrent/retried requests.
  if (reaction !== null && previous.find(r => r.userId === userId)?.reaction !== reaction && onAdded) {
    const comment = ((doc as any).comments || []).find((c: any) => String(embeddedId ? c._id : c.id) === cid);
    if (comment) await onAdded({ id, commentId: cid, reaction: reaction as string, actorUserId: userId, actorName: userName,
      authorId: String(comment.authorId || comment.employeeId || ''), authorName: comment.authorName || comment.employee || '',
      text: comment.text || '', ref: String((doc as any).orderRef || (doc as any).ref || '') });
  }
  return { commentId: cid, reactions };
}
