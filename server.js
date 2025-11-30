// ==========================
//  CRICKET AUCTION SERVER (FIXED VERSION)
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
let saveScheduled = false;

// Load data on startup
function loadGameData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, "utf-8");
            const loadedRooms = JSON.parse(data);
            
            // Reconstruct rooms with proper Set objects
            Object.keys(loadedRooms).forEach(roomId => {
                const room = loadedRooms[roomId];
                
                // Convert skippedBy array back to Set
                if (room.auction && Array.isArray(room.auction.skippedBy)) {
                    room.auction.skippedBy = new Set(room.auction.skippedBy);
                } else if (room.auction) {
                    room.auction.skippedBy = new Set();
                }
                
                // Initialize missing properties
                if (room.auction) {
                    room.auction.timer = null;
                }
                room.nextPlayerTimeout = null;
                
                rooms[roomId] = room;
            });
            
            console.log("Game state loaded from file.");
            
            // Clean up old rooms (older than 24 hours)
            const now = Date.now();
            Object.keys(rooms).forEach(roomId => {
                if (rooms[roomId].lastActivity && (now - rooms[roomId].lastActivity) > 86400000) {
                    delete rooms[roomId];
                    console.log(`Cleaned up old room: ${roomId}`);
                }
            });
        }
    } catch (e) {
        console.error("Failed to load game data", e);
        rooms = {};
    }
}
loadGameData();

// Debounced save to prevent excessive file I/O
function saveGameData() {
    if (saveScheduled) return;
    saveScheduled = true;
    
    setTimeout(() => {
        try {
            const dataToSave = {};
            Object.keys(rooms).forEach(roomId => {
                const room = rooms[roomId];
                
                // Create a clean copy without circular references
                const cleanRoom = {
                    hostId: room.hostId,
                    config: room.config,
                    teams: room.teams,
                    auction: {
                        playerPool: room.auction.playerPool,
                        currentPlayerIndex: room.auction.currentPlayerIndex,
                        currentBid: room.auction.currentBid,
                        currentBidderId: room.auction.currentBidderId,
                        biddingOpen: room.auction.biddingOpen,
                        phase: room.auction.phase,
                        skippedBy: Array.from(room.auction.skippedBy || []), // Convert Set to Array
                        timeLeft: room.auction.timeLeft
                        // Explicitly exclude timer and other non-serializable objects
                    },
                    lastActivity: room.lastActivity
                    // Explicitly exclude nextPlayerTimeout
                };
                
                dataToSave[roomId] = cleanRoom;
            });
            
            fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
            saveScheduled = false;
        } catch (e) {
            console.error("Failed to save game data", e);
            saveScheduled = false;
        }
    }, 1000); // Debounce by 1 second
}

// Maps active socket IDs to User IDs
const socketToUserMap = {}; 
// Track active sockets per user
const userToSocketMap = {};

// --- RULES ---
const MAX_SQUAD_SIZE = 25;       
const MIN_SQUAD_TO_PLAY = 18;    
const PLAYING_11_SIZE = 11;      
const MAX_OVERSEAS_SQUAD = 8;
const MAX_OVERSEAS_P11 = 4;
const BID_INCREMENT = 0.25;

// --- UTILS ---
function sanitizeInput(str, maxLength = 50) {
    if (!str || typeof str !== 'string') return '';
    return str.trim().slice(0, maxLength).replace(/[<>]/g, '');
}

function calculateWeightedRating(role, bat, bowl, field) {
    let rating = 0;
    const b = parseInt(bat) || 0;
    const bo = parseInt(bowl) || 0;
    const f = parseInt(field) || 0;

    if (role === "Batsman") rating = (b * 0.75) + (f * 0.20) + (bo * 0.05);
    else if (role === "Bowler") rating = (bo * 0.75) + (f * 0.20) + (b * 0.05);
    else if (role === "All-Rounder") rating = (b * 0.40) + (bo * 0.40) + (f * 0.20);
    else if (role === "Wicketkeeper") rating = (b * 0.30) + (f * 0.50) + (bo * 0.20);
    else rating = (b + bo + f) / 3; 
    return Math.round(rating);
}

