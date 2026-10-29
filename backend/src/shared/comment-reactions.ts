import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';

export const COMMENT_REACTIONS = ['like', 'applause', 'strong', 'love', 'fire', 'star'] as const;
export interface CommentReaction {
  commentId: string;
  userId: string;
  userName: string;
  reaction: string;
}

/** Stored separately from comments so legacy whole-thread edits cannot erase reactions. */
export async function setCommentReaction(
  model: Model<any>, id: string, commentId: string, embeddedId: boolean,
  userId: string, userName: string, reaction: unknown,
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
  ] } } }], { new: true, timestamps: false, projection: { commentReactions: 1 } }).lean().exec();
  if (!doc) throw new NotFoundException('Comment not found');
  return { commentId: cid, reactions: ((doc as any).commentReactions || []).filter((r: CommentReaction) => r.commentId === cid) };
}
