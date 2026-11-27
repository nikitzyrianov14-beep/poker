const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = [];
let deck = [];
let communityCards = [];
let pot = 0;
let currentBet = 0;
let turnIndex = 0;
let dealerIndex = 0;
let stage = 'WAITING';
let gameLogs = ['Welcome to the table!'];

function addLog(msg) {
    gameLogs.push(msg);
    if (gameLogs.length > 50) gameLogs.shift();
}

function getComboEn(cards) {
    if (!cards || cards.length < 2) return '';
    const solved = Hand.solve(cards);
    if (solved.name === 'Straight Flush' && solved.descr.includes('Royal')) {
        return 'Royal Flush';
    }
    return solved.name;
}

function createDeck() {
    const suits = ['h', 'd', 'c', 's'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    let newDeck = [];
    for (let s of suits) {
        for (let v of values) newDeck.push(v + s);
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

function sendPersonalCombos() {
    players.forEach(p => {
        if (p.cards.length === 2) {
            const combo = getComboEn(p.cards.concat(communityCards));
            io.to(p.id).emit('yourCombo', combo);
        }
    });
}

function broadcastState(message = '') {
    if (message) addLog(message);
    io.emit('gameState', {
        players: players.map((p, idx) => ({
            id: p.id,
            name: p.name,
            seat: p.seat,
            chips: p.chips,
            buyIn: p.buyIn,
            bet: p.bet,
            folded: p.folded,
            isTurn: stage !== 'WAITING' && idx === turnIndex,
            isDealer: players.length > 1 && idx === (dealerIndex % players.length),
            revealedCards: stage === 'WAITING' && p.revealed ? p.cards : []
        })),
        communityCards,
        pot,
        currentBet,
        stage,
        message,
        logs: gameLogs
    });
    sendPersonalCombos();
}

function nextTurn() {
    const activePlayers = players.filter(p => !p.folded);
    if (activePlayers.length === 1) {
        const winner = activePlayers.at(0);
        winner.chips += pot;
        stage = 'WAITING';
        dealerIndex = (dealerIndex + 1) % players.length;
        broadcastState(`${winner.name} wins $${pot.toFixed(2)} (opponents folded)!`);
        return;
    }

    const allMatched = activePlayers.every(p => p.acted && (p.bet === currentBet || p.chips === 0));
    if (allMatched) {
        nextStage();
        return;
    }

    do {
        turnIndex = (turnIndex + 1) % players.length;
    } while (players.at(turnIndex).folded || players.at(turnIndex).chips === 0);

    broadcastState();
}

function nextStage() {
    players.forEach(p => { p.bet = 0; p.acted = false; });
    currentBet = 0;

    if (stage === 'PREFLOP') {
        stage = 'FLOP';
        communityCards.push(deck.pop(), deck.pop(), deck.pop());
        addLog('--- FLOP ---');
    } else if (stage === 'FLOP') {
        stage = 'TURN';
        communityCards.push(deck.pop());
        addLog('--- TURN ---');
    } else if (stage === 'TURN') {
        stage = 'RIVER';
        communityCards.push(deck.pop());
        addLog('--- RIVER ---');
    } else if (stage === 'RIVER') {
        finishHand();
        return;
    }

    turnIndex = players.findIndex(p => !p.folded && p.chips > 0);
    if (turnIndex === -1) {
        while (communityCards.length < 5) communityCards.push(deck.pop());
        finishHand();
        return;
    }
    broadcastState();
}

function finishHand() {
    stage = 'WAITING';
    const activePlayers = players.filter(p => !p.folded);
    activePlayers.forEach(p => p.revealed = true);

    const solved = activePlayers.map(p => {
        const hand = Hand.solve(p.cards.concat(communityCards));
        hand.player = p;
        hand.enName = getComboEn(p.cards.concat(communityCards));
        return hand;
    });
    const winners = Hand.winners(solved);
    const winAmount = Number((pot / winners.length).toFixed(2));
    winners.forEach(w => w.player.chips = Number((w.player.chips + winAmount).toFixed(2)));
    dealerIndex = (dealerIndex + 1) % players.length;

    const names = winners.map(w => `${w.player.name} (${w.enName})`).join(', ');
    broadcastState(`Winner: ${names} — +$${winAmount.toFixed(2)}!`);
}

io.on('connection', (socket) => {
    socket.emit('gameState', {
        players: players.map((p, idx) => ({
            id: p.id, name: p.name, seat: p.seat, chips: p.chips, buyIn: p.buyIn,
            bet: p.bet, folded: p.folded, isTurn: false, isDealer: false, revealedCards: []
        })),
        communityCards, pot, currentBet, stage, message: '', logs: gameLogs
    });

    socket.on('joinSeat', ({ name, seat }) => {
        if (players.some(p => p.id === socket.id || p.seat === seat)) return;
        players.push({
            id: socket.id, name, seat, cards: [],
            chips: 100, buyIn: 100, bet: 0, folded: false, acted: false, revealed: false
        });
        broadcastState(`${name} took seat #${seat + 1}`);
    });

    socket.on('adjustStack', ({ addAmt, subAmt }) => {
        const p = players.find(x => x.id === socket.id);
        if (!p || stage !== 'WAITING') return;
        const add = Math.max(0, Number(addAmt) || 0);
        const sub = Math.max(0, Number(subAmt) || 0);
        if (add > 0) {
            p.chips = Number((p.chips + add).toFixed(2));
            p.buyIn = Number((p.buyIn + add).toFixed(2));
            broadcastState(`${p.name} bought in for +$${add.toFixed(2)}`);
        } else if (sub > 0 && p.chips >= sub) {
            p.chips = Number((p.chips - sub).toFixed(2));
            p.buyIn = Math.max(0, Number((p.buyIn - sub).toFixed(2)));
            broadcastState(`${p.name} removed $${sub.toFixed(2)} from stack`);
        }
    });

    socket.on('resetSession', () => {
        if (stage !== 'WAITING') return;
        players.forEach(p => { p.chips = 100; p.buyIn = 100; p.bet = 0; p.cards = []; p.revealed = false; });
        communityCards = [];
        pot = 0;
        broadcastState('Session reset! All stacks set to $100.00');
    });

    socket.on('chatMsg', (text) => {
        const p = players.find(x => x.id === socket.id);
        const sender = p ? p.name : 'Spectator';
        if (text && text.trim()) {
            io.emit('chatMessage', { sender, text: text.trim().slice(0, 120) });
        }
    });

    socket.on('startHand', () => {
        if (players.length < 2) return;
        deck = createDeck();
        communityCards = [];
        pot = 3.75;
        currentBet = 2.50;
        stage = 'PREFLOP';

        players.forEach(p => {
            p.cards = [deck.pop(), deck.pop()];
            p.folded = false;
            p.revealed = false;
            p.bet = 0;
            p.acted = false;
            io.to(p.id).emit('yourCards', p.cards);
        });

        const sbIdx = (dealerIndex + 1) % players.length;
        const bbIdx = (dealerIndex + 2) % players.length;
        const sb = players.at(sbIdx);
        const bb = players.at(bbIdx);
        sb.chips = Number((sb.chips - 1.25).toFixed(2)); sb.bet = 1.25;
        bb.chips = Number((bb.chips - 2.50).toFixed(2)); bb.bet = 2.50;
        turnIndex = (dealerIndex + 3) % players.length;

        broadcastState('New hand started! Blinds $1.25/$2.50');
    });

    socket.on('action', ({ type, amount }) => {
        const player = players.at(turnIndex);
        if (!player || player.id !== socket.id || stage === 'WAITING') return;

        if (type === 'fold') {
            player.folded = true;
            player.acted = true;
            addLog(`${player.name} folds`);
        } else if (type === 'call') {
            const toCall = Math.min(player.chips, Number((currentBet - player.bet).toFixed(2)));
            player.chips = Number((player.chips - toCall).toFixed(2));
            player.bet = Number((player.bet + toCall).toFixed(2));
            pot = Number((pot + toCall).toFixed(2));
            player.acted = true;
            addLog(toCall > 0 ? `${player.name} calls $${toCall.toFixed(2)}` : `${player.name} checks`);
        } else if (type === 'raise') {
            const raiseAmt = Math.max(2.50, Number(amount) || 2.50);
            const totalTarget = Number((currentBet + raiseAmt).toFixed(2));
            const toAdd = Math.min(player.chips, Number((totalTarget - player.bet).toFixed(2)));
            player.chips = Number((player.chips - toAdd).toFixed(2));
            player.bet = Number((player.bet + toAdd).toFixed(2));
            pot = Number((pot + toAdd).toFixed(2));
            currentBet = player.bet;
            players.forEach(p => { if (p.id !== player.id) p.acted = false; });
            player.acted = true;
            addLog(`${player.name} raises to $${player.bet.toFixed(2)}`);
        }
        nextTurn();
    });

    socket.on('disconnect', () => {
        const left = players.find(p => p.id === socket.id);
        players = players.filter(p => p.id !== socket.id);
        if (players.length < 2) stage = 'WAITING';
        if (left) broadcastState(`${left.name} left the table`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
