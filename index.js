const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const activePlayers = new Map();

const CONFIG_DIR = path.join(__dirname, '.npm');
const CONFIG_FILE = path.join(CONFIG_DIR, 'losy_players_config.json');

const RECONNECT_DELAYS = [5000, 10000, 20000, 40000, 60000];
const PATHFINDER_TIMEOUT_MS = 15000;
const WANDER_RADIUS = 8;
const WANDER_RADIUS_LONG = 18;

const CHAT_DB = {
    greetings: [
        "hey", "yo", "hi", "sup", "heyyy", "hiii", "heyy",
        "hey all", "yo guys", "hi everyone", "wassup"
    ],
    idle: [
        "anyone here?", "lol", "afk rn", "so bored",
        "a bit laggy today", "gonna afk for a bit",
        "anyone around?", "nice", "gonna get some water brb",
        "bruh", "man", "hmm", "this server good",
        "lag?", "ping high rn", "wdym", "wtf lol"
    ],
    interaction: [
        "?", "what did u say", "i see", "indeed",
        "hahaha", "pro", "nice", "here", "lmao", "fr?",
        "no way", "true", "facts", "same lol", "ikr"
    ],
    suffixes: ["~", "...", " ha", " ya", "!", " lol", " lmao", " haha"]
};

function maybeAddSuffix(msg) {
    if (Math.random() > 0.65) {
        return msg + CHAT_DB.suffixes[Math.floor(Math.random() * CHAT_DB.suffixes.length)];
    }
    return msg;
}

function randomFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function saveConfig() {
    const configList = Array.from(activePlayers.values()).map(b => ({
        serverName: b.serverName,
        ipPort: `${b.host}:${b.port}`,
        playerName: b.username,
        startTime: b.startTime,
        stopTime: b.stopTime
    }));
    try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configList, null, 2));
    } catch (err) {
        console.error("[System] Failed to save config:", err);
    }
}

function parseIpPort(ipPort) {
    let host = ipPort;
    let port = 25565;
    if (ipPort.includes(':')) {
        const parts = ipPort.split(':');
        host = parts[0];
        port = parseInt(parts[1]) || 25565;
    }
    return { host, port };
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return;
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        const players = JSON.parse(data);
        console.log(`[System] Found saved config. Loading ${players.length} players...`);
        players.forEach(p => {
            const playerId = 'player_' + Date.now() + randomInt(100, 999);
            const { host, port } = parseIpPort(p.ipPort || '');
            const playerMeta = createPlayerMeta(playerId, p.serverName || 'Unknown Server', host, port, p.playerName, p.startTime || null, p.stopTime || null);
            activePlayers.set(playerId, playerMeta);
            if (p.startTime) {
                playerMeta.status = 'Waiting...';
                console.log(`[Schedule] Player [${p.playerName}] waiting for scheduled time ${p.startTime}`);
            } else {
                startPlayer(playerId);
            }
        });
    } catch (err) {
        console.error("[System] Failed to read config file:", err);
    }
}

function createPlayerMeta(id, serverName, host, port, username, startTime, stopTime) {
    return {
        id, serverName, host, port, username,
        startTime: startTime || null,
        stopTime: stopTime || null,
        status: 'Initializing',
        instance: null,
        behaviorTimer: null,
        pathfinderTimer: null,
        intentionalDisconnect: false,
        reconnectAttempts: 0,
        reconnectTimeout: null,
        centerPos: null,
        isMoving: false,
        state: 'idle'
    };
}

function cleanupPlayer(playerMeta) {
    clearInterval(playerMeta.behaviorTimer);
    clearTimeout(playerMeta.pathfinderTimer);
    playerMeta.behaviorTimer = null;
    playerMeta.pathfinderTimer = null;
    playerMeta.isMoving = false;
    playerMeta.state = 'idle';
    playerMeta.instance = null;
}

