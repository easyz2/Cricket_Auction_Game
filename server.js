// ==========================
//  CRICKET AUCTION SERVER (PERSISTENCE & RECONNECT)
// ==========================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// --- DATA PERSISTENCE ---
const DATA_FILE = "rooms_data.json";
let rooms = {};

// Load data on startup
function loadGameData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, "utf-8");
            rooms = JSON.parse(data);
            console.log("Game state loaded from file.");
        }
    } catch (e) {
        console.error("Failed to load game data", e);
        rooms = {};
    }
}
loadGameData();

// Save data on change
function saveGameData() {
    try {
        // We don't save circular structures like timers, so we handle that logic delicately
        // For simplicity in this JSON approach, we strip timers before saving
        // In a real DB (Redis), we would store state strings.
        const dataToSave = JSON.parse(JSON.stringify(rooms)); // Deep copy
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
        console.error("Failed to save game data", e);
    }
}

// Maps active socket IDs to User IDs to handle disconnects without losing player data
const socketToUserMap = {}; 

// --- RULES ---
const MAX_SQUAD_SIZE = 25;       
const MIN_SQUAD_TO_PLAY = 4;    
const PLAYING_11_SIZE = 11;      
const MAX_OVERSEAS_SQUAD = 8;
const MAX_OVERSEAS_P11 = 4;

// --- UTILS ---
function calculateWeightedRating(role, bat, bowl, field) {
    let rating = 0;
    const b = parseInt(bat) || 0;
    const bo = parseInt(bowl) || 0;
    const f = parseInt(field) || 0;

    if (role === "Batsman" || role === "WK") rating = (b * 0.75) + (f * 0.20) + (bo * 0.05);
    else if (role === "Bowler") rating = (bo * 0.75) + (f * 0.20) + (b * 0.05);
    else if (role === "All-Rounder") rating = (b * 0.40) + (bo * 0.40) + (f * 0.20);
    else if (role === "Wicketkeeper") rating = (b * 0.50) + (f * 0.50);
    else rating = (b + bo + f) / 3; 
    return Math.round(rating);
}

function loadPlayerDatabase() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, "players.json"), "utf-8");
    const players = JSON.parse(rawData);
    return players.map(p => {
        const weightedRating = calculateWeightedRating(p.role, p.bat, p.bowl, p.field);
        return {
            ...p,
            country: p.country || "India",   
            status: p.status || "Uncapped",  
            rating: weightedRating,          
            basePrice: p.basePrice || 0.2,
            img: p.img || "https://cdn-icons-png.flaticon.com/512/166/166344.png"
        };
    });
  } catch (error) {
    console.error("CRITICAL: players.json not found!", error.message);
    return []; 
  }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- GAME STATE LOGIC ---

function checkEliminations(room) {
    if(!room || !room.teams) return;
    Object.values(room.teams).forEach(team => {
        if (team.purse <= 0 && team.squad.length < MIN_SQUAD_TO_PLAY) {
            team.isEliminated = true;
        }
    });
    saveGameData();
}

function endAuctionPhase(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    room.auction.phase = "SELECTION";
    io.to(roomId).emit("start-selection-phase");
    saveGameData();
}

function checkAuctionCompletion(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const teams = Object.values(room.teams);
    
    // Active bidders: Not eliminated, Not finished, Has space, AND is connected (optional, but we keep game running)
    const activeBidders = teams.filter(t => !t.isEliminated && !t.isFinishedBidding && t.squad.length < MAX_SQUAD_SIZE);
    
    if (activeBidders.length === 0) {
        if(room.auction.timer) clearInterval(room.auction.timer);
        endAuctionPhase(roomId);
    }
}

function calculateWinner(roomId) {
    const room = rooms[roomId];
    room.auction.phase = "RESULT";
    const teams = Object.values(room.teams).filter(t => !t.isEliminated);
    teams.sort((a, b) => b.totalScore - a.totalScore);
    io.to(roomId).emit("game-over-results", { winner: teams[0], rankings: teams });
    saveGameData();
}

function emitResults(roomId) {
    const room = rooms[roomId];
    if(room && room.auction.phase === "RESULT") {
      const teams = Object.values(room.teams).filter(t => !t.isEliminated);
      teams.sort((a, b) => b.totalScore - a.totalScore);
      io.to(roomId).emit("game-over-results", { winner: teams[0], rankings: teams });
    }
}

