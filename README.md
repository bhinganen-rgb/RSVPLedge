# RSVPledge

**The RSVP that means it.** Event RSVPs with refundable deposits on BOT Chain.

## Why

Free RSVPs are worthless. RSVPledge asks every attendee to stake a deposit when they commit. Show up → get your deposit back. Flake → your deposit is split between the host and the attendees who did show up.

## Mechanics

1. **Host creates an event** with a title, cap, deposit amount, RSVP cutoff, event date, and a no-show split (0–100% of forfeited deposits going to host; the rest is split pro-rata among attendees who showed).
2. **Attendees RSVP** by sending exactly the deposit amount. They can cancel any time before the RSVP cutoff for a full refund.
3. **After the event date** (up to a grace window, default 7 days), the host calls `markAttended` with the addresses that actually showed up.
4. **After the grace window**, anyone can call `finalizeEvent`. The contract computes the no-show forfeitures, deducts a small platform fee (default 0.5%, capped at 5%), sends the host their configured cut, and reserves the rest as an attendee bonus pool.
5. **Attendees who showed** call `claimRefund` (their original deposit) and `claimShowUpBonus` (their pro-rata slice of the forfeited pool).

## Networks

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Testnet | 968 | https://rpc.bohr.life | https://scan.bohr.life |
| Mainnet | 677 | https://rpc.botchain.ai | https://scan.botchain.ai |

## Quickstart

```bash
npm install
cp .env.example .env    # add your PRIVATE_KEY
npm test
npm run deploy:testnet
```

Then paste the deployed address into `CONTRACT_ADDRESS` at the top of `frontend/index.html`. Serve `frontend/` with any static host (Vercel config included).

## Contract surface

- `createEvent`, `rsvp`, `cancelRsvp`, `markAttended`
- `finalizeEvent` (permissionless), `claimRefund`, `claimShowUpBonus`
- Views: `getEvent`, `getAttendees`, `getAttendeeStatus`, `getEventsByHost`, `getEventsByAttendee`, `eventCount`
- Admin: `pause`, `unpause`, `setPlatformFeeBps` (max 5%), `setFinalizeGrace` (1–30 days), `withdrawFees`

Built with OpenZeppelin `Ownable`, `ReentrancyGuard`, and `Pausable`.
