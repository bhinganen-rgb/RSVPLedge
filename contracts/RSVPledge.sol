// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title RSVPledge — event RSVPs with refundable deposits
/// @notice Attendees put skin in the game. Show up → refund. Flake → forfeit and split with those who showed.
contract RSVPledge is Ownable, ReentrancyGuard, Pausable {
    enum Status { Open, Locked, Finalized }

    struct EventInfo {
        address host;
        string title;
        string description;
        uint16 cap;
        uint256 depositAmount;
        uint256 rsvpCutoff;
        uint256 eventDate;
        uint16 noShowSplitBps; // portion of (forfeit - platformFee) that goes to host
        uint16 rsvpCount;
        uint16 attendedCount;
        Status status;
        uint256 hostPayout;      // set at finalize
        uint256 attendeeBonusPot; // set at finalize (pool split among attendees)
    }

    uint16 public platformFeeBps = 50; // 0.5% of forfeited pool
    uint16 public constant MAX_PLATFORM_FEE_BPS = 500; // 5%
    uint256 public finalizeGrace = 7 days;
    uint256 public constant MIN_GRACE = 1 days;
    uint256 public constant MAX_GRACE = 30 days;
    uint256 public accumulatedFees;

    uint256 private _eventCount;
    mapping(uint256 => EventInfo) private events;
    mapping(uint256 => address[]) private attendeeList;
    mapping(uint256 => mapping(address => bool)) public hasRSVPd;
    mapping(uint256 => mapping(address => bool)) public attended;
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    mapping(uint256 => mapping(address => bool)) public bonusClaimed;
    mapping(address => uint256[]) private hostedByAddress;
    mapping(address => uint256[]) private rsvpdByAddress;

    event EventCreated(uint256 indexed eventId, address indexed host, string title, uint256 depositAmount, uint256 eventDate);
    event RSVPed(uint256 indexed eventId, address indexed attendee, uint256 deposit);
    event RSVPCancelled(uint256 indexed eventId, address indexed attendee);
    event MarkedAttended(uint256 indexed eventId, uint256 count);
    event EventFinalized(uint256 indexed eventId, uint256 forfeited, uint256 hostPayout, uint256 attendeePool, uint256 platformFee);
    event RefundClaimed(uint256 indexed eventId, address indexed attendee, uint256 amount);
    event BonusClaimed(uint256 indexed eventId, address indexed attendee, uint256 amount);

    constructor() Ownable(msg.sender) {}

    function createEvent(
        string calldata title,
        string calldata description,
        uint16 cap,
        uint256 depositAmount,
        uint256 rsvpCutoff,
        uint256 eventDate,
        uint16 noShowSplitBps
    ) external whenNotPaused returns (uint256 eventId) {
        require(bytes(title).length > 0 && bytes(title).length <= 120, "title");
        require(bytes(description).length <= 2000, "desc");
        require(cap >= 1 && cap <= 1000, "cap");
        require(depositAmount > 0, "deposit=0");
        require(rsvpCutoff > block.timestamp, "cutoff past");
        require(eventDate > rsvpCutoff, "date<=cutoff");
        require(noShowSplitBps <= 10000, "bps");

        eventId = _eventCount++;
        EventInfo storage e = events[eventId];
        e.host = msg.sender;
        e.title = title;
        e.description = description;
        e.cap = cap;
        e.depositAmount = depositAmount;
        e.rsvpCutoff = rsvpCutoff;
        e.eventDate = eventDate;
        e.noShowSplitBps = noShowSplitBps;
        e.status = Status.Open;

        hostedByAddress[msg.sender].push(eventId);
        emit EventCreated(eventId, msg.sender, title, depositAmount, eventDate);
    }

    function rsvp(uint256 eventId) external payable whenNotPaused nonReentrant {
        EventInfo storage e = events[eventId];
        require(e.host != address(0), "no event");
        require(block.timestamp < e.rsvpCutoff, "cutoff");
        require(msg.value == e.depositAmount, "value");
        require(!hasRSVPd[eventId][msg.sender], "dup");
        require(e.rsvpCount < e.cap, "full");

        hasRSVPd[eventId][msg.sender] = true;
        attendeeList[eventId].push(msg.sender);
        e.rsvpCount += 1;
        rsvpdByAddress[msg.sender].push(eventId);
        emit RSVPed(eventId, msg.sender, msg.value);
    }

    function cancelRsvp(uint256 eventId) external whenNotPaused nonReentrant {
        EventInfo storage e = events[eventId];
        require(hasRSVPd[eventId][msg.sender], "not rsvpd");
        require(block.timestamp < e.rsvpCutoff, "cutoff");

        hasRSVPd[eventId][msg.sender] = false;
        e.rsvpCount -= 1;

        // remove from attendeeList (swap+pop)
        address[] storage list = attendeeList[eventId];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == msg.sender) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }

        uint256 amt = e.depositAmount;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "refund fail");
        emit RSVPCancelled(eventId, msg.sender);
    }

    function markAttended(uint256 eventId, address[] calldata addrs) external whenNotPaused {
        EventInfo storage e = events[eventId];
        require(msg.sender == e.host, "not host");
        require(block.timestamp >= e.eventDate, "not yet");
        require(block.timestamp <= e.eventDate + finalizeGrace, "grace over");
        require(e.status != Status.Finalized, "finalized");

        uint256 marked = 0;
        for (uint256 i = 0; i < addrs.length; i++) {
            address a = addrs[i];
            if (hasRSVPd[eventId][a] && !attended[eventId][a]) {
                attended[eventId][a] = true;
                e.attendedCount += 1;
                marked += 1;
            }
        }
        emit MarkedAttended(eventId, marked);
    }

    function finalizeEvent(uint256 eventId) external whenNotPaused {
        EventInfo storage e = events[eventId];
        require(e.host != address(0), "no event");
        require(e.status != Status.Finalized, "done");
        require(block.timestamp > e.eventDate + finalizeGrace, "grace");

        uint256 noShows = uint256(e.rsvpCount) - uint256(e.attendedCount);
        uint256 forfeited = noShows * e.depositAmount;
        uint256 fee = 0;
        uint256 hostShare = 0;
        uint256 attendeePool = 0;

        if (forfeited > 0) {
            fee = (forfeited * platformFeeBps) / 10000;
            uint256 net = forfeited - fee;
            hostShare = (net * e.noShowSplitBps) / 10000;
            attendeePool = net - hostShare;
            accumulatedFees += fee;
        }

        e.hostPayout = hostShare;
        e.attendeeBonusPot = attendeePool;
        e.status = Status.Finalized;

        if (hostShare > 0) {
            (bool ok, ) = e.host.call{value: hostShare}("");
            require(ok, "host pay");
        }
        emit EventFinalized(eventId, forfeited, hostShare, attendeePool, fee);
    }

    function claimRefund(uint256 eventId) external nonReentrant {
        EventInfo storage e = events[eventId];
        require(e.status == Status.Finalized, "not final");
        require(attended[eventId][msg.sender], "not attended");
        require(!refundClaimed[eventId][msg.sender], "claimed");

        refundClaimed[eventId][msg.sender] = true;
        uint256 amt = e.depositAmount;
        (bool ok, ) = msg.sender.call{value: amt}("");
        require(ok, "xfer");
        emit RefundClaimed(eventId, msg.sender, amt);
    }

    function claimShowUpBonus(uint256 eventId) external nonReentrant {
        EventInfo storage e = events[eventId];
        require(e.status == Status.Finalized, "not final");
        require(attended[eventId][msg.sender], "not attended");
        require(!bonusClaimed[eventId][msg.sender], "claimed");
        require(e.attendedCount > 0, "none");

        bonusClaimed[eventId][msg.sender] = true;
        uint256 share = e.attendeeBonusPot / e.attendedCount;
        if (share > 0) {
            (bool ok, ) = msg.sender.call{value: share}("");
            require(ok, "xfer");
        }
        emit BonusClaimed(eventId, msg.sender, share);
    }

    // ---------- Views ----------
    function getEvent(uint256 eventId) external view returns (
        address host, string memory title, string memory description,
        uint16 cap, uint256 depositAmount, uint256 rsvpCutoff, uint256 eventDate,
        uint16 noShowSplitBps, uint16 rsvpCount, uint16 attendedCount, uint8 status
    ) {
        EventInfo storage e = events[eventId];
        uint8 s = uint8(e.status);
        if (e.status == Status.Open && block.timestamp >= e.rsvpCutoff) s = uint8(Status.Locked);
        return (e.host, e.title, e.description, e.cap, e.depositAmount, e.rsvpCutoff, e.eventDate, e.noShowSplitBps, e.rsvpCount, e.attendedCount, s);
    }

    function getAttendees(uint256 eventId) external view returns (address[] memory) {
        return attendeeList[eventId];
    }

    function getAttendeeStatus(uint256 eventId, address a) external view returns (bool rsvpd, bool att, bool refunded, bool bonus) {
        return (hasRSVPd[eventId][a], attended[eventId][a], refundClaimed[eventId][a], bonusClaimed[eventId][a]);
    }

    function getEventsByHost(address a) external view returns (uint256[] memory) { return hostedByAddress[a]; }
    function getEventsByAttendee(address a) external view returns (uint256[] memory) { return rsvpdByAddress[a]; }
    function eventCount() external view returns (uint256) { return _eventCount; }

    // ---------- Admin ----------
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setPlatformFeeBps(uint16 bps) external onlyOwner {
        require(bps <= MAX_PLATFORM_FEE_BPS, "max 5%");
        platformFeeBps = bps;
    }

    function setFinalizeGrace(uint256 g) external onlyOwner {
        require(g >= MIN_GRACE && g <= MAX_GRACE, "range");
        finalizeGrace = g;
    }

    function withdrawFees(address to) external onlyOwner nonReentrant {
        uint256 amt = accumulatedFees;
        accumulatedFees = 0;
        (bool ok, ) = to.call{value: amt}("");
        require(ok, "xfer");
    }
}