function loadPlayerDatabase() {
  try {
    const rawData = fs.readFileSync(path.join(__dirname, "players.json"), "utf-8");
    const players = JSON.parse(rawData);
    return players.map((p, idx) => {
        const weightedRating = calculateWeightedRating(p.role, p.bat, p.bowl, p.field);
        return {
            ...p,
            id: p.id || `player_${idx}`, // Ensure unique ID
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
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function updateRoomActivity(roomId) {
    if (rooms[roomId]) {
        rooms[roomId].lastActivity = Date.now();
    }
}

// --- GAME STATE LOGIC ---

function checkEliminations(room) {
    if(!room || !room.teams) return;
    Object.values(room.teams).forEach(team => {
        if (team.purse < BID_INCREMENT && team.squad.length < MIN_SQUAD_TO_PLAY) {
            team.isEliminated = true;
        }
    });
    saveGameData();
}

function endAuctionPhase(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    if (room.auction.timer) {
        clearInterval(room.auction.timer);
        room.auction.timer = null;
    }
    room.auction.phase = "SELECTION";
    room.auction.biddingOpen = false;
    io.to(roomId).emit("start-selection-phase");
    updateRoomActivity(roomId);
    saveGameData();
}

function checkAuctionCompletion(roomId) {
    const room = rooms[roomId];
    if (!room || room.auction.phase !== "AUCTION") return;
    const teams = Object.values(room.teams);
    
    const activeBidders = teams.filter(t => 
        !t.isEliminated && 
        !t.isFinishedBidding && 
        t.squad.length < MAX_SQUAD_SIZE
    );
    
    if (activeBidders.length === 0) {
        if(room.auction.timer) {
            clearInterval(room.auction.timer);
            room.auction.timer = null;
        }
        endAuctionPhase(roomId);
    }
}

function calculateWinner(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    room.auction.phase = "RESULT";
    const teams = Object.values(room.teams).filter(t => !t.isEliminated);
    teams.sort((a, b) => b.totalScore - a.totalScore);
    io.to(roomId).emit("game-over-results", { winner: teams[0], rankings: teams });
    updateRoomActivity(roomId);
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
function startAuctionTimer(roomId) {
    const room = rooms[roomId];
    if (!room || !room.auction) {
        console.error('startAuctionTimer: Invalid room:', roomId);
        return;
    }
    const auction = room.auction;
    
    auction.timeLeft = 10; 
    
    if (auction.timer) {
        clearInterval(auction.timer);
        auction.timer = null;
    }
    
    auction.timer = setInterval(() => {
      auction.timeLeft--;
      io.to(roomId).emit("timer-update", auction.timeLeft);
      
      if (auction.timeLeft <= 0) {
        clearInterval(auction.timer);
        auction.timer = null;
        
        console.log(`Timer expired for room ${roomId}, bidderId: ${auction.currentBidderId}`);
        
        if (auction.currentBidderId) {
            finishBidding(roomId);
        } else {
            finishPlayerUnsold(roomId);
        }
      }
    }, 1000);
}

function startNextPlayer(roomId) {
    const room = rooms[roomId];
    if(!room || room.auction.phase !== "AUCTION") return;
    
    const auction = room.auction;
    
    // Check if auction should end
    if (auction.currentPlayerIndex >= auction.playerPool.length) {
      endAuctionPhase(roomId);
      return;
    }
    
    const player = auction.playerPool[auction.currentPlayerIndex];
    auction.currentBid = player.basePrice;
    auction.currentBidderId = null;
    auction.skippedBy = new Set(); // Use Set to prevent duplicates
    auction.biddingOpen = true;
    
    updateRoomActivity(roomId);
    saveGameData();
    io.to(roomId).emit("new-player", { player, currentBid: auction.currentBid });
    startAuctionTimer(roomId);
}

function finishBidding(roomId) {
    const room = rooms[roomId];
    if (!room) {
        console.error('finishBidding: Room not found:', roomId);
        return;
    }

    const auction = room.auction;
    auction.biddingOpen = false;
    const player = auction.playerPool[auction.currentPlayerIndex];
    
    const winnerUserId = auction.currentBidderId;
    const team = room.teams[winnerUserId];
    
    if(team) {
        const finalPrice = parseFloat(auction.currentBid);
        
        // Additional validation
        if (finalPrice > team.purse) {
            console.error('Insufficient funds for bid:', team.name, finalPrice, 'vs', team.purse);
            // Treat as unsold
            finishPlayerUnsold(roomId);
            return;
        }
        
        if (team.squad.length >= MAX_SQUAD_SIZE) {
            console.error('Squad full for:', team.name);
            finishPlayerUnsold(roomId);
            return;
        }
        
        team.purse = parseFloat((team.purse - finalPrice).toFixed(2));
        const soldPlayer = { ...player, soldPrice: finalPrice };
        team.squad.push(soldPlayer);
        
        console.log(`Player ${player.name} sold to ${team.name} for ${finalPrice}`);
        
        checkEliminations(room);
        io.to(roomId).emit("player-sold", { 
            player, 
            price: auction.currentBid, 
            teamName: team.name, 
            eliminated: team.isEliminated 
        });
    } else {
        console.error('Winner team not found:', winnerUserId);
        io.to(roomId).emit("player-unsold", { player });
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
    if(!room || room.auction.phase !== "AUCTION") {
        console.log('prepareNext: Auction not active for room:', roomId);
        return;
    }
    
    room.auction.currentPlayerIndex++;
    checkEliminations(room);
    io.to(roomId).emit("teams-updated", Object.values(room.teams));
    updateRoomActivity(roomId);
    
    // Use room-specific timeout tracking
    if (room.nextPlayerTimeout) {
        clearTimeout(room.nextPlayerTimeout);
        room.nextPlayerTimeout = null;
    }
    
    room.nextPlayerTimeout = setTimeout(() => {
        if (rooms[roomId] && rooms[roomId].auction.phase === "AUCTION") {
            console.log('Starting next player for room:', roomId);
            startNextPlayer(roomId);
        } else {
            console.log('Room state changed, skipping next player:', roomId);
        }
    }, 3000);
}

// --- SOCKET CONNECTION ---
io.on("connection", (socket) => {

  socket.on("rejoin-game", ({ userId, roomId }) => {
      userId = sanitizeInput(userId, 100);
      roomId = sanitizeInput(roomId, 20).toUpperCase();
      
      socketToUserMap[socket.id] = userId;
      
      // Clean up old socket for this user
      if (userToSocketMap[userId]) {
          delete socketToUserMap[userToSocketMap[userId]];
      }
      userToSocketMap[userId] = socket.id;

      if (roomId && rooms[roomId]) {
          const room = rooms[roomId];
          const team = room.teams[userId];

          if (team) {
              socket.join(roomId);
              socket.emit("joined-room", { 
                  roomId, 
                  team, 
                  isHost: (room.hostId === userId) 
              });
              
              io.to(roomId).emit("teams-updated", Object.values(room.teams));
              
              if(room.auction.phase === "AUCTION" && room.auction.biddingOpen) {
                  const player = room.auction.playerPool[room.auction.currentPlayerIndex];
                  socket.emit("new-player", { player, currentBid: room.auction.currentBid });
                  
                  if(room.auction.currentBidderId) {
                      const leader = room.teams[room.auction.currentBidderId];
                      socket.emit("bid-updated", { 
                          currentBid: room.auction.currentBid, 
                          bidderId: room.auction.currentBidderId, 
                          bidderName: leader ? leader.name : "Unknown"
                      });
                  }
                  socket.emit("timer-update", room.auction.timeLeft || 10);
              } else if(room.auction.phase === "SELECTION") {
                  socket.emit("start-selection-phase");
              } else if(room.auction.phase === "RESULT") {
                  emitResults(roomId);
              }
              
              updateRoomActivity(roomId);
              return;
          }
      }
      socket.emit("error-message", "Session expired or room closed.");
  });

  socket.on("create-room", ({ teamName, purse, userId }) => {
    userId = sanitizeInput(userId, 100);
    teamName = sanitizeInput(teamName, 30) || "Team";
    
    socketToUserMap[socket.id] = userId;
    userToSocketMap[userId] = socket.id;
    
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const hostPurse = Math.max(50, Math.min(500, parseFloat(purse) || 100));

    let initialPool = loadPlayerDatabase();
    if(initialPool.length === 0) {
        initialPool = [{
            id: "error_0", 
            name: "Error: No Players", 
            role: "N/A", 
            bat: 0, 
            bowl: 0, 
            field: 0, 
            rating: 0, 
            basePrice: 0, 
            country: "India", 
            status: "Uncapped", 
            img: ""
        }];
    } else {
        initialPool = shuffleArray(initialPool);
    }

    rooms[roomId] = {
      hostId: userId,
      config: { startingPurse: hostPurse }, 
      teams: {
        [userId]: { 
            id: userId, 
            name: teamName, 
            purse: hostPurse, 
            squad: [], 
            isEliminated: false, 
            isFinishedBidding: false, 
            submitted11: false, 
            totalScore: 0 
        }
      },
      auction: {
        playerPool: initialPool, 
        currentPlayerIndex: 0,
        currentBid: 0,
        currentBidderId: null,
        biddingOpen: false,
        phase: "LOBBY",
        skippedBy: new Set(),
        timeLeft: 10,
        timer: null
      },
      lastActivity: Date.now(),
      nextPlayerTimeout: null
    };

    saveGameData();
    socket.join(roomId);
    socket.emit("room-created", { 
        roomId, 
        team: rooms[roomId].teams[userId], 
        isHost: true 
    });
    io.to(roomId).emit("teams-updated", Object.values(rooms[roomId].teams));
  });

  socket.on("join-room", ({ roomId, teamName, userId }) => {
    userId = sanitizeInput(userId, 100);
    roomId = sanitizeInput(roomId, 20).toUpperCase();
    teamName = sanitizeInput(teamName, 30) || "Team";
    
    socketToUserMap[socket.id] = userId;
    
    if (userToSocketMap[userId]) {
        delete socketToUserMap[userToSocketMap[userId]];
    }
    userToSocketMap[userId] = socket.id;
    
    const room = rooms[roomId];
    if (!room) return socket.emit("error-message", "Room not found");

    if (!room.teams[userId]) {
      room.teams[userId] = { 
          id: userId, 
          name: teamName, 
          purse: room.config.startingPurse, 
          squad: [], 
          isEliminated: false, 
          isFinishedBidding: false, 
          submitted11: false, 
          totalScore: 0 
      };
    }

    updateRoomActivity(roomId);
    saveGameData();
    socket.join(roomId);
    socket.emit("joined-room", { 
        roomId, 
        team: room.teams[userId], 
        isHost: (userId === room.hostId) 
    });
    
    if(room.auction.phase === "AUCTION" && room.auction.biddingOpen) {
        const player = room.auction.playerPool[room.auction.currentPlayerIndex];
        socket.emit("new-player", { player, currentBid: room.auction.currentBid });
        socket.emit("timer-update", room.auction.timeLeft || 10);
    } else if(room.auction.phase === "SELECTION") {
        socket.emit("start-selection-phase");
    } else if (room.auction.phase === "RESULT") {
        emitResults(roomId);
    }

    checkEliminations(room);
    io.to(roomId).emit("teams-updated", Object.values(room.teams));
  });

  socket.on("leave-room", ({ roomId, userId }) => {
    roomId = sanitizeInput(roomId, 20).toUpperCase();
    userId = sanitizeInput(userId, 100);
    
    if(roomId && rooms[roomId]) {
        const room = rooms[roomId];
        if (room.teams[userId]) {
            delete room.teams[userId];
        }
        
        if (room.hostId === userId) {
            const remainingIds = Object.keys(room.teams);
            if (remainingIds.length > 0) {
                room.hostId = remainingIds[0];
            } else {
                // Clean up timers before deleting room
                if (room.auction.timer) clearInterval(room.auction.timer);
                if (room.nextPlayerTimeout) clearTimeout(room.nextPlayerTimeout);
                delete rooms[roomId];
            }
        }
        
        saveGameData();
        if(rooms[roomId]) {
            io.to(roomId).emit("teams-updated", Object.values(room.teams));
            checkAuctionCompletion(roomId);
        }
        socket.leave(roomId);
    }
    
    delete socketToUserMap[socket.id];
    delete userToSocketMap[userId];
  });

  socket.on("disconnect", () => {
      const userId = socketToUserMap[socket.id];
      delete socketToUserMap[socket.id];
      if (userId && userToSocketMap[userId] === socket.id) {
          delete userToSocketMap[userId];
      }
  });

  socket.on("finish-bidding-for-me", ({ roomId, userId }) => {
      roomId = sanitizeInput(roomId, 20).toUpperCase();
      userId = sanitizeInput(userId, 100);
      
      const room = rooms[roomId];
      if(!room) return;
      const team = room.teams[userId];
      
      if(team && team.squad.length >= MIN_SQUAD_TO_PLAY && !team.isEliminated) {
          team.isFinishedBidding = true;
          updateRoomActivity(roomId);
          saveGameData();
          io.to(roomId).emit("teams-updated", Object.values(room.teams));
          checkAuctionCompletion(roomId);
      }
  });

  socket.on("start-auction", ({ roomId }) => {
    const userId = socketToUserMap[socket.id];
    roomId = sanitizeInput(roomId, 20).toUpperCase();
    
    const room = rooms[roomId];
    if (!room || room.hostId !== userId) return;
    if (room.auction.phase !== "LOBBY") return;

    room.auction.phase = "AUCTION";
    updateRoomActivity(roomId);
    saveGameData();
    io.to(roomId).emit("auction-started-signal");
    startNextPlayer(roomId);
  });

  socket.on("place-bid", ({ roomId, bidAmount, userId }) => {
    roomId = sanitizeInput(roomId, 20).toUpperCase();
    userId = sanitizeInput(userId, 100);
    bidAmount = parseFloat(bidAmount);
    
    const room = rooms[roomId];
    if (!room || !room.auction.biddingOpen) return;
    
    const auction = room.auction;
    const team = room.teams[userId];
    
    if (!team || team.isEliminated || team.isFinishedBidding) return;
    if (team.squad.length >= MAX_SQUAD_SIZE) return;
    
    // Validate bid amount
    const minBid = auction.currentBid + BID_INCREMENT;
    if (bidAmount < minBid || bidAmount > team.purse) return;
    if (isNaN(bidAmount)) return;

    const player = auction.playerPool[auction.currentPlayerIndex];
    
    // Overseas validation
    if (player.country === "Overseas") {
        const overseasCount = team.squad.filter(p => p.country === "Overseas").length;
        if (overseasCount >= MAX_OVERSEAS_SQUAD) return; 
    }

    auction.currentBid = parseFloat(bidAmount.toFixed(2));
    auction.currentBidderId = userId;
    auction.skippedBy = new Set(); // Reset skips on new bid
    
    updateRoomActivity(roomId);
    io.to(roomId).emit("bid-updated", { 
        currentBid: auction.currentBid, 
        bidderId: userId, 
        bidderName: team.name 
    });
    startAuctionTimer(roomId);
  });

  socket.on("skip-for-me", ({ roomId, userId }) => {
    roomId = sanitizeInput(roomId, 20).toUpperCase();
    userId = sanitizeInput(userId, 100);
    
    const room = rooms[roomId];
    if (!room || !room.auction.biddingOpen) return;
    
    const auction = room.auction;
    const team = room.teams[userId];
    
    if (!team || team.isEliminated || team.isFinishedBidding) return;

    // Use Set to prevent duplicates
    if (!auction.skippedBy.has(userId)) {
        auction.skippedBy.add(userId);
    }

    const teams = Object.values(room.teams);
    const activeBidders = teams.filter(t => 
        !t.isEliminated && 
        !t.isFinishedBidding && 
        t.squad.length < MAX_SQUAD_SIZE
    );
    
    const requiredSkips = auction.currentBidderId 
        ? (activeBidders.length - 1) 
        : activeBidders.length;

    if (auction.skippedBy.size >= requiredSkips && activeBidders.length > 0) {
        if (auction.timer) {
            clearInterval(auction.timer);
            auction.timer = null;
        }
        
        if (auction.currentBidderId) {
            finishBidding(roomId);
        } else {
            finishPlayerUnsold(roomId);
        }
    }
  });

  socket.on("submit-playing-11", ({ roomId, playerIds, cId, vcId, userId }) => {
      roomId = sanitizeInput(roomId, 20).toUpperCase();
      userId = sanitizeInput(userId, 100);
      
      const room = rooms[roomId];
      if(!room) return;
      
      const team = room.teams[userId];
      if (!team) return;
      
      const requiredSelection = Math.min(PLAYING_11_SIZE, team.squad.length);
      
      if(!Array.isArray(playerIds) || playerIds.length !== requiredSelection) return;
      
      const selectedPlayers = team.squad.filter(p => playerIds.includes(p.id));
      if (selectedPlayers.length !== requiredSelection) return;
      
      // Validate overseas limit in Playing 11
      const overseasInP11 = selectedPlayers.filter(p => p.country === "Overseas").length;
      if (overseasInP11 > MAX_OVERSEAS_P11) return;
      
      const captain = selectedPlayers.find(p => p.id === cId);
      const viceCaptain = selectedPlayers.find(p => p.id === vcId);
      
      if(!captain || !viceCaptain || cId === vcId) return;

      const getEffectiveRating = (p) => {
          const factor = p.soldPrice / p.basePrice;
          let finalRating = p.rating;
          if (p.rating > 88 && factor >= 8) finalRating = p.rating - 5;
          else if (p.rating > 88 && factor < 6) finalRating = p.rating + 5;
          else if (p.rating < 88 && factor > 6) finalRating = p.rating - 5;
          else if (p.rating <88 && factor < 4) finalRating = p.rating + 5;
          return Math.max(0, finalRating);
      };

      const cEffRating = getEffectiveRating(captain);
      const vcEffRating = getEffectiveRating(viceCaptain);

      let score = 0;
      score += (cEffRating * 2);      
      score += (vcEffRating * 1.5);   
      
      const leadershipBonus = (cEffRating * 0.10) + (vcEffRating * 0.10);
      
      selectedPlayers.forEach(p => {
          if (p.id !== cId && p.id !== vcId) {
              score += (getEffectiveRating(p) + leadershipBonus);
          }
      });

      team.totalScore = Math.round(score * 100) / 100;
      team.submitted11 = true;
      team.playing11 = selectedPlayers;
      
      updateRoomActivity(roomId);
      saveGameData();

      const activeTeams = Object.values(room.teams).filter(t => !t.isEliminated);
      const allSubmitted = activeTeams.every(t => t.submitted11);

      if(allSubmitted) {
          calculateWinner(roomId);
      } else {
          io.to(roomId).emit("teams-updated", Object.values(room.teams));
      }
  });
});

// Cleanup old rooms periodically (every hour)
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (rooms[roomId].lastActivity && (now - rooms[roomId].lastActivity) > 86400000) {
            const room = rooms[roomId];
            if (room.auction.timer) clearInterval(room.auction.timer);
            if (room.nextPlayerTimeout) clearTimeout(room.nextPlayerTimeout);
            delete rooms[roomId];
            console.log(`Cleaned up inactive room: ${roomId}`);
        }
    });
    saveGameData();
}, 3600000); // Run every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