function isValidStandPosition(player, pos) {
    try {
        const blockFeet = player.blockAt(pos);
        const blockBody = player.blockAt({ x: pos.x, y: pos.y + 1, z: pos.z });
        const blockHead = player.blockAt({ x: pos.x, y: pos.y + 2, z: pos.z });
        if (!blockFeet || !blockBody || !blockHead) return false;
        return blockFeet.type !== 0 && blockBody.type === 0 && blockHead.type === 0;
    } catch {
        return false;
    }
}

// 修复：原函数签名有 player 参数但内部用了全局 bot，现在统一用参数 player
function getRandomValidPos(player, centerPos, radius) {
    for (let attempt = 0; attempt < 10; attempt++) {
        const x = Math.floor(centerPos.x + randomFloat(-radius, radius));
        const z = Math.floor(centerPos.z + randomFloat(-radius, radius));
        const y = Math.floor(centerPos.y);
        const candidate = { x, y, z };
        if (isValidStandPosition(player, candidate)) return candidate;
    }
    return null;
}

function scheduleBehavior(playerMeta) {
    const player = playerMeta.instance;
    if (!player || !player.entity) return;

    const delay = randomInt(5000, 15000);

    playerMeta.behaviorTimer = setTimeout(() => {
        if (!playerMeta.instance || !playerMeta.instance.entity) return;

        const roll = Math.random();

        if (playerMeta.isMoving) {
            scheduleBehavior(playerMeta);
            return;
        }

        if (roll < 0.30) {
            const radius = Math.random() > 0.15 ? WANDER_RADIUS : WANDER_RADIUS_LONG;
            const targetPos = playerMeta.centerPos
                ? getRandomValidPos(player, playerMeta.centerPos, radius)
                : null;

            if (targetPos) {
                playerMeta.isMoving = true;
                playerMeta.state = 'wandering';
                player.pathfinder.setGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));

                playerMeta.pathfinderTimer = setTimeout(() => {
                    if (playerMeta.isMoving) {
                        try { player.pathfinder.setGoal(null); } catch { }
                        playerMeta.isMoving = false;
                        playerMeta.state = 'idle';
                    }
                }, PATHFINDER_TIMEOUT_MS);
            }
        } else if (roll < 0.45) {
            player.chat(maybeAddSuffix(randomFrom(CHAT_DB.idle)));
        } else if (roll < 0.63) {
            player.setControlState('sneak', true);
            setTimeout(() => {
                if (playerMeta.instance) player.setControlState('sneak', false);
            }, randomInt(800, 3000));
        } else if (roll < 0.68) {
            player.setControlState('jump', true);
            setTimeout(() => {
                if (playerMeta.instance) player.setControlState('jump', false);
            }, 300);
        } else {
            const target = player.nearestEntity(e => e.type === 'player' && e.username !== playerMeta.username);
            if (target && target.position) {
                try { player.lookAt(target.position.offset(0, 1.6, 0)); } catch { }
            }
        }

        scheduleBehavior(playerMeta);
    }, delay);
}