// --- TIMERS ---
// We need to manage timers carefully. If server restarts, timers die.
// On start, we check if any rooms were in AUCTION phase and restart their timers.
Object.keys(rooms).forEach(roomId => {
    if(rooms[roomId].auction.phase === 'AUCTION' && rooms[roomId].auction.biddingOpen) {
        startAuctionTimer(roomId);
    }
});

function startAuctionTimer(roomId) {
    const room = rooms[roomId];
    if (!room || !room.auction) return;
    const auction = room.auction;
    
    // Reset or continue time? For simplicity on restart, we reset to 10s or keep stored val
    // If restarting server, auction.timeLeft might be old.
    auction.timeLeft = 10; 
    
    if (auction.timer) clearInterval(auction.timer);
    auction.timer = setInterval(() => {
      auction.timeLeft--;
      io.to(roomId).emit("timer-update", auction.timeLeft);
      if (auction.timeLeft <= 0) {
        clearInterval(auction.timer);
        if (auction.currentBidderId) finishBidding(roomId);
        else finishPlayerUnsold(roomId);
      }
    }, 1000);
}

function startNextPlayer(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    const auction = room.auction;
    if (auction.currentPlayerIndex >= auction.playerPool.length) {
      endAuctionPhase(roomId);
      return;
    }
    const player = auction.playerPool[auction.currentPlayerIndex];
    auction.currentBid = player.basePrice;
    auction.currentBidderId = null;
    auction.skippedBy = []; // Reset skips
    auction.biddingOpen = true;
    
    saveGameData();
    io.to(roomId).emit("new-player", { player, currentBid: auction.currentBid });
    startAuctionTimer(roomId);
}

function finishBidding(roomId) {
    const room = rooms[roomId];
    if (!room) return; 

    const auction = room.auction;
    auction.biddingOpen = false;
    const player = auction.playerPool[auction.currentPlayerIndex];
    
    // Determine winner based on userId map
    const winnerUserId = auction.currentBidderId; // Note: In this new version, bidderId is userId
    const team = room.teams[winnerUserId];
    
    if(team) {
        const finalPrice = parseFloat(auction.currentBid);
        team.purse = parseFloat((team.purse - finalPrice).toFixed(2));
        const soldPlayer = { ...player, soldPrice: finalPrice };
        team.squad.push(soldPlayer);
        
        checkEliminations(room);
        io.to(roomId).emit("player-sold", { player, price: auction.currentBid, teamName: team.name, eliminated: team.isEliminated });
    }

    checkAuctionCompletion(roomId);
    prepareNext(roomId);
}
  
function finishPlayerUnsold(roomId) {
    const room = rooms[roomId];
    if (!room) return; 

    room.auction.biddingOpen = false;
    const player = room.auction.playerPool[room.auction.currentPlayerIndex];
    io.to(roomId).emit("player-unsold", { player });
    prepareNext(roomId);
}

function prepareNext(roomId) {
    const room = rooms[roomId];
    if(room.auction.phase !== "AUCTION") return;
    room.auction.currentPlayerIndex++;
    checkEliminations(room);
    io.to(roomId).emit("teams-updated", Object.values(room.teams));
    setTimeout(() => { startNextPlayer(roomId); }, 3000);
}

