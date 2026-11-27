import { PresenceGateway } from '../../src/auth/presence.gateway';

export {};

function makeGateway(users: Array<{ socketId: string; role: string }>) {
  const sent: Array<{ to: string; event: string; payload: any }> = [];
  const server: any = {
    emit: (event: string, payload: any) => sent.push({ to: '*', event, payload }),
    to: (ids: string[]) => ({ emit: (event: string, payload: any) => sent.push({ to: 'admins:' + ids.join(','), event, payload }) }),
    except: (ids: string[]) => ({ emit: (event: string, payload: any) => sent.push({ to: 'others:' + ids.join(','), event, payload }) }),
  };
  const gw = new PresenceGateway({} as any, {} as any, {} as any);
  (gw as any).server = server;
  const map: Map<string, any> = (gw as any).connectedUsers;
  users.forEach((u, i) => map.set(u.socketId, { userId: 'u' + i, socketId: u.socketId, role: u.role }));
  return { gw, sent };
}

const full = { reason: 'expense', amount: -7000, seg: 'instapay', balances: { total: 50000 }, entityLabel: 'Nova', txId: 't1' };

describe('vault:changed reaches employees without money', () => {
  it('admins get the full payload, employees only reason + txId', () => {
    const { gw, sent } = makeGateway([{ socketId: 'a', role: 'admin' }, { socketId: 's', role: 'staff' }]);
    gw.emitEvent('vault:changed', full);
    expect(sent).toEqual([
      { to: 'admins:a', event: 'vault:changed', payload: full },
      { to: 'others:a', event: 'vault:changed', payload: { reason: 'expense', txId: 't1' } },
    ]);
  });

  it('with no admin online everyone gets the bare signal', () => {
    const { gw, sent } = makeGateway([{ socketId: 's', role: 'staff' }]);
    gw.emitEvent('vault:changed', full);
    expect(sent).toEqual([{ to: '*', event: 'vault:changed', payload: { reason: 'expense', txId: 't1' } }]);
  });

  it('other events are still broadcast unchanged', () => {
    const { gw, sent } = makeGateway([{ socketId: 's', role: 'staff' }]);
    gw.emitEvent('tx:created', { _id: 'x' });
    expect(sent).toEqual([{ to: '*', event: 'tx:created', payload: { _id: 'x' } }]);
  });
});