function startPlayer(id) {
    const playerMeta = activePlayers.get(id);
    if (!playerMeta || playerMeta.instance) return;

    console.log(`[System] Starting player [${playerMeta.username}] -> ${playerMeta.host}:${playerMeta.port}`);
    playerMeta.status = 'Connecting...';
    playerMeta.intentionalDisconnect = false;

    let player;
    try {
        player = mineflayer.createBot({
            host: playerMeta.host,
            port: playerMeta.port,
            username: playerMeta.username,
            version: false,
            auth: 'offline',
            hideErrors: true
        });
    } catch (err) {
        console.error(`[Error] Failed to create player [${playerMeta.username}]:`, err.message);
        playerMeta.status = 'Error';
        return;
    }

    player.loadPlugin(pathfinder);
    playerMeta.instance = player;

    player.once('spawn', () => {
        playerMeta.status = 'Online';
        playerMeta.reconnectAttempts = 0;
        playerMeta.centerPos = player.entity.position.clone();
        console.log(`[Success] Player [${playerMeta.username}] joined!`);

        try {
            const mcData = require('minecraft-data')(player.version);
            const movements = new Movements(player, mcData);
            movements.canDig = false;
            movements.allow1by1towers = false;
            movements.allowParkour = false;
            movements.allowSprinting = false;
            player.pathfinder.setMovements(movements);
        } catch (e) {
            console.log(`[Warning] Pathfinder init issue for [${playerMeta.username}]: ${e.message}`);
        }

        if (Math.random() > 0.30) {
            const greetDelay = randomInt(3000, 9000);
            setTimeout(() => {
                if (playerMeta.instance) {
                    player.chat(maybeAddSuffix(randomFrom(CHAT_DB.greetings)));
                }
            }, greetDelay);
        }

        player.on('chat', (username) => {
            if (username === playerMeta.username) return;
            if (Math.random() > 0.80) {
                const replyDelay = randomInt(2000, 6000);
                setTimeout(() => {
                    if (playerMeta.instance) {
                        player.chat(maybeAddSuffix(randomFrom(CHAT_DB.interaction)));
                    }
                }, replyDelay);
            }
        });

        scheduleBehavior(playerMeta);
    });

    player.on('goal_reached', () => {
        clearTimeout(playerMeta.pathfinderTimer);
        playerMeta.isMoving = false;
        playerMeta.state = 'idle';
    });

    player.on('path_update', (result) => {
        if (result.status === 'noPath' || result.status === 'timeout') {
            playerMeta.isMoving = false;
            playerMeta.state = 'idle';
        }
    });

    function handleDisconnect(reason) {
        cleanupPlayer(playerMeta);

        if (playerMeta.intentionalDisconnect || !activePlayers.has(id)) {
            playerMeta.status = playerMeta.startTime ? 'Waiting...' : 'Offline';
            return;
        }

        const delayIndex = Math.min(playerMeta.reconnectAttempts, RECONNECT_DELAYS.length - 1);
        const delay = RECONNECT_DELAYS[delayIndex];
        playerMeta.reconnectAttempts++;
        playerMeta.status = `Reconnecting (${playerMeta.reconnectAttempts})...`;
        console.log(`[Reconnect] Player [${playerMeta.username}] attempt ${playerMeta.reconnectAttempts} in ${delay / 1000}s (reason: ${reason})`);

        playerMeta.reconnectTimeout = setTimeout(() => {
            if (activePlayers.has(id) && !playerMeta.intentionalDisconnect) {
                startPlayer(id);
            }
        }, delay);
    }

    player.once('end', (reason) => {
        handleDisconnect(reason || 'end');
    });

    player.on('error', (err) => {
        console.log(`[Error] Player [${playerMeta.username}]: ${err.message}`);
        handleDisconnect('error');
    });
}

setInterval(() => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    for (const [id, meta] of activePlayers.entries()) {
        if (meta.startTime === currentTime && !meta.instance && !meta.intentionalDisconnect) {
            console.log(`[Schedule] Starting player [${meta.username}] at scheduled time ${currentTime}.`);
            startPlayer(id);
        }
        if (meta.stopTime === currentTime && meta.instance) {
            console.log(`[Schedule] Stopping player [${meta.username}] at scheduled time ${currentTime}.`);
            meta.intentionalDisconnect = true;
            clearTimeout(meta.reconnectTimeout);
            try { meta.instance.quit(); } catch { }
            cleanupPlayer(meta);
            meta.status = 'Waiting...';
        }
    }
}, 60000);

app.post('/api/start', (req, res) => {
    const { serverName, ipPort, playerName, startTime, stopTime } = req.body;

    if (!ipPort || !playerName) {
        return res.status(400).json({ success: false, message: "IP:Port and Player Name are required." });
    }

    const { host, port } = parseIpPort(ipPort);
    const playerId = 'player_' + Date.now();
    const playerMeta = createPlayerMeta(playerId, serverName || 'Unknown Server', host, port, playerName, startTime || null, stopTime || null);
    activePlayers.set(playerId, playerMeta);
    saveConfig();

    if (startTime) {
        playerMeta.status = 'Waiting...';
        return res.json({ success: true, message: `Scheduled for ${startTime}` });
    }

    startPlayer(playerId);
    res.json({ success: true, message: `Deploying...` });
});

