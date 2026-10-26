import { followUpLastActivityAt, followUpLatestComment, followUpLatestContact } from '../../src/employee-performance/followup-last-activity';

describe('latest visible follow-up comment', () => {
  it('shows the latest human comment, ignoring newer system messages and blank comments', () => {
    expect(followUpLatestComment({comments:[
      {authorId:'employee',authorName:'Sara',text:'تم التواصل مع العميل',createdAt:'2026-10-24T09:00:00Z'},
      {_id:'comment-latest',authorId:'admin',authorName:'Manager',text:'إعادة المحاولة غدًا',createdAt:'2026-10-24T10:00:00Z'},
      {authorId:'system',text:'تحديث آلي',createdAt:'2026-10-24T11:00:00Z'},
      {authorId:'employee',text:'  ',createdAt:'2026-10-24T12:00:00Z'},
    ]})).toEqual({id:'comment-latest',text:'إعادة المحاولة غدًا',authorId:'admin',authorName:'Manager',at:'2026-10-24T10:00:00.000Z'});
  });
  it('uses edits and bounds long comment previews', () => {
    const result=followUpLatestComment({comments:[
      {authorId:'one',text:'x'.repeat(2000),createdAt:'2026-10-24T08:00:00Z',updatedAt:'2026-10-24T11:00:00Z'},
      {authorId:'two',text:'older',createdAt:'2026-10-24T10:00:00Z'},
    ]});
    expect(result?.text).toHaveLength(1000);
    expect(result?.at).toBe('2026-10-24T11:00:00.000Z');
    expect(followUpLatestComment({comments:[{authorId:'system',text:'auto'}]})).toBeNull();
    expect(followUpLatestComment({})).toBeNull();
  });
});

describe('latest recorded customer contact', () => {
  it('keeps the last call separate from a newer ordinary comment or system reminder', () => {
    const contact = followUpLatestContact({ comments: [
      { _id: 'call', authorId: 'agent', authorName: 'Sara', kind: 'call', callOutcome: 'no_answer', text: 'No answer', createdAt: '2026-10-26T10:00:00Z' },
      { _id: 'note', authorId: 'agent', kind: 'note', text: 'Internal update', createdAt: '2026-10-26T11:00:00Z' },
      { _id: 'system', authorId: 'system', kind: 'call', text: 'Automated reminder', createdAt: '2026-10-26T12:00:00Z' },
    ] });
    expect(contact).toMatchObject({ id: 'call', channel: 'phone', outcome: 'no_answer', authorName: 'Sara', at: '2026-10-26T10:00:00.000Z' });
  });
  it('includes explicitly recorded Vrobo contact notes', () => {
    expect(followUpLatestContact({ comments: [{ _id: 'message', authorId: 'agent', kind: 'note', contactChannel: 'vrobo', text: 'Customer requested a callback', createdAt: '2026-10-26T12:00:00Z' }] }))
      .toMatchObject({ id: 'message', channel: 'vrobo', outcome: '' });
  });
  it('does not infer customer contact from an ordinary note', () => {
    expect(followUpLatestContact({ comments: [{ authorId: 'agent', kind: 'note', text: 'Internal update' }] })).toBeNull();
    expect(followUpLatestContact({})).toBeNull();
  });
});

describe('follow-up waiting time activity', () => {
  it('uses a newer comment instead of the old status baseline', () => {
    expect(followUpLastActivityAt({
      createdAt: '2026-10-24T08:00:00Z', escalationBaseline: '2026-10-24T09:00:00Z',
      comments: [{ createdAt: '2026-10-24T10:10:00Z' }, { createdAt: '2026-10-24T09:30:00Z' }],
    })).toBe('2026-10-24T10:10:00.000Z');
  });
  it('resets waiting time when the status changes after a comment', () => {
    expect(followUpLastActivityAt({
      escalationBaseline: new Date('2026-10-24T11:00:00Z'),
      comments: [{ createdAt: '2026-10-24T10:00:00Z' }],
    })).toBe('2026-10-24T11:00:00.000Z');
  });
  it('counts comment edits as activity', () => {
    expect(followUpLastActivityAt({
      comments: [{ createdAt: '2026-10-24T09:00:00Z', updatedAt: '2026-10-24T10:00:00Z' }],
    })).toBe('2026-10-24T10:00:00.000Z');
  });
  it('does not mistake an automatic reminder write for a comment or status change', () => {
    const followUp = { createdAt: '2026-10-24T09:00:00Z', updatedAt: '2026-10-24T12:00:00Z' };
    expect(followUpLastActivityAt(followUp)).toBe('2026-10-24T09:00:00.000Z');
  });
  it('does not fabricate dates from missing or invalid timestamps', () => {
    expect(followUpLastActivityAt({})).toBeNull();
    expect(followUpLastActivityAt({ escalationBaseline: 'invalid', comments: [{ createdAt: 'invalid' }] })).toBeNull();
  });
});