// --- SOCKET CONNECTION ---
io.on("connection", (socket) => {

  // --- REJOIN LOGIC ---
  socket.on("rejoin-game", ({ userId, roomId }) => {
      // Map new socket to existing user
      socketToUserMap[socket.id] = userId;

      if (roomId && rooms[roomId]) {
          const room = rooms[roomId];
          const team = room.teams[userId];

          if (team) {
              socket.join(roomId);
              socket.emit("joined-room", { roomId, team, isHost: (room.hostId === userId) });
              
              // Send Current State
              io.to(roomId).emit("teams-updated", Object.values(room.teams));
              
              if(room.auction.phase === "AUCTION" && room.auction.biddingOpen) {
                  const player = room.auction.playerPool[room.auction.currentPlayerIndex];
                  socket.emit("new-player", { player, currentBid: room.auction.currentBid });
                  // Send current bid status
                  if(room.auction.currentBidderId) {
                      const leader = room.teams[room.auction.currentBidderId];
                      socket.emit("bid-updated", { 
                          currentBid: room.auction.currentBid, 
                          bidderId: room.auction.currentBidderId, 
                          bidderName: leader.name 
                      });
                  }
              } else if(room.auction.phase === "SELECTION") {
                  socket.emit("start-selection-phase");
              } else if(room.auction.phase === "RESULT") {
                  emitResults(roomId);
              }
              return;
          }
      }
      socket.emit("error-message", "Session expired or room closed.");
  });

  socket.on("create-room", ({ teamName, purse, userId }) => {
    // userId passed from client localStorage
    socketToUserMap[socket.id] = userId;
    
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const hostPurse = parseFloat(purse) || 100;

    let initialPool = loadPlayerDatabase();
    if(initialPool.length === 0) {
        initialPool = [{ id: "0", name: "Error: No Players", role: "N/A", bat:0, bowl:0, field:0, rating:0, basePrice:0, country:"India", status:"Uncapped", img:"" }];
    } else {
        initialPool = shuffleArray(initialPool);
    }

    rooms[roomId] = {
      hostId: userId, // Host is tracked by UserID, not SocketID
      config: { startingPurse: hostPurse }, 
      teams: {
        [userId]: { 
            id: userId, name: teamName, purse: hostPurse, squad: [], 
            isEliminated: false, isFinishedBidding: false, submitted11: false, totalScore: 0 
        }
      },
      auction: {
        playerPool: initialPool, 
        currentPlayerIndex: 0,
        currentBid: 0,
        currentBidderId: null,
        biddingOpen: false,
        phase: "LOBBY",
        skippedBy: [] // Array of UserIDs
      }
    };

    saveGameData();
    socket.join(roomId);
    socket.emit("room-created", { roomId, team: rooms[roomId].teams[userId], isHost: true });
    io.to(roomId).emit("teams-updated", Object.values(rooms[roomId].teams));
  });

  socket.on("join-room", ({ roomId, teamName, userId }) => {
    socketToUserMap[socket.id] = userId;
    const room = rooms[roomId];
    if (!room) return socket.emit("error-message", "Room not found");

    if (!room.teams[userId]) {
      room.teams[userId] = { 
          id: userId, name: teamName, 
          purse: room.config.startingPurse, squad: [], 
          isEliminated: false, isFinishedBidding: false, submitted11: false, totalScore: 0 
      };
    }

    saveGameData();
    socket.join(roomId);
    socket.emit("joined-room", { roomId, team: room.teams[userId], isHost: (userId === room.hostId) });
    
    if(room.auction.phase === "SELECTION") socket.emit("start-selection-phase");
    else if (room.auction.phase === "RESULT") emitResults(roomId);
    else if (room.auction.biddingOpen) {
        const player = room.auction.playerPool[room.auction.currentPlayerIndex];
        socket.emit("new-player", { player, currentBid: room.auction.currentBid });
    }

    checkEliminations(room);
    io.to(roomId).emit("teams-updated", Object.values(room.teams));
  });

  socket.on("leave-room", ({ roomId, userId }) => {
    // Explicit Quit - Actually removes data
    if(roomId && rooms[roomId]) {
        const room = rooms[roomId];
        if (room.teams[userId]) delete room.teams[userId];
        
        if (room.hostId === userId) {
            const remainingIds = Object.keys(room.teams);
            if (remainingIds.length > 0) room.hostId = remainingIds[0];
            else delete rooms[roomId];
        }
        
        saveGameData();
        if(rooms[roomId]) {
            io.to(roomId).emit("teams-updated", Object.values(room.teams));
            checkAuctionCompletion(roomId);
        }
        socket.leave(roomId);
    }
  });

  socket.on("disconnect", () => {
      // We do NOT delete teams on disconnect anymore.
      // This allows reconnection.
      // We just clean up the socket map.
      delete socketToUserMap[socket.id];
  });

  socket.on("finish-bidding-for-me", ({ roomId, userId }) => {
      const room = rooms[roomId];
      if(!room) return;
      const team = room.teams[userId];
      if(team && team.squad.length >= MIN_SQUAD_TO_PLAY) {
          team.isFinishedBidding = true;
          saveGameData();
          io.to(roomId).emit("teams-updated", Object.values(room.teams));
          checkAuctionCompletion(roomId);
      }
  });

  socket.on("start-auction", ({ roomId }) => {
    const room = rooms[roomId];
    const userId = socketToUserMap[socket.id];
    if (!room || room.hostId !== userId) return;
    if (room.auction.phase !== "LOBBY") return;

    room.auction.phase = "AUCTION";
    saveGameData();
    io.to(roomId).emit("auction-started-signal");
    startNextPlayer(roomId);
  });

  socket.on("place-bid", ({ roomId, bidAmount, userId }) => {
    const room = rooms[roomId];
    if (!room || !room.auction.biddingOpen) return;
    const auction = room.auction;
    const team = room.teams[userId];
    
    if (!team || team.isEliminated || team.isFinishedBidding) return;
    if (team.squad.length >= MAX_SQUAD_SIZE) return;
    if (bidAmount > team.purse) return;
    if (bidAmount <= auction.currentBid) return;

    // RULE: Max 8 Overseas in Squad
    const player = auction.playerPool[auction.currentPlayerIndex];
    if (player.country === "Overseas") {
        const overseasCount = team.squad.filter(p => p.country === "Overseas").length;
        if (overseasCount >= MAX_OVERSEAS_SQUAD) return; 
    }

    auction.currentBid = parseFloat(bidAmount);
    auction.currentBidderId = userId; // Store UserID
    
    // Reset Skips on new bid
    // auction.skippedBy = []; // Optional: Reset skips if someone bids? Usually yes.
    
    io.to(roomId).emit("bid-updated", { currentBid: auction.currentBid, bidderId: userId, bidderName: team.name });
    startAuctionTimer(roomId);
  });

  socket.on("skip-for-me", ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || !room.auction.biddingOpen) return;
    const auction = room.auction;

    if (!auction.skippedBy.includes(userId)) auction.skippedBy.push(userId);

    const teams = Object.values(room.teams);
    // Logic: Skip count reaches Active Players
    const activeBidders = teams.filter(t => !t.isEliminated && !t.isFinishedBidding && t.squad.length < MAX_SQUAD_SIZE);
    // If bidder exists, required skips = active - 1 (bidder doesn't skip). Else active.
    const requiredSkips = auction.currentBidderId ? (activeBidders.length - 1) : activeBidders.length;

    if (auction.skippedBy.length >= requiredSkips && activeBidders.length > 0) {
        clearInterval(auction.timer);
        if (auction.currentBidderId) finishBidding(roomId);
        else finishPlayerUnsold(roomId);
    }
  });

  socket.on("submit-playing-11", ({ roomId, playerIds, cId, vcId, userId }) => {
      const room = rooms[roomId];
      if(!room) return;
      const team = room.teams[userId];
      
      const requiredSelection = Math.min(PLAYING_11_SIZE, team.squad.length);
      
      if(!team || playerIds.length !== requiredSelection) return;
      
      const selectedPlayers = team.squad.filter(p => playerIds.includes(p.id));
      
      // VALUE LOGIC
      const getEffectiveRating = (p) => {
          const factor = p.soldPrice / p.basePrice;
          let finalRating = p.rating;
          if (factor >= 7) finalRating = p.rating - 5;
          else if (factor < 2) finalRating = p.rating + 5;
          return Math.max(0, finalRating);
      };

      const captain = team.squad.find(p => p.id === cId);
      const viceCaptain = team.squad.find(p => p.id === vcId);
      // Fallback if C/VC not in selection (cheating prevention)
      if(!captain || !viceCaptain) return;

      const cEffRating = getEffectiveRating(captain);
      const vcEffRating = getEffectiveRating(viceCaptain);

      let score = 0;
      score += (cEffRating * 2);      
      score += (vcEffRating * 1.5);   
      
      const leadershipBonus = (cEffRating * 0.10) + (vcEffRating * 0.05);
      
      playerIds.forEach(pid => {
          if (pid !== cId && pid !== vcId) {
              const p = team.squad.find(pl => pl.id === pid);
              if(p) score += (getEffectiveRating(p) + leadershipBonus);
          }
      });

      team.totalScore = Math.round(score * 100) / 100;
      team.submitted11 = true;
      team.playing11 = selectedPlayers;
      
      saveGameData();

      const activeTeams = Object.values(room.teams).filter(t => !t.isEliminated);
      const allSubmitted = activeTeams.every(t => t.submitted11);

      if(allSubmitted) calculateWinner(roomId);
      else io.to(roomId).emit("teams-updated", Object.values(room.teams));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
