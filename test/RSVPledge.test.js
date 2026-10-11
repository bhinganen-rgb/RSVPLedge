const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("RSVPledge", function () {
  let c, owner, host, a1, a2, a3, a4;
  const DEPOSIT = ethers.parseEther("1");

  async function mkEvent(splitBps = 5000, cap = 10) {
    const now = await time.latest();
    const cutoff = now + 3600;
    const eventDate = now + 7200;
    const tx = await c.connect(host).createEvent("Meetup", "desc", cap, DEPOSIT, cutoff, eventDate, splitBps);
    const r = await tx.wait();
    return { cutoff, eventDate, id: 0n };
  }

  beforeEach(async () => {
    [owner, host, a1, a2, a3, a4] = await ethers.getSigners();
    const F = await ethers.getContractFactory("RSVPledge");
    c = await F.deploy();
  });

  it("createEvent validates inputs", async () => {
    const now = await time.latest();
    await expect(c.createEvent("", "d", 10, DEPOSIT, now + 100, now + 200, 5000)).to.be.revertedWith("title");
    await expect(c.createEvent("t", "d", 0, DEPOSIT, now + 100, now + 200, 5000)).to.be.revertedWith("cap");
    await expect(c.createEvent("t", "d", 10, 0, now + 100, now + 200, 5000)).to.be.revertedWith("deposit=0");
    await expect(c.createEvent("t", "d", 10, DEPOSIT, now - 1, now + 200, 5000)).to.be.revertedWith("cutoff past");
    await expect(c.createEvent("t", "d", 10, DEPOSIT, now + 100, now + 50, 5000)).to.be.revertedWith("date<=cutoff");
    await expect(c.createEvent("t", "d", 10, DEPOSIT, now + 100, now + 200, 10001)).to.be.revertedWith("bps");
  });

  it("rsvp requires exact deposit, respects cap, blocks duplicates", async () => {
    await mkEvent(5000, 2);
    await expect(c.connect(a1).rsvp(0, { value: DEPOSIT + 1n })).to.be.revertedWith("value");
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await expect(c.connect(a1).rsvp(0, { value: DEPOSIT })).to.be.revertedWith("dup");
    await c.connect(a2).rsvp(0, { value: DEPOSIT });
    await expect(c.connect(a3).rsvp(0, { value: DEPOSIT })).to.be.revertedWith("full");
  });

  it("cancelRsvp refunds fully before cutoff", async () => {
    await mkEvent();
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    const bal0 = await ethers.provider.getBalance(a1.address);
    const tx = await c.connect(a1).cancelRsvp(0);
    const r = await tx.wait();
    const gas = r.gasUsed * r.gasPrice;
    const bal1 = await ethers.provider.getBalance(a1.address);
    expect(bal1 - bal0 + gas).to.equal(DEPOSIT);
  });

  it("cancelRsvp fails after cutoff", async () => {
    await mkEvent();
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await time.increase(3700);
    await expect(c.connect(a1).cancelRsvp(0)).to.be.revertedWith("cutoff");
  });

  it("markAttended host-only and RSVP-gated", async () => {
    await mkEvent();
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await c.connect(a2).rsvp(0, { value: DEPOSIT });
    await time.increase(7300);
    await expect(c.connect(a1).markAttended(0, [a1.address])).to.be.revertedWith("not host");
    await c.connect(host).markAttended(0, [a1.address, a3.address]); // a3 not rsvpd → ignored
    const s1 = await c.getAttendeeStatus(0, a1.address);
    const s3 = await c.getAttendeeStatus(0, a3.address);
    expect(s1[1]).to.equal(true);
    expect(s3[1]).to.equal(false);
  });

  it("finalize requires grace elapsed, computes split correctly", async () => {
    await mkEvent(6000); // 60% host / 40% attendees of net
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await c.connect(a2).rsvp(0, { value: DEPOSIT });
    await c.connect(a3).rsvp(0, { value: DEPOSIT });
    await c.connect(a4).rsvp(0, { value: DEPOSIT });
    await time.increase(7300);
    await c.connect(host).markAttended(0, [a1.address, a2.address]); // 2 no-shows
    await expect(c.finalizeEvent(0)).to.be.revertedWith("grace");
    await time.increase(7 * 24 * 3600 + 10);

    const forfeit = DEPOSIT * 2n;
    const fee = (forfeit * 50n) / 10000n;
    const net = forfeit - fee;
    const hostShare = (net * 6000n) / 10000n;
    const attPool = net - hostShare;

    const hostBal0 = await ethers.provider.getBalance(host.address);
    await c.finalizeEvent(0);
    const hostBal1 = await ethers.provider.getBalance(host.address);
    expect(hostBal1 - hostBal0).to.equal(hostShare);
    expect(await c.accumulatedFees()).to.equal(fee);

    const ev = await c.getEvent(0);
    expect(ev.status).to.equal(2);
  });

  it("claimRefund only for attended, no double-claim", async () => {
    await mkEvent();
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await c.connect(a2).rsvp(0, { value: DEPOSIT });
    await time.increase(7300);
    await c.connect(host).markAttended(0, [a1.address]);
    await time.increase(7 * 24 * 3600 + 10);
    await c.finalizeEvent(0);

    await expect(c.connect(a2).claimRefund(0)).to.be.revertedWith("not attended");
    await c.connect(a1).claimRefund(0);
    await expect(c.connect(a1).claimRefund(0)).to.be.revertedWith("claimed");
  });

  it("claimShowUpBonus splits pro-rata; no-shows get nothing", async () => {
    await mkEvent(0); // 0% host, 100% to attendees
    for (const s of [a1, a2, a3, a4]) await c.connect(s).rsvp(0, { value: DEPOSIT });
    await time.increase(7300);
    await c.connect(host).markAttended(0, [a1.address, a2.address]); // 2 attended, 2 no-shows
    await time.increase(7 * 24 * 3600 + 10);
    await c.finalizeEvent(0);

    const forfeit = DEPOSIT * 2n;
    const fee = (forfeit * 50n) / 10000n;
    const attPool = forfeit - fee; // all to attendees
    const perAttendee = attPool / 2n;

    const b0 = await ethers.provider.getBalance(a1.address);
    const tx = await c.connect(a1).claimShowUpBonus(0);
    const r = await tx.wait();
    const b1 = await ethers.provider.getBalance(a1.address);
    expect(b1 - b0 + r.gasUsed * r.gasPrice).to.equal(perAttendee);

    await expect(c.connect(a3).claimShowUpBonus(0)).to.be.revertedWith("not attended");
    await c.connect(a2).claimShowUpBonus(0);
    await expect(c.connect(a2).claimShowUpBonus(0)).to.be.revertedWith("claimed");
  });

  it("pause blocks create/rsvp", async () => {
    await c.pause();
    const now = await time.latest();
    await expect(c.createEvent("t", "d", 5, DEPOSIT, now + 100, now + 200, 5000)).to.be.reverted;
  });

  it("platform fee capped at 5%", async () => {
    await expect(c.setPlatformFeeBps(501)).to.be.revertedWith("max 5%");
    await c.setPlatformFeeBps(500);
    expect(await c.platformFeeBps()).to.equal(500);
  });

  it("finalize grace bounds", async () => {
    await expect(c.setFinalizeGrace(100)).to.be.revertedWith("range");
    await expect(c.setFinalizeGrace(31 * 86400)).to.be.revertedWith("range");
    await c.setFinalizeGrace(2 * 86400);
  });

  it("getters expose event data and locked status", async () => {
    await mkEvent();
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    let ev = await c.getEvent(0);
    expect(ev.status).to.equal(0);
    await time.increase(3700);
    ev = await c.getEvent(0);
    expect(ev.status).to.equal(1);
    const hosted = await c.getEventsByHost(host.address);
    const rsvpd = await c.getEventsByAttendee(a1.address);
    expect(hosted.length).to.equal(1);
    expect(rsvpd.length).to.equal(1);
    expect(await c.eventCount()).to.equal(1);
  });

  it("withdrawFees moves accumulated to recipient", async () => {
    await mkEvent(10000);
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await time.increase(7300);
    // nobody attended
    await time.increase(7 * 24 * 3600 + 10);
    await c.finalizeEvent(0);
    const fee = (DEPOSIT * 50n) / 10000n;
    expect(await c.accumulatedFees()).to.equal(fee);
    const to = a4.address;
    const b0 = await ethers.provider.getBalance(to);
    await c.withdrawFees(to);
    const b1 = await ethers.provider.getBalance(to);
    expect(b1 - b0).to.equal(fee);
  });

  it("attendee cannot claim on non-finalized event", async () => {
    await mkEvent();
    await c.connect(a1).rsvp(0, { value: DEPOSIT });
    await expect(c.connect(a1).claimRefund(0)).to.be.revertedWith("not final");
    await expect(c.connect(a1).claimShowUpBonus(0)).to.be.revertedWith("not final");
  });
});
