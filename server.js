const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static('public'));

let players = [];
let deck = [];
let communityCards = [];
let pot = 0;
let currentBet = 0;
let turnIndex = 0;
let dealerIndex = 0;
let stage = 'WAITING';
let gameLogs = ['Welcome to LIPOKER!'];
let turnDeadline = 0;
let turnTimer = null;
let autoStartTimer = null;
const TURN_SECONDS = 30;
const AUTO_NEXT_SECONDS = 7;

const FULL_DECK = [];
['h', 'd', 'c', 's'].forEach(s => {
    ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'].forEach(v => FULL_DECK.push(v + s));
});

function addLog(msg) {
    gameLogs.push(msg);
    if (gameLogs.length > 50) gameLogs.shift();
}

function getComboEn(cards) {
    if (!cards || cards.length < 2) return '';
    const solved = Hand.solve(cards);
    if (solved.name === 'Straight Flush' && solved.descr.includes('Royal')) return 'Royal Flush';
    return solved.name;
}

function calcWinOdds(myCards, boardCards, opponentsCount) {
    if (!myCards || myCards.length < 2 || opponentsCount < 1) return 100;
    const known = new Set(myCards.concat(boardCards));
    const rem = FULL_DECK.filter(c => !known.has(c));
    const needBoard = 5 - boardCards.length;
    const sims = 180;
    let score = 0;

    for (let i = 0; i < sims; i++) {
        const pool = rem.slice();
        for (let j = pool.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            const tmp = pool[j]; pool[j] = pool[k]; pool[k] = tmp;
        }
        let idx = 0;
        const simBoard = boardCards.concat(pool.slice(idx, idx + needBoard));
        idx += needBoard;

        const myHand = Hand.solve(myCards.concat(simBoard));
        const allHands = [myHand];
        for (let op = 0; op < opponentsCount; op++) {
            const opCards = [pool[idx++], pool[idx++]];
            allHands.push(Hand.solve(opCards.concat(simBoard)));
        }
        const winners = Hand.winners(allHands);
        if (winners.includes(myHand)) {
            score += 1 / winners.length;
        }
    }
    return Math.round((score / sims) * 100);
}

function createDeck() {
    return FULL_DECK.slice().sort(() => Math.random() - 0.5);
}

function clearAutoStart() {
    if (autoStartTimer) { clearTimeout(autoStartTimer); autoStartTimer = null; }
}

function scheduleAutoStart() {
    clearAutoStart();
    if (players.filter(p => p.chips > 0).length < 2 || stage !== 'WAITING') return;
    autoStartTimer = setTimeout(() => { startNewHand(); }, AUTO_NEXT_SECONDS * 1000);
}

function clearTurnTimer() {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    turnDeadline = 0;
}
function startTurnTimer() {
    clearTurnTimer();
    if (stage === 'WAITING') return;
    turnDeadline = Date.now() + TURN_SECONDS * 1000;
    turnTimer = setTimeout(() => {
        const p = players.at(turnIndex);
        if (!p || stage === 'WAITING') return;
        const toCall = Number((currentBet - p.bet).toFixed(2));
        if (toCall <= 0) {
            p.acted = true;
            io.emit('playSound', 'check');
            addLog(`${p.name} checks (timeout)`);
        } else {
            p.folded = true;
            p.acted = true;
            io.emit('playSound', 'fold');
            addLog(`${p.name} folds (timeout)`);
        }
        nextTurn();
    }, TURN_SECONDS * 1000);
}

function broadcastState(message = '') {
    if (message) addLog(message);
    const activeOpponents = players.filter(p => !p.folded && p.cards.length === 2).length - 1;
    io.emit('gameState', {
        players: players.map((p, idx) => ({
            id: p.id, name: p.name, avatar: p.avatar || '', seat: p.seat, chips: p.chips, buyIn: p.buyIn,
            bet: p.bet, folded: p.folded,
            isTurn: stage !== 'WAITING' && idx === turnIndex,
            isDealer: players.length > 1 && idx === (dealerIndex % players.length),
            revealedCards: stage === 'WAITING' && p.revealed ? p.cards : []
        })),
        communityCards, pot, currentBet, stage, message, logs: gameLogs,
        turnDeadline, turnDuration: TURN_SECONDS * 1000
    });
    players.forEach(p => {
        if (p.cards.length === 2 && !p.folded) {
            const combo = getComboEn(p.cards.concat(communityCards));
            const winPct = stage !== 'WAITING' ? calcWinOdds(p.cards, communityCards, Math.max(1, activeOpponents)) : null;
            io.to(p.id).emit('yourCombo', { combo, winPct });
        } else {
            io.to(p.id).emit('yourCombo', { combo: '', winPct: null });
        }
    });
}