app.post('/api/start_id', (req, res) => {
    const { id } = req.body;
    if (!activePlayers.has(id)) return res.status(404).json({ success: false, message: "Player not found." });
    const meta = activePlayers.get(id);
    if (meta.instance) return res.json({ success: false, message: "Already running." });
    meta.intentionalDisconnect = false;
    meta.reconnectAttempts = 0;
    clearTimeout(meta.reconnectTimeout);
    startPlayer(id);
    res.json({ success: true });
});

app.post('/api/stop_id', (req, res) => {
    const { id } = req.body;
    const playerMeta = activePlayers.get(id);
    if (!playerMeta) return res.status(404).json({ success: false, message: "Player not found." });
    playerMeta.intentionalDisconnect = true;
    clearTimeout(playerMeta.reconnectTimeout);
    if (playerMeta.instance) {
        try { playerMeta.instance.quit(); } catch { }
    }
    cleanupPlayer(playerMeta);
    playerMeta.status = 'Offline';
    res.json({ success: true });
});

app.post('/api/remove', (req, res) => {
    const { id } = req.body;
    const playerMeta = activePlayers.get(id);
    if (!playerMeta) return res.status(404).json({ success: false });
    playerMeta.intentionalDisconnect = true;
    clearTimeout(playerMeta.reconnectTimeout);
    if (playerMeta.instance) {
        try { playerMeta.instance.quit(); } catch { }
    }
    cleanupPlayer(playerMeta);
    activePlayers.delete(id);
    saveConfig();
    res.json({ success: true });
});

app.get('/api/bots', (req, res) => {
    const playersList = Array.from(activePlayers.values()).map(b => {
        let displayStatus = b.status;
        if (b.status === 'Waiting...' && b.startTime) displayStatus = `Waiting (${b.startTime})`;
        if (b.status === 'Online' && b.stopTime) displayStatus = `Online (Stops at ${b.stopTime})`;
        return {
            id: b.id,
            username: b.username,
            serverName: b.serverName,
            status: displayStatus,
            ipPort: `${b.host}:${b.port}`,
            state: b.state
        };
    });
    res.json(playersList);
});

