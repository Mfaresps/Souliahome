interface FollowUpActivity {
  escalationBaseline?: Date | string | null;
  createdAt?: Date | string | null;
  comments?: Array<{ createdAt?: Date | string; updatedAt?: Date | string }>;
}

/** Parent updatedAt also changes on automatic reminders; it is not employee activity. */
export function followUpLastActivityAt(followUp: FollowUpActivity): string | null {
  const times = [followUp.escalationBaseline, followUp.createdAt,
    ...(followUp.comments || []).flatMap(comment => [comment.createdAt, comment.updatedAt])]
    .filter(value => value != null && value !== '')
    .map(value => new Date(value as Date | string).getTime())
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Return the latest human comment without exposing the whole conversation. */
export function followUpLatestComment(followUp: { comments?: Array<{ text?: string; authorId?: string; authorName?: string; createdAt?: Date | string; updatedAt?: Date | string }> }) {
  const comments = (followUp.comments || []).filter(comment => comment.authorId !== 'system' && comment.text?.trim());
  const time = (comment: typeof comments[number]) => Math.max(...[comment.createdAt, comment.updatedAt].map(value => {
    const at = value ? new Date(value).getTime() : 0;
    return Number.isFinite(at) ? at : 0;
  }));
  const latest = comments.reduce<typeof comments[number] | undefined>((best, comment) => !best || time(comment) >= time(best) ? comment : best, undefined);
  return latest ? { text: latest.text!.trim().slice(0, 1000), authorName: latest.authorName || '', at: time(latest) ? new Date(time(latest)).toISOString() : null } : null;
}