function startNewHand() {
    clearAutoStart();
    const eligible = players.filter(p => p.chips > 0);
    if (eligible.length < 2 || stage !== 'WAITING') return;
    deck = createDeck();
    communityCards = [];
    currentBet = 2.50;
    stage = 'PREFLOP';

    players.forEach(p => {
        if (p.chips > 0) { p.cards = [deck.pop(), deck.pop()]; p.folded = false; }
        else { p.cards = []; p.folded = true; }
        p.revealed = false; p.bet = 0; p.acted = false;
        io.to(p.id).emit('yourCards', p.cards);
    });

    const n = players.length;
    const dIdx = dealerIndex % n;
    const sbIdx = n === 2 ? dIdx : (dIdx + 1) % n;
    const bbIdx = n === 2 ? (dIdx + 1) % n : (dIdx + 2) % n;
    const sb = players.at(sbIdx), bb = players.at(bbIdx);
    const sbPay = Math.min(sb.chips, 1.25), bbPay = Math.min(bb.chips, 2.50);
    sb.chips = Number((sb.chips - sbPay).toFixed(2)); sb.bet = sbPay;
    bb.chips = Number((bb.chips - bbPay).toFixed(2)); bb.bet = bbPay;
    pot = Number((sbPay + bbPay).toFixed(2));

    turnIndex = n === 2 ? sbIdx : (dIdx + 3) % n;
    startTurnTimer();
    broadcastState('New hand! Blinds $1.25 / $2.50');
}

function nextTurn() {
    const active = players.filter(p => !p.folded);
    if (active.length === 1) {
        clearTurnTimer();
        const w = active.at(0);
        w.chips = Number((w.chips + pot).toFixed(2));
        stage = 'WAITING';
        dealerIndex = (dealerIndex + 1) % players.length;
        broadcastState(`${w.name} wins $${pot.toFixed(2)}! Next hand in ${AUTO_NEXT_SECONDS}s...`);
        scheduleAutoStart();
        return;
    }
    if (active.every(p => p.acted && (p.bet === currentBet || p.chips === 0))) {
        nextStage();
        return;
    }
    do { turnIndex = (turnIndex + 1) % players.length; }
    while (players.at(turnIndex).folded || players.at(turnIndex).chips === 0);
    startTurnTimer();
    broadcastState();
}

function nextStage() {
    players.forEach(p => { p.bet = 0; p.acted = false; });
    currentBet = 0;
    if (stage === 'PREFLOP') { stage = 'FLOP'; communityCards.push(deck.pop(), deck.pop(), deck.pop()); addLog('--- FLOP ---'); }
    else if (stage === 'FLOP') { stage = 'TURN'; communityCards.push(deck.pop()); addLog('--- TURN ---'); }
    else if (stage === 'TURN') { stage = 'RIVER'; communityCards.push(deck.pop()); addLog('--- RIVER ---'); }
    else if (stage === 'RIVER') { finishHand(); return; }

    turnIndex = players.findIndex(p => !p.folded && p.chips > 0);
    if (turnIndex === -1) {
        clearTurnTimer();
        while (communityCards.length < 5) communityCards.push(deck.pop());
        finishHand();
        return;
    }
    startTurnTimer();
    broadcastState();
}

function finishHand() {
    clearTurnTimer();
    stage = 'WAITING';
    const active = players.filter(p => !p.folded);
    active.forEach(p => p.revealed = true);
    const solved = active.map(p => {
        const h = Hand.solve(p.cards.concat(communityCards));
        h.player = p; h.enName = getComboEn(p.cards.concat(communityCards));
        return h;
    });
    const winners = Hand.winners(solved);
    const winAmt = Number((pot / winners.length).toFixed(2));
    winners.forEach(w => w.player.chips = Number((w.player.chips + winAmt).toFixed(2)));
    dealerIndex = (dealerIndex + 1) % players.length;

    const names = winners.map(w => `${w.player.name} (${w.enName})`).join(', ');
    broadcastState(`Winner: ${names} (+$${winAmt.toFixed(2)})! Next hand in ${AUTO_NEXT_SECONDS}s...`);
    scheduleAutoStart();
}

