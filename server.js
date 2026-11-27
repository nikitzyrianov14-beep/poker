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
let stage = 'WAITING';

const comboNamesRu = {
    'High Card': 'Старшая карта',
    'Pair': 'Пара',
    'Two Pair': 'Две пары',
    'Three of a Kind': 'Сет (Тройка)',
    'Straight': 'Стрит',
    'Flush': 'Флеш',
    'Full House': 'Фулл-хаус',
    'Four of a Kind': 'Каре',
    'Straight Flush': 'Стрит-флеш',
    'Royal Flush': 'Роял-флеш'
};

function getComboRu(cards) {
    if (!cards || cards.length < 2) return '';
    const solved = Hand.solve(cards);
    if (solved.name === 'Straight Flush' && solved.descr.includes('Royal')) {
        return 'Роял-флеш';
    }
    return comboNamesRu[solved.name] || solved.name;
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
            const combo = getComboRu(p.cards.concat(communityCards));
            io.to(p.id).emit('yourCombo', combo);
        }
    });
}

function broadcastState(message = '') {
    io.emit('gameState', {
        players: players.map((p, idx) => ({
            id: p.id,
            name: p.name,
            chips: p.chips,
            bet: p.bet,
            folded: p.folded,
            isTurn: stage !== 'WAITING' && idx === turnIndex
        })),
        communityCards,
        pot,
        currentBet,
        stage,
        message
    });
    sendPersonalCombos();
}

function nextTurn() {
    const activePlayers = players.filter(p => !p.folded);
    if (activePlayers.length === 1) {
        const winner = activePlayers.at(0);
        winner.chips += pot;
        stage = 'WAITING';
        broadcastState(`Победил ${winner.name} и забрал ${pot}!`);
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
    } else if (stage === 'FLOP') {
        stage = 'TURN';
        communityCards.push(deck.pop());
    } else if (stage === 'TURN') {
        stage = 'RIVER';
        communityCards.push(deck.pop());
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
    const solved = activePlayers.map(p => {
        const hand = Hand.solve(p.cards.concat(communityCards));
        hand.player = p;
        hand.ruName = getComboRu(p.cards.concat(communityCards));
        return hand;
    });
    const winners = Hand.winners(solved);
    const winAmount = Math.floor(pot / winners.length);
    winners.forEach(w => w.player.chips += winAmount);

    const names = winners.map(w => `${w.player.name} (${w.ruName})`).join(', ');
    broadcastState(`Победитель: ${names}! Выигрыш: ${winAmount}`);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (name) => {
        players.push({ id: socket.id, name, cards: [], chips: 1000, bet: 0, folded: false, acted: false });
        broadcastState(`${name} сел за стол`);
    });

    socket.on('startHand', () => {
        if (players.length < 2) return;
        deck = createDeck();
        communityCards = [];
        pot = 30;
        currentBet = 20;
        stage = 'PREFLOP';

        players.forEach(p => {
            p.cards = [deck.pop(), deck.pop()];
            p.folded = false;
            p.bet = 0;
            p.acted = false;
            io.to(p.id).emit('yourCards', p.cards);
        });

        const sb = players.at(0);
        const bb = players.at(1 % players.length);
        sb.chips -= 10; sb.bet = 10;
        bb.chips -= 20; bb.bet = 20;
        turnIndex = 2 % players.length;

        broadcastState('Новая раздача! Блайнды 10/20.');
    });

    socket.on('action', ({ type, amount }) => {
        const player = players.at(turnIndex);
        if (!player || player.id !== socket.id || stage === 'WAITING') return;

        if (type === 'fold') {
            player.folded = true;
            player.acted = true;
        } else if (type === 'call') {
            const toCall = Math.min(player.chips, currentBet - player.bet);
            player.chips -= toCall;
            player.bet += toCall;
            pot += toCall;
            player.acted = true;
        } else if (type === 'raise') {
            const raiseAmt = Math.max(20, Number(amount) || 20);
            const totalTarget = currentBet + raiseAmt;
            const toAdd = Math.min(player.chips, totalTarget - player.bet);
            player.chips -= toAdd;
            player.bet += toAdd;
            pot += toAdd;
            currentBet = player.bet;
            players.forEach(p => { if (p.id !== player.id) p.acted = false; });
            player.acted = true;
        }
        nextTurn();
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length < 2) stage = 'WAITING';
        broadcastState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
