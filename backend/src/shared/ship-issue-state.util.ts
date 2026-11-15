/**
 * Delivery-problem states on a sale (`shipIssueState`) — two different situations, kept apart:
 *
 *   'attempt'          A delivery attempt failed (FAILED_ATTEMPT) and the courier still holds
 *                      the parcel and will try again. Someone follows up with the customer.
 *                      Ends by itself: DELIVERED → 'closed' (no failed delivery recorded),
 *                      RETURNED → 'open'. Nothing is asked about the warehouse.
 *   'open' / 'awaiting' The courier is sending the parcel BACK (RETURNED). The invoice asks
 *                      «did the return reach the warehouse?». Ends by a person: received
 *                      ('closed' + failedDelivery), shipped again ('reshipped'); or by the
 *                      courier delivering after all ('closed').
 *   'closed' / 'reshipped' / ''  nothing open.
 *
 * ⚠ Before Nov 15, 2026 a failed attempt opened 'open' too, so the invoice asked whether a
 * parcel the courier was about to re-deliver had reached the warehouse.
 */
export const SHIP_ISSUE_RETURN_STATES = ['open', 'awaiting'];
export const SHIP_ISSUE_ACTIVE_STATES = ['attempt', 'open', 'awaiting'];

/** The state a carrier problem status moves the order to. */
export function nextShipIssueState(prevState: string, prevTrigger: string, status: string): string {
  const prev = prevState || '';
  if (status === 'RETURNED') return prev === 'awaiting' ? 'awaiting' : 'open';
  // A failed attempt on a parcel already coming back (a failed return leg) does not turn the
  // return back into a delivery attempt.
  if (SHIP_ISSUE_RETURN_STATES.includes(prev) && prevTrigger === 'RETURNED') return prev;
  return 'attempt';
}

/** Orders opened as a return by a failed attempt before the split — see the note above. */
export const LEGACY_ATTEMPT_AS_RETURN_FILTER = {
  type: 'مبيعات',
  cancelled: { $ne: true },
  shipIssueState: { $in: SHIP_ISSUE_RETURN_STATES },
  shipIssueTrigger: 'FAILED_ATTEMPT',
  bostaStatus: { $ne: 'RETURNED' },
  failedDelivery: null,
};