io.on('connection', (socket) => {
    broadcastState();

    socket.on('joinSeat', ({ name, avatar, seat }) => {
        if (players.some(p => p.id === socket.id || p.seat === seat)) return;
        players.push({
            id: socket.id, name, avatar: avatar || '', seat, cards: [],
            chips: 100, buyIn: 100, bet: 0, folded: false, acted: false, revealed: false
        });
        if (players.length >= 2 && stage === 'WAITING') {
            broadcastState(`${name} took seat #${seat + 1}. Starting in ${AUTO_NEXT_SECONDS}s...`);
            scheduleAutoStart();
        } else {
            broadcastState(`${name} took seat #${seat + 1}`);
        }
    });

    socket.on('startHand', () => startNewHand());

        socket.on('showCards', () => {
        const p = players.find(x => x.id === socket.id);
        if (!p || stage !== 'WAITING' || p.cards.length !== 2 || p.revealed) return;
        p.revealed = true;
        broadcastState(`${p.name} shows cards!`);
    });

    socket.on('changeAvatar', (avatar) => {
        const p = players.find(x => x.id === socket.id);
        if (!p || !avatar) return;
        p.avatar = avatar;
        broadcastState();
    });


    socket.on('adjustStack', ({ addAmt, subAmt }) => {
        const p = players.find(x => x.id === socket.id);
        if (!p || stage !== 'WAITING') return;
        const add = Math.max(0, Number(addAmt) || 0), sub = Math.max(0, Number(subAmt) || 0);
        if (add > 0) {
            p.chips = Number((p.chips + add).toFixed(2));
            p.buyIn = Number((p.buyIn + add).toFixed(2));
            broadcastState(`${p.name} bought in +$${add.toFixed(2)}`);
            if (players.filter(x => x.chips > 0).length >= 2) scheduleAutoStart();
        } else if (sub > 0 && p.chips >= sub) {
            p.chips = Number((p.chips - sub).toFixed(2));
            p.buyIn = Math.max(0, Number((p.buyIn - sub).toFixed(2)));
            broadcastState(`${p.name} subtracted $${sub.toFixed(2)}`);
        }
    });

    socket.on('resetSession', () => {
        if (stage !== 'WAITING') return;
        clearTurnTimer(); clearAutoStart();
        players.forEach(p => { p.chips = 100; p.buyIn = 100; p.bet = 0; p.cards = []; p.revealed = false; });
        communityCards = []; pot = 0;
        broadcastState('Session reset! All stacks set to $100.00');
        scheduleAutoStart();
    });

    socket.on('chatMsg', (text) => {
        const p = players.find(x => x.id === socket.id);
        if (text && text.trim()) io.emit('chatMessage', { sender: p ? p.name : 'Guest', text: text.trim().slice(0, 120) });
    });

    socket.on('action', ({ type, amount }) => {
        const p = players.at(turnIndex);
        if (!p || p.id !== socket.id || stage === 'WAITING') return;
        if (type === 'fold') { p.folded = true; p.acted = true; io.emit('playSound', 'fold'); addLog(`${p.name} folds`); }
        else if (type === 'call') {
            const toCall = Math.min(p.chips, Number((currentBet - p.bet).toFixed(2)));
            p.chips = Number((p.chips - toCall).toFixed(2)); p.bet = Number((p.bet + toCall).toFixed(2));
            pot = Number((pot + toCall).toFixed(2)); p.acted = true;
            if (p.chips === 0 && toCall > 0) io.emit('playSound', 'allin');
            else io.emit('playSound', toCall > 0 ? 'call' : 'check');
            addLog(toCall > 0 ? `${p.name} calls $${toCall.toFixed(2)}` : `${p.name} checks`);
        } else if (type === 'raise') {
            const raiseAmt = Math.max(2.50, Number(amount) || 2.50);
            const target = Number((currentBet + raiseAmt).toFixed(2));
            const toAdd = Math.min(p.chips, Number((target - p.bet).toFixed(2)));
            p.chips = Number((p.chips - toAdd).toFixed(2)); p.bet = Number((p.bet + toAdd).toFixed(2));
            pot = Number((pot + toAdd).toFixed(2)); currentBet = p.bet;
            players.forEach(x => { if (x.id !== p.id) x.acted = false; }); p.acted = true;
            if (p.chips === 0) { io.emit('playSound', 'allin'); addLog(`${p.name} goes ALL-IN ($${p.bet.toFixed(2)})!`); }
            else { io.emit('playSound', 'raise'); addLog(`${p.name} raises to $${p.bet.toFixed(2)}`); }
        }
        nextTurn();
    });

    socket.on('disconnect', () => {
        const left = players.find(p => p.id === socket.id);
        players = players.filter(p => p.id !== socket.id);
        if (players.length < 2) { clearTurnTimer(); clearAutoStart(); stage = 'WAITING'; }
        if (left) broadcastState(`${left.name} left the table`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