app.get('/api/export', (req, res) => {
    if (fs.existsSync(CONFIG_FILE)) {
        res.download(CONFIG_FILE, 'losy_players_config.json');
    } else {
        res.status(404).send("No configuration found yet.");
    }
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Losy MC Player</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body {
                background: linear-gradient(135deg, #fce7f3 0%, #fecdd3 100%);
                color: #831843;
                font-family: system-ui, -apple-system, sans-serif;
                min-height: 100vh;
            }
            .input-field {
                width: 100%;
                background: rgba(255, 255, 255, 0.7);
                border: 1px solid #fbcfe8;
                padding: 8px 12px;
                border-radius: 8px;
                color: #831843;
                outline: none;
                transition: all 0.3s ease;
            }
            .input-field::placeholder { color: #f472b6; }
            .input-field:focus {
                border-color: #f472b6;
                background: rgba(255, 255, 255, 0.95);
                box-shadow: 0 0 0 2px rgba(244, 114, 182, 0.2);
            }
            ::-webkit-scrollbar { width: 6px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: #fbcfe8; border-radius: 4px; }
        </style>
    </head>
    <body class="flex flex-col items-center justify-start p-4 md:p-8 pt-10">

        <div class="bg-white/60 p-5 md:p-6 rounded-2xl border border-white/40 shadow-[0_8px_30px_rgb(200,100,150,0.1)] w-full max-w-6xl backdrop-blur-md mb-6">
            <h1 class="text-xl md:text-2xl font-bold mb-5 text-pink-500 tracking-wide flex items-center gap-2">
                🌸 Losy MC Player
            </h1>

            <div class="flex flex-col lg:flex-row gap-4 items-end w-full">
                <div class="flex-1 w-full">
                    <label class="text-[10px] font-bold text-pink-400 uppercase tracking-wider block mb-1">Server Name</label>
                    <input type="text" id="serverName" placeholder="My Survival" class="input-field text-sm">
                </div>
                <div class="flex-[1.2] w-full">
                    <label class="text-[10px] font-bold text-pink-400 uppercase tracking-wider block mb-1">IP Address & Port</label>
                    <input type="text" id="ipPort" placeholder="mc.example.com:25565" class="input-field text-sm">
                </div>
                <div class="flex-1 w-full">
                    <label class="text-[10px] font-bold text-pink-400 uppercase tracking-wider block mb-1">Player Name</label>
                    <input type="text" id="playerName" placeholder="LosyBot_01" class="input-field text-sm">
                </div>
                <div class="flex gap-4 w-full lg:w-auto">
                    <div class="w-24 flex-shrink-0">
                        <label class="text-[10px] font-bold text-pink-400 uppercase tracking-wider block mb-1">Start (Opt)</label>
                        <input type="time" id="startTime" class="input-field text-sm px-2">
                    </div>
                    <div class="w-24 flex-shrink-0">
                        <label class="text-[10px] font-bold text-pink-400 uppercase tracking-wider block mb-1">Stop (Opt)</label>
                        <input type="time" id="stopTime" class="input-field text-sm px-2">
                    </div>
                </div>
                <div class="w-full lg:w-32 flex-shrink-0">
                    <button onclick="startPlayer()" class="w-full bg-pink-400 hover:bg-pink-500 text-white font-bold py-2 px-4 rounded-lg transition-all shadow-md hover:shadow-lg transform hover:-translate-y-0.5 text-sm h-[38px] flex items-center justify-center">
                        Deploy Player
                    </button>
                </div>
            </div>

            <div id="statusMsg" class="mt-4 text-sm font-medium hidden"></div>
        </div>

        <div class="bg-white/60 p-5 md:p-6 rounded-2xl border border-white/40 shadow-[0_8px_30px_rgb(200,100,150,0.1)] w-full max-w-6xl backdrop-blur-md">
            <div class="flex justify-between items-center mb-4 pb-2 border-b border-pink-100">
                <h2 class="text-sm font-bold text-pink-500 uppercase tracking-wider">Active Players Workspace</h2>
                <div class="flex items-center gap-2">
                    <button onclick="exportData()" class="text-[11px] font-bold bg-pink-400 hover:bg-pink-500 text-white px-2.5 py-1 rounded-full shadow-sm transition-all transform hover:-translate-y-0.5 flex items-center gap-1">
                        🌸 Export Data
                    </button>
                    <span id="playerCount" class="text-xs font-bold bg-pink-200 text-pink-600 px-3 py-1 rounded-full shadow-sm">Total: 0</span>
                </div>
            </div>

            <div id="playerList" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[50vh] overflow-y-auto pr-2">
                <div class="col-span-full text-center text-sm text-pink-300 py-8">No active players. Add one from the panel above!</div>
            </div>
        </div>

        <script>
            function stateEmoji(state) {
                const map = { idle: '💤', wandering: '🚶', responding: '💬' };
                return map[state] || '💤';
            }

            async function startPlayer() {
                const serverName = document.getElementById('serverName').value;
                const ipPort = document.getElementById('ipPort').value;
                const playerName = document.getElementById('playerName').value;
                const startTime = document.getElementById('startTime').value;
                const stopTime = document.getElementById('stopTime').value;
                const statusEl = document.getElementById('statusMsg');

                if (!ipPort || !playerName) {
                    statusEl.textContent = '❌ IP:Port and Player Name are required.';
                    statusEl.className = 'mt-4 text-sm font-medium text-red-400 block';
                    return;
                }

                statusEl.innerHTML = '<span class="animate-pulse">🌸 Processing request...</span>';
                statusEl.className = 'mt-4 text-sm font-medium text-pink-500 block';

                try {
                    const res = await fetch('/api/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ serverName, ipPort, playerName, startTime, stopTime })
                    });
                    const data = await res.json();
                    if (data.success) {
                        statusEl.textContent = '✅ ' + data.message;
                        statusEl.className = 'mt-4 text-sm font-medium text-emerald-500 block';
                        fetchPlayers();
                        document.getElementById('playerName').value = '';
                        setTimeout(() => { statusEl.classList.add('hidden'); }, 3000);
                    } else {
                        statusEl.textContent = '❌ ' + data.message;
                        statusEl.className = 'mt-4 text-sm font-medium text-red-400 block';
                    }
                } catch (err) {
                    statusEl.textContent = '❌ Request failed';
                    statusEl.className = 'mt-4 text-sm font-medium text-red-400 block';
                }
            }

            async function restartPlayer(id) {
                await fetch('/api/start_id', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                fetchPlayers();
            }

            async function stopPlayer(id) {
                await fetch('/api/stop_id', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                fetchPlayers();
            }

            async function removePlayer(id) {
                await fetch('/api/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                fetchPlayers();
            }

            function exportData() { window.location.href = '/api/export'; }

            async function fetchPlayers() {
                try {
                    const res = await fetch('/api/bots');
                    const bots = await res.json();
                    const listEl = document.getElementById('playerList');
                    document.getElementById('playerCount').textContent = 'Total: ' + bots.length;

                    if (bots.length === 0) {
                        listEl.innerHTML = '<div class="col-span-full text-center text-sm text-pink-300 py-8">No active players. Add one from the panel above!</div>';
                        return;
                    }

                    listEl.innerHTML = bots.map(b => {
                        const isOnline = b.status.includes('Online');
                        const isWaiting = b.status.includes('Waiting') || b.status.includes('Reconnecting');
                        const dotColor = isOnline ? 'bg-green-400' : (isWaiting ? 'bg-yellow-400' : 'bg-red-400');
                        return \`
                        <div class="flex flex-col justify-between bg-white/80 p-4 rounded-xl border border-pink-100 shadow-sm hover:shadow-md transition-all relative group">
                            <div class="flex flex-col mb-3">
                                <span class="text-sm font-bold text-pink-600 truncate flex items-center gap-2">
                                    <div class="w-2 h-2 rounded-full \${dotColor} animate-pulse flex-shrink-0"></div>
                                    \${b.serverName}
                                </span>
                                <span class="text-[11px] text-pink-400 mt-1.5 truncate">🤖 \${b.username}</span>
                                <span class="text-[11px] text-pink-400 mt-0.5 truncate">🌐 \${b.ipPort}</span>
                                <span class="text-[11px] font-medium text-pink-500/80 mt-0.5 truncate">⏱ \${b.status}</span>
                                <span class="text-[11px] text-pink-300 mt-0.5">\${stateEmoji(b.state)} \${b.state || 'idle'}</span>
                            </div>
                            <div class="flex gap-1.5 mt-1">
                                <button onclick="restartPlayer('\${b.id}')" class="flex-1 bg-green-50 hover:bg-green-500 text-green-500 hover:text-white text-[10px] font-bold py-1.5 rounded-lg transition-colors uppercase tracking-wider">Restart</button>
                                <button onclick="stopPlayer('\${b.id}')" class="flex-1 bg-orange-50 hover:bg-orange-500 text-orange-500 hover:text-white text-[10px] font-bold py-1.5 rounded-lg transition-colors uppercase tracking-wider">Stop</button>
                                <button onclick="removePlayer('\${b.id}')" class="flex-1 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white text-[10px] font-bold py-1.5 rounded-lg transition-colors uppercase tracking-wider">Remove</button>
                            </div>
                        </div>
                        \`;
                    }).join('');
                } catch (err) { }
            }

            setInterval(fetchPlayers, 3000);
            fetchPlayers();
        </script>
    </body>
    </html>
    `);
});

loadConfig();

const PORT = process.env.PORT || 2645;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Losy MC Player] Started successfully!`);
    console.log(`[Losy MC Player] Please visit: http://localhost:${PORT}`);
});