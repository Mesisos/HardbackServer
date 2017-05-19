
var util = require("util");
var moment = require('moment');
var constants = require('./constants.js');
var kue = require('kue');
var JsonPropertyFilter = require("json-property-filter");
var Mustache = require("mustache");


GameState = constants.GameState;
PlayerState = constants.PlayerState;
SlotType = constants.SlotType;
TurnType = constants.TurnType;
AIDifficulty = constants.AIDifficulty;

var Promise = Parse.Promise;
var Query = Parse.Query;

var Game = Parse.Object.extend("Game");
var Config = Parse.Object.extend("Config");
var Turn = Parse.Object.extend("Turn");
var Player = Parse.Object.extend("Player");
var Contact = Parse.Object.extend("Contact");
var Invite = Parse.Object.extend("Invite");

var parseObjectConfig = {
  "_User": {
    filter: [
      "displayName",
      "objectId",
      "avatar"
    ]
  },
  "Turn": {
    filter: [
      "**",
      "-lastValid"
    ],
    pre: function(turn, context) {
      turn.type = TurnType.Player;
      if (turn.save === null && turn.lastValid) {
        turn.save = turn.lastValid.save;
        turn.type = TurnType.Timeout;
      }
      return turn;
    }
  },
  "Game": {
    filter: [
      "**",
      "-lobbyTimeoutJob",
      "-turnTimeoutJob",
    ],
    post: function(game, context) {
      var now = moment();
      
      var momentCreated = moment(game.createdAt);
      game.createdAgo = momentCreated.from(now);
      game.updatedAgo = moment(game.updatedAt).from(now);
      var momentStartTimeout = momentCreated.add(constants.START_GAME_MANUAL_TIMEOUT, "seconds");
      game.startable =
        game.state == GameState.Lobby &&
        now.isAfter(momentStartTimeout);

      // Free slots and "joined" bool
      if (context && context.players) {
        var slots = game.config.slots;
        game.joined = false;
        if (slots) {
          slots.forEach(function(slot) {
            slot.filled = slot.type == SlotType.AI;
          }, this);
        }
        context.players.forEach(function(player) {
          var gameId = player.get("game").id;
          if (gameId != game.objectId) return;
          var slotIndex = player.get("slot");
          if (player.get("user").id == context.userId) {
            game.joined = true;
          }
          if (!slots) return;
          if (slotIndex < 0 || slotIndex >= slots.length) return;
          var slot = slots[slotIndex];
          slot.filled = true;
          slot.player = filterObject(player, context);
          slot.player = getPropFilter([
            "slot",
            "user"
          ]).apply(slot.player);
        }, this);

        if (slots) {
          var slotsFree = slots.filter(function(slot) {
            return slot.type == SlotType.Open && !slot.filled;
          });
          game.freeSlots = slotsFree.length;
        }
      }

      return game;
    }
  },
  "Invite": {
    filter: [
      "**",
      "-inviter"
    ]
  },
  "Player": {
    filter: [
      "**",
      "-game"
    ]
  }
};

// Hook into Object subclasses to provide master access for common methods
[Game, Config, Turn, Player, Contact, Invite].forEach(
  function(Obj) {
    Obj.internalSave = Obj.prototype.save;
    Obj.prototype.save = function(arg1, arg2, arg3) {
      var options;
      var args;
      var keyValueOptions = arg3 !== undefined;
      if (keyValueOptions) {
        if (!arg3) arg3 = {};
        options = arg3;
        args = [arg1, arg2, options];
      } else {
        if (!arg2) arg2 = {};
        options = arg2;
        args = [arg1, options];
      }
      options.useMasterKey = true;
      return Obj.internalSave.apply(this, args);
    };
    Obj.internalDestroy = Obj.prototype.destroy;
    Obj.prototype.destroy = function(options) {
      if (!options) options = {};
      options.useMasterKey = true;
      return Obj.internalDestroy.call(this, options);
    };
  }
);

// Hook into Parse.Object for master access
var PObject = {};
PObject.destroyAll = Parse.Object.destroyAll;
Parse.Object.destroyAll = function(list, options) {
  if (!options) options = {};
  options.useMasterKey = true;
  return PObject.destroyAll(list, options);
};



// Hook into Query.get for always-on master access and 
// better NOT_FOUND error messages
var PQuery = {};

PQuery.get = Query.prototype.get;
Query.prototype.get = function(objectId, options) {
  var that = this;
  if (!options) options = {};
  options.useMasterKey = true;
  var query = PQuery.get.call(this, objectId, options);
  return query.then(
    function(result) {
      return Promise.resolve(result);
    },
    function(err) {
      if (
          err instanceof Parse.Error &&
          err.code == Parse.Error.OBJECT_NOT_FOUND
        ) {
        var notFound = null;
        switch (that.className) {
          case "Game":    notFound = constants.t.GAME_NOT_FOUND; break;
          case "Player":  notFound = constants.t.PLAYER_NOT_FOUND; break;
          case "Contact": notFound = constants.t.CONTACT_NOT_FOUND; break;
          case "User":    notFound = constants.t.USER_NOT_FOUND; break;
        }
        if (notFound) return Promise.reject(new CodedError(notFound));
      }
      return Promise.reject(err);
    }
  );
};

PQuery.find = Query.prototype.find;
Query.prototype.find = function(options) {
  if (!options) options = {};
  options.useMasterKey = true;
  return PQuery.find.call(this, options);
};

PQuery.first = Query.prototype.first;
Query.prototype.first = function(options) {
  if (!options) options = {};
  options.useMasterKey = true;
  return PQuery.first.call(this, options);
};

PQuery.count = Query.prototype.count;
Query.prototype.count = function(options) {
  if (!options) options = {};
  options.useMasterKey = true;
  return PQuery.count.call(this, options);
};



/**
 * Error subclass for coded error messages.
 *
 * @param {Object} message Constant message object to use.
 * @param {Object} context Optional Mustache template "view" context object.
 * @api protected
 */
function CodedError(message, context) {
  if (context !== undefined) {
    this.message = Mustache.render(message.m, context);
  } else {
    this.message = message.m;
  }
  this.code = message.id;
  Error.captureStackTrace(this, CodedError);
}
util.inherits(CodedError, Error);





// Jobs
var jobs = kue.createQueue({
  redis: process.env.REDIS_URL
});

function addJob(name, config) {
  var promise = new Promise();

  var delay = config.delay; delete config.delay;
  
  var job = jobs.create(name, config);
  if (delay !== undefined) job.delay(delay);
  job.removeOnComplete(true);
  job.save(function(err) {
    if (err) {
      promise.reject(err);
    } else {
      promise.resolve(job);
    }
  });

  return promise;
}


function removeJobWithError(id) {
  var promise = new Promise();

  kue.Job.get(id, function(err, job) {
    if (err) {
      promise.reject(err);
      return;
    }
    job.remove(function(err) {
      if (err) {
        promise.reject(err);
        return;
      }
      promise.resolve();
    });
  });

  return promise;
}

function removeJob(id) {
  if (isNaN(Number(id))) {
    return Promise.resolve(false);
  }

  var promise = new Promise();
  kue.Job.get(id, function(err, job) {
    if (err) {
      promise.resolve(false);
      return;
    }
    job.remove(function(err) {
      if (err) {
        promise.resolve(false);
        return;
      }
      promise.resolve(true);
    });
  });
  return promise;
}



jobs.process('game turn timeout', 10, function(job, done) {

  var playerId = job.data.playerId;

  job.log("Player: " + playerId);

  new Query(Player)
    .include("game")
    .include("game.config")
    .get(playerId)
    .then(
      function(player) {
        job.log("Loaded");
        game = player.get("game");
        currentPlayer = game.get("currentPlayer");
        if (currentPlayer.id != player.id) {
          job.log("Timeout player " + player.id + " does not match current player " + currentPlayer.id);
          return Promise.reject(new Error("Unable to time out turn due to different current player"));
        }

        return new Query(Turn)
          .equalTo("game", game)
          .notEqualTo("save", null)
          .addDescending("createdAt")
          .first();
      }
    ).then(
      function(lastTurn) {

        var consecutiveTurnTimeouts = game.get("consecutiveTurnTimeouts");
        var playerNum = game.get("config").get("playerNum");
        var timeoutRounds = (consecutiveTurnTimeouts + 1) / playerNum;
        
        game.increment("consecutiveTurnTimeouts");

        var lastValidTurn =
          !lastTurn ?
            null
          :
            lastTurn.get("save") !== null ?
            lastTurn : lastTurn.get("lastValid")
        ;

        var turn = new Turn();
        turn.set("game", game);
        turn.set("save", null);
        turn.set("player", currentPlayer);
        turn.set("turn", game.get("turn"));
        turn.set("lastValid", lastValidTurn);

        if (timeoutRounds >= constants.GAME_ENDING_INACTIVE_ROUNDS) {
          job.log("Game timed out");
          job.log("  consecutiveTurnTimeouts:", consecutiveTurnTimeouts);
          job.log("  playerNum:", playerNum);
          game.set("state", GameState.Ended);
          return Promise.when(
            null,
            turn.save(),
            game.save(),
            notifyGame(game, constants.t.GAME_INACTIVE_TIMEOUT, { game: game })
          );
        }

        return Promise.when(
          turn.save(),
          gameNextPlayer(game, turn)
        );
      }
    ).then(
      function(nextPlayer, turn, endedGame, endedPush) {
        if (endedGame) {
          return Promise.resolve();
        }

        job.log("Next player: " + (nextPlayer ? nextPlayer.id : "N/A"));
        if (nextPlayer) {
          return Promise.resolve();
        } else {
          return Promise.reject(new Error("Unable to transition game to next player"));
        }
      }
    ).then(
      function() {
        job.log("Done");
        done();
      },
      function(err) {
        job.log(err.toString());
        done(err);
      }
    );
});

jobs.process('game lobby timeout', 10, function(job, done) {

  var gameId = job.data.gameId;

  job.log("Game: " + gameId);
  
  var game;

  new Query(Game)
    .include("currentPlayer.user")
    .get(gameId)
    .then(
      function(g) {
        game = g;

        if (game.get("state") != GameState.Lobby) {
          return Promise.reject(new Error("Not a lobby, skipping."));
        }

        return new Query(Player)
          .equalTo("game", game)
          .include("user")
          .find();
      }
    ).then(
      function(players) {
        job.log("Player count: " + players.length);
        job.log("Players:\n" + players);
        if (players.length < 2) {
          job.log("Timed out");
          notifyPlayers(
            players,
            constants.t.GAME_LOBBY_TIMEOUT,
            { game: game }
          );
          game.set("state", GameState.Ended);
          return game.save();
        } else {
          return startGame(game);
        }
      }
    ).then(
      function(g) {
        game = g;

        var state = game.get("state");
        job.log("Game state: " + GameState.getName(state));
        done();
      },
      function(error) {
        done(error);
      }
    );
});



function respondError(res, error, context) {
  if (error === undefined && context === undefined) {
    return (function(e, c) {
      respondError(res, e, c);
    });
  }

  var response;
  if (error instanceof Parse.Error) {
    switch (error.code) {
      case Parse.Error.SCRIPT_FAILED:
        if (error.message !== undefined) error = error.message;
        break;
      default:
        error.code = 2000 + error.code;
    }
  } 

  if (error instanceof CodedError) {
    response = error;
  } else if (error.id && error.m) {
    response = new CodedError(error, context);
  } else if (error.message) {
    response = new CodedError({ id: constants.t.UNKNOWN_ERROR.id, m: filterObject(error.message) });
  } else {
    response = filterObject(error);
  }
  res.error(response);
}

function errorOnInvalidUser(user, res) {
  var invalid = !user;
  if (invalid) respondError(res, constants.t.USER_NOT_FOUND);
  return invalid;
}

function checkGameState(game, acceptable) {
  var result = {};
  if (!game) {
    result.error = constants.t.GAME_NOT_FOUND;
  } else {
    var state = game.get("state");
    if (acceptable.indexOf(state) == -1) {
      result.error = constants.t.GAME_INVALID_STATE;
      result.context = {
        acceptableNames: acceptable.map(function(st) {
          return GameState.getName(st);
        }).join(", "),
        stateName: GameState.getName(state)
      };
    }
  }
  return result;
}

function errorOnInvalidGame(game, res, acceptable) {
  var stateResult = checkGameState(game, acceptable);
  if (stateResult.error) {
    respondError(res, stateResult.error, stateResult.context);
    return true;
  }
  return false;
}



function getPropFilter(filter) {
  return new JsonPropertyFilter.JsonPropertyFilter(
    filter.concat(["__type", "className"])
  );
}

function filterObject(obj, context, level) {
  if (level === undefined) level = 0;
  // var startTime; if (level == 0) startTime = Date.now();
  if (obj === null || obj === undefined) return obj;
  switch (typeof(obj)) {
    case "object":
      if (!Array.isArray(obj)) {

        if (typeof(obj.toJSON) === "function") {
          // console.log("Converting to JSON");
          var className = obj.className;
          obj = obj.toJSON();
          obj.className = className;
        }

        if (obj.className) {
          var config = parseObjectConfig[obj.className];
          if (config) {
            if (config.pre && obj.__type != "Pointer") {
              // console.log("Preprocessing");
              obj = config.pre(obj, context);
            }
            if (config.filter) {
              // console.log("Filtering");
              var propFilter = config.filterInstance;
              if (!propFilter) {
                propFilter = config.filterInstance = getPropFilter(config.filter);
              }
              obj = propFilter.apply(obj);
            }
            if (config.post && obj.__type != "Pointer") {
              // console.log("Postprocessing");
              obj = config.post(obj, context);
            }
          }
        }

        if (obj._context) {
          context = obj._context;
          delete obj._context;
        }

      }

      if (context) {
        context._parent = obj;
      }

      // console.log("Processing children");
      for (var key in obj) {
        // var prefix = ""; while (prefix.length < level) prefix = prefix + " ";
        // console.log(prefix, key + ": " + typeof(obj[key]));

        if (context) context._key = key;
        obj[key] = filterObject(obj[key], context, level + 1);
      }
      
      break;

  }
  // if (level == 0) console.log("Filtering:", Date.now() - startTime);
  return obj;
}

function respond(res, message, data, filter) {
  data = filterObject(data);
  if (filter) {
    data = getPropFilter(filter).apply(data);
  }
  data.code = message.id;
  
  res.success(data);
}

Parse.Cloud.define("checkNameFree", function(req, res) {
  
  var name = !req.params.displayName ? null : String(req.params.displayName);
  if (!name || name === "") {
    respondError(res, constants.t.INVALID_PARAMETER);
    return;
  }

  var query = new Query(Parse.User);
  query.equalTo("displayName", name);
  query.first().then(
    function(result) {
      respond(res, constants.t.AVAILABILITY, {
        available: !result
      });
    },
    respondError(res)
  );
});


Parse.Cloud.define("createGame", function(req, res) {
  if (errorOnInvalidUser(req.user, res)) return;

  createConfigFromRequest(req).then(
    function(config) {
      return createGameFromConfig(req.user, config);
    }
  ).then(
    function(gameInfo) {
      respond(res, constants.t.GAME_CREATED, gameInfo);
    },
    respondError(res)
  );

});

function getInviteLink(invite) {
  return constants.INVITE_URL_PREFIX + invite.id;
}

function getInvite(player) {
  var query = new Query(Invite);
  return query
    .equalTo("inviter", player)
    .include("inviter")
    .first()
    .then(
      function(invite) {
        if (invite) return Promise.resolve(invite);
        invite = new Invite();
        invite.set("inviter", player);
        return invite.save();
      }
    ).then(
      function(invite) {
        if (!invite) return Promise.reject(new CodedError(constants.t.GAME_INVITE_ERROR));
        return Promise.resolve(invite);
      }
    );
}

Parse.Cloud.define("getInvite", function(req, res) {
  if (errorOnInvalidUser(req.user, res)) return;

  var gameId = String(req.params.gameId);
  
  var gameQuery = new Query(Game);
  gameQuery.equalTo("objectId", gameId);

  var query = new Query(Player);
  query
    .equalTo("user", req.user)
    .matchesQuery("game", gameQuery)
    .first()
    .then(
      function(player) {
        if (!player) return Promise.reject(new CodedError(constants.t.PLAYER_NOT_FOUND));
        return getInvite(player);
      }
    ).then(
      function(invite) {
        respond(res, constants.t.GAME_INVITE, {
          "invite": invite,
          "link": getInviteLink(invite)
        });
      },
      respondError(res)
    );
  
});

function addPaging(query, req, config) {
  var limit = Number(req.params.limit);
  if (isNaN(limit)) limit = config.limit.default;
  if (limit < config.limit.min) limit = config.limit.min;
  if (limit > config.limit.max) limit = config.limit.max;

  var skip = Number(req.params.skip);
  if (isNaN(skip)) skip = 0;

  if (config.sort) {
    for (var si = 0; si < config.sort.length; si++) {
      var s = config.sort[si];
      switch (s.dir) {
        case "ascending":  query.addAscending(s.name); break;
        case "descending": query.addDescending(s.name); break;
        default: throw new Error(
          "Sort direction should be either 'ascending' or 'descending', not '" + s.dir + "'"
        );
      }
    }
  }

  query.limit(limit);
  query.skip(skip);

  return { limit: limit, skip: skip };
}

Parse.Cloud.define("findGames", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var configQuery = new Query(Config);
  configQuery
    .equalTo("isRandom", true);
  
  var games;
  var query = new Query(Game);
  addPaging(query, req, constants.FIND_GAME_PAGING);
  query
    .matchesQuery("config", configQuery)
    .equalTo("state", GameState.Lobby)
    .include("config")
    .include("creator")
    .include("currentPlayer")
    .include("currentPlayer.user")
    .find()
    .then(
      function(g) {
        games = g;
        var playerQuery = new Query(Player);
        if (games) playerQuery.containedIn("game", games);
        playerQuery
          .equalTo("state", PlayerState.Active)
          .include("user");
        return playerQuery.find();
      }
    ).then(
      function(allPlayers) {
        respond(res, constants.t.GAME_LIST, {
          _context: {
            players: allPlayers,
            userId: user.id
          },
          "games": games
        });
      },
        
      
      respondError(res)
    );

});




function createConfigFromRequest(req) {
  var config = new Config();

  var reqSlots = req.params.slots instanceof Array ? req.params.slots : null;
  if (!reqSlots) reqSlots = constants.GAME_DEFAULT_CONFIG.slots;
  if (reqSlots.length > constants.GAME_MAX_SLOTS) {
    return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
      reason: "Too many slots."
    })); 
  }
  var slots = [];
  var isRandom = false;
  var displayNames = [];
  var creatorSlots = 0;
  var noneSlots = 0;
  for (var slotIndex in reqSlots) {
    var reqSlot = reqSlots[slotIndex];
    var slot = {};
    slot.type = SlotType.parse(reqSlot.type);
    if (slot.type === null) {
      return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
        reason: "Missing or invalid slot type."
      }));
    }
    
    switch (slot.type) {
      case SlotType.Creator:
        creatorSlots++;
        break;
      case SlotType.Open:
        isRandom = true;
        break;
      case SlotType.Invite:
        if (typeof(reqSlot.displayName) != "string") {
          return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
            reason: "Missing or invalid invite slot display name."
          }));
        }
        displayNames.push({ slot: slot, name: reqSlot.displayName });
        break;
      case SlotType.AI:
        slot.difficulty = AIDifficulty.parse(reqSlot.difficulty);
        if (slot.difficulty === null) {
          return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
            reason: "Missing or invalid ai slot difficulty."
          }));
        }
        break;
      case SlotType.None:
        noneSlots++;
        break;
    }

    slots.push(slot);
  }
  config.set("playerNum", slots.length - noneSlots);
  config.set("isRandom", isRandom);

  if (creatorSlots != 1) {
    return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
      reason: "Exactly one creator slot must be present."
    }));
  }

  var turnMaxSec = req.params.turnMaxSec === undefined ?
    undefined : Number(req.params.turnMaxSec);
  if (turnMaxSec === undefined || isNaN(turnMaxSec)) {
    turnMaxSec = constants.GAME_DEFAULT_CONFIG.turnMaxSec;
  }
  config.set("turnMaxSec", turnMaxSec);

  var reqFameCards = req.params.fameCards;
  var fameCards = {};
  if (reqFameCards) {
    var fameCardNames = constants.FAME_CARD_NAMES;
    for (var i in fameCardNames) {
      var fameCardName = fameCardNames[i];
      var reqFameCard = Number(reqFameCards[fameCardName]);
      if (!isNaN(reqFameCard)) {
        fameCards[fameCardName] = reqFameCard;
      }
    }
  }
  config.set("fameCards", fameCards);

  var userQuery = new Query(Parse.User);
  return userQuery
    .containedIn("displayName", displayNames.map(function(dn) {
      return dn.name;
    }))
    .find()
    .then(
      function(users) {
        if (!users || users.length != displayNames.length) {
          return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
            reason: "Invite slot user(s) duplicate or not found."
          }));
        }

        var userIds = {};
        userIds[req.user.id] = true;
        users.forEach(function(user) {
          // Duplicate check
          if (userIds[user.id]) {
            return Promise.reject(new CodedError(constants.t.GAME_INVALID_CONFIG, {
              reason: "Duplicate slot users."
            }));
          }
          userIds[user.id] = true;

          // Display name to user ID map
          var dn = displayNames.find(function(dn) {
            return dn.name == user.get("displayName");
          });
          if (dn) dn.slot.userId = user.id;
        }, this);

        config.set("slots", slots);

        // TODO push notifications for invites
        
        return config.save();
      }
    );
}

function createGameFromConfig(user, config) {
  var savedGame = false;
  var gameInfo;
  var game = new Game();
  game.set("config", config);
  game.set("state", GameState.Init);
  game.set("turn", 0);
  game.set("consecutiveTurnTimeouts", 0);
  game.set("creator", user);
  return game.save().then(
    function(g) {
      game = g;
      savedGame = true;
      // Join creator into its own game
      return joinGame(game, user);
    }
  ).then(
    function(gi) {
      gameInfo = gi;

      var lobbyTimeout = constants.START_GAME_AUTO_TIMEOUT;
      return addJob("game lobby timeout", {
        delay: lobbyTimeout*1000,
        title: "Game " + game.id + ", " + lobbyTimeout + "s",
        gameId: game.id
      });
    }
  ).then(
    function(job) {
      // Current player set on game start
      game.set("currentPlayer", null);

      // Set game state to Lobby
      game.set("state", GameState.Lobby);

      // Save timeout job ID so it can be deleted later
      game.set("lobbyTimeoutJob", job.id);

      return game.save();
    }
  ).then(
    function(g) {
      game = g;
      gameInfo.game = game;
      return Promise.resolve(gameInfo);
    },
    function(error) {
      // Try cleaning up before failing
      if (savedGame) {
        return game.destroy().then(
          function() {
            return Promise.reject(error);
          },
          function(destroyError) {
            return Promise.reject(destroyError);
          }
        );
      }
    }
  );
}

Parse.Cloud.beforeDelete(Game, function(req, res) {
  var game = req.object;

  var config = game.get("config");
  var configPromise = config.destroy();

  var players = new Query(Player);
  var playerPromise = players
    .equalTo("game", game)
    .find()
    .then(
      function(results) {
        var invites = new Query(Invite);
        var invitePromise = invites
          .containedIn("inviter", results)
          .find()
          .then(
            function(results) {
              return Parse.Object.destroyAll(results);
            }
          );
        return Promise.when(
          invitePromise,
          Parse.Object.destroyAll(results)
        );
      }
    );

  var turns = new Query(Turn);
  var turnPromise = turns
    .equalTo("game", game)
    .find()
    .then(
      function(results) {
        return Parse.Object.destroyAll(results);
      }
    );

  var lobbyTimeoutJobPromise = removeJob(game.get("lobbyTimeoutJob"));
  var turnTimeoutJobPromise = removeJob(game.get("turnTimeoutJob"));

  Promise.when(
    configPromise,
    playerPromise,
    turnPromise,
    lobbyTimeoutJobPromise,
    turnTimeoutJobPromise
  ).then(
    function() {
      res.success();
    },
    function(error) {
      res.error(error);
    }
  );

});

function getPlayerCount(game) {
  var query = new Query(Player);
  return query
    .equalTo("game", game)
    .count();
}

function getGameInfo(game, playerCount, player) {
  return {
    game: game,
    playerCount: playerCount,
    player: player
  };
}

function sendPush(installationQuery, message, data) {
  var filtered = filterObject(data);
  
  var msg;
  if (message.m) {
    msg = Mustache.render(message.m, filtered);
  } else {
    throw new Error("Message Mustache template not found");
  }

  filtered.code = message.id;

  var obj = {
    alert: msg,
    data: filtered
  };

  // console.log("Push suppressed:", obj); return;

  return Parse.Push.send({
    where: installationQuery,
    data: obj
  }, { useMasterKey: true });
}

function notifyPlayers(players, message, data) {
  users = players.map(function(player) {
    return player.get("user");
  });

  var sessionQuery = new Query(Parse.Session);
  sessionQuery
    .containedIn("user", users);

  var installationQuery = new Query(Parse.Installation);
  installationQuery.matchesKeyInQuery("installationId", "installationId", sessionQuery);

  return sendPush(installationQuery, message, data);
}

function notifyGame(game, message, data) {
  var playerQuery = new Query(Player);
  return playerQuery
    .equalTo("game", game)
    .find()
    .then(
      function(players) {
        return notifyPlayers(players, message, data);
      }
    );
}


function startGame(game) {
  var stateResult = checkGameState(game, [GameState.Lobby]);
  if (stateResult.error) return Promise.reject(new CodedError(stateResult.error, stateResult.context));
  
  var playerQuery = new Query(Player);
  playerQuery
    .equalTo("game", game)
    .equalTo("state", PlayerState.Active)
    .equalTo("slot", 0);

  return Promise.when(playerQuery.first(), removeJob(game.get("lobbyTimeoutJob")))
    .then(
      function(p) {
        if (!p) {
          return Promise.reject(new CodedError(constants.t.GAME_START_ERROR));
        }
        game.set("currentPlayer", p);
        game.set("state", GameState.Running);
        return game.save();
      }
    ).then(
      function(g) {
        game = g;
        return notifyGame(game, constants.t.GAME_STARTED, { game: game });
      }
    ).then(
      function() {
        return prepareTurn(game, game.get("currentPlayer"));
      }
    ).then(
      function() {
        return Promise.resolve(game);
      }
    );
}

function joinGame(game, user) {
  var player;
  var playerCount;
  
  var initial = game.get("state") == GameState.Init;
  var config = game.get("config");
  var slots = config.get("slots");
  var reservedIndex = -1;
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    switch (slot.type) {
      case SlotType.Creator:
        if (user.id == game.get("creator").id) {
          reservedIndex = i;
        }
        break;
      case SlotType.Invite:
        if (user.id == slot.userId) {
          reservedIndex = i;
        }
        break;
    }
    if (reservedIndex != -1) break;
  }
  
  var slotIndexPromise;
  if (reservedIndex != -1) {
    slotIndexPromise = Promise.resolve(reservedIndex);
  } else {
    var playerQuery = new Query(Player);
    slotIndexPromise = playerQuery
      .equalTo("game", game)
      .equalTo("state", PlayerState.Active)
      .find()
      .then(
        function(players) {
          players.forEach(function(player) {
            slots[player.get("slot")].filled = true;
          }, this);
          var openIndex = slots.findIndex(function(slot) {
            return slot.type == SlotType.Open && !slot.filled;
          });
          if (openIndex >= 0 && openIndex < slots.length) {
            return Promise.resolve(openIndex);
          }
          return Promise.reject(new CodedError(constants.t.GAME_FULL));
        }
      );
  }
  
  return slotIndexPromise.then(
    function(slotIndex) {
      if (slotIndex == -1) {
        return Promise.reject(new CodedError(constants.t.GAME_FULL));
      }
      var player = new Player();
      player.set("game", game);
      player.set("user", user);
      player.set("state", PlayerState.Active);
      player.set("slot", slotIndex);
      return player.save();
    }
  ).then(
    function(p) {
      player = p;
      if (initial) return Promise.resolve();
      return addContacts(game, player);
    }
  ).then(
    function() {
      if (initial) return Promise.resolve(1);
      return getPlayerCount(game);
    }
  ).then(
    function(c) {
      playerCount = c;
      if (initial) return Promise.resolve(game);
      var maxPlayers = config.get("playerNum");
      var promise;
      if (playerCount > maxPlayers) {
        promise = new Promise();
        player
          .destroy()
          .then(
            function() {
              promise.reject(new CodedError(constants.t.GAME_FULL));
            },
            function() {
              promise.reject(new CodedError(constants.t.GAME_FULL_PLAYER_ERROR));
            }
          );
      } else if (playerCount == maxPlayers) {
        promise = startGame(game);
      } else {
        promise = Promise.resolve(game);
      }
      return promise;
    }
  ).then(
    function(game) {
      return Promise.resolve(getGameInfo(game, playerCount, player));
    }
  );
}

Parse.Cloud.beforeSave(Player, function(req, res) {
  var player = req.object;
  
  // Don't allow users to join a game twice in a row
  if (player.get("state") == PlayerState.Active) {
    var query = new Query(Player);
    query.equalTo("game", player.get("game"));
    query.equalTo("user", player.get("user"));
    query.equalTo("state", PlayerState.Active);
    query.first().then(
      function(existing) {
        if (existing) {
          res.error(constants.t.PLAYER_ALREADY_IN_GAME);
        } else {
          res.success();
        }
      },
      function(error) {
        res.error(error);
      }
    );
  } else {
    res.success();
  }

});

function fetchInclude(object, includes, options) {
  if (!object) {
    return Promise.resolve();
  }
  var query = new Query(object);
  return query
    .include(includes)
    .get(object.id, options);
}

Parse.Cloud.define("joinGame", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var gameInfo;

  var gameId = String(req.params.gameId);
  var query = new Query(Game);
  query
    .include("config")
    .get(gameId)
    .then(
      function(game) {
        if (errorOnInvalidGame(game, res, [GameState.Lobby])) return;
        return joinGame(game, user);
      }
    ).then(
      function(gi) {
        gameInfo = gi;
        return fetchInclude(gameInfo ? gameInfo.game : null, [
          "config",
          "creator",
          "currentPlayer",
          "currentPlayer.user"
        ]);
      }
    ).then(
      function(game) {
        gameInfo.game = game;
        respond(res, constants.t.GAME_JOINED, gameInfo);
      },
      respondError(res)
    );
});


Parse.Cloud.define("leaveGame", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var gameId = String(req.params.gameId);
  
  var leaver;
  var game;
  var currentLeft;
  var aborted;
  var gameQuery = new Query(Game);
  gameQuery
    .get(gameId)
    .then(
      function(g) {
        game = g;
        if (!game) return Promise.reject(new CodedError(constants.t.GAME_NOT_FOUND));
        
        if (errorOnInvalidGame(game, res, [
          GameState.Lobby,
          GameState.Running
        ])) return;

        var query = new Query(Player);
        return query
          .equalTo("game", game)
          .equalTo("user", user)
          .equalTo("state", PlayerState.Active)
          .include("user")
          .first();
      }
    ).then(
      function(player) {
        if (!player) return Promise.reject(new CodedError(constants.t.PLAYER_NOT_IN_GAME));
        leaver = player;
        player.set("state", PlayerState.Inactive);
        
        var currentPlayer = game.get("currentPlayer");
        currentLeft = currentPlayer && currentPlayer.id == player.id;

        aborted =
          game.get("state") == GameState.Lobby &&
          game.get("creator").id == user.id;
        
        if (aborted) {
          game.set("state", GameState.Ended);
          notifyGame(game, constants.t.GAME_ABORTED, {
            game: game
          });
        }

        return Promise.when(
          player.save(),

          currentLeft && !aborted ?
            gameNextPlayer(game) :
            Promise.resolve(player),

          aborted ?
            game.save() :
            Promise.resolve(game)
        );
      }
    ).then(
      function(player, nextPlayer, g) {
        game = g;
        respond(res, constants.t.GAME_LEFT, {
          player: leaver
        });
      },
      respondError(res)
    );

});

Parse.Cloud.define("declineInvite", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var gameId = String(req.params.gameId);
  
  var game;
  var gameQuery = new Query(Game);
  gameQuery
    .include("config")
    .get(gameId)
    .then(
      function(g) {
        game = g;
        if (!game) return Promise.reject(new CodedError(constants.t.GAME_NOT_FOUND));
        
        if (errorOnInvalidGame(game, res, [
          GameState.Lobby
        ])) return;

        var config = game.get("config");
        var slots = config.get("slots");
        var inviteSlot = slots.find(function(slot) {
          return slot.type == SlotType.Invite && slot.userId == user.id
        });

        if (!inviteSlot) return Promise.reject(new CodedError(constants.t.GAME_INVITE_ERROR));

        inviteSlot.type = SlotType.Open;
        inviteSlot.userId = undefined;

        return config.save();
      }
    ).then(
      function() {
        respond(res, constants.t.GAME_INVITE_DECLINED, {});
      },
      respondError(res)
    )

});



function addContacts(game, player) {
  var user = player.get("user");

  var playerQuery = new Query(Player);
  return playerQuery
    .equalTo("game", game)
    .find()
    .then(
      function(players) {
        var gameUsers = players.map(function(player) {
          return player.get("user");
        });

        var contactPromises = [];
        gameUsers.forEach(function(gameUser) {
          var contact;
          
          if (user.id == gameUser.id) return;

          // Add user in game as contact of player
          contact = new Contact();
          contact.set("user", user);
          contact.set("contact", gameUser);
          contactPromises.push(contact.save());

          // Add player as contact of user in game
          contact = new Contact();
          contact.set("user", gameUser);
          contact.set("contact", user);
          contactPromises.push(contact.save());
        }, this);

        return Promise.when(contactPromises);
      }
    ).then(
      function(contacts) {
        return Promise.resolve();
      },
      function(errors) {
        var actualErrors = errors.filter(function(error) {
          return typeof(error.message) != 'object' || error.message.exists !== true;
        });
        if (actualErrors.length > 0) return Promise.reject(actualErrors);
        return Promise.resolve();
      }
    );
}

Parse.Cloud.beforeSave(Contact, function(req, res) {
  var contact = req.object;

  var query = new Query(Contact);
  query
    .equalTo("user", contact.get("user"))
    .equalTo("contact", contact.get("contact"))
    .first()
    .then(
      function(existing) {
        if (existing) {
          res.error({ exists: true });
        } else {
          res.success();
        }
      },
      function(error) {
        res.error(error);
      }
    );
});

Parse.Cloud.define("listGames", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var gameIds = req.params.gameIds;
  if (!Array.isArray(gameIds)) gameIds = null;
  
  var games = !gameIds ? null : gameIds.map(function(gameId) {
    var game = new Game();
    game.id = gameId;
    return game;
  });

  var gamesPromise = games ? 
    Parse.Object.fetchAll(games) : Promise.resolve(null);
  
  gamesPromise.then(
    function(games) {
      var playerQuery = new Query(Player);
      if (games) playerQuery.containedIn("game", games);
      addPaging(playerQuery, req, constants.GAME_PAGING);
      playerQuery
        .equalTo("user", user)
        .equalTo("state", PlayerState.Active)
        .include("game")
        .include("game.config")
        .include("game.creator")
        .include("game.currentPlayer")
        .include("game.currentPlayer.user");

      return playerQuery.find();
    }
  ).then(
    function(players) {
      games = players.map(function(player) {
        return player.get("game");
      });

      var playerQuery = new Query(Player);
      return playerQuery
        .equalTo("state", PlayerState.Active)
        .containedIn("game", games)
        .include("user")
        .find();
    }
  ).then(
    function(allPlayers) {
      respond(res, constants.t.GAME_LIST, {
        _context: {
          players: allPlayers,
          userId: user.id
        },
        "games": games
      });
    },
    respondError(res)
  );

});

Parse.Cloud.define("startGame", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var gameId = String(req.params.gameId);
  var gameQuery = new Query(Game);
  var game;
  var player;
  gameQuery
    .include("config")
    .equalTo("creator", user)
    .get(gameId)
    .then(
      function(g) {
        game = g;
        var playerQuery = new Query(Player);
        return playerQuery
          .equalTo("game", game)
          .equalTo("user", user)
          .first();
      },
      function(err) {
        if (err.code == constants.t.GAME_NOT_FOUND.id) {
          return Promise.reject(new CodedError(constants.t.GAME_THIRD_PARTY));
        }
        return Promise.reject(err);
      }
    ).then(
      function(p) {
        player = p;
        if (!player) return Promise.reject(new CodedError(constants.t.GAME_THIRD_PARTY));
        if (filterObject(game).startable) {
          return startGame(game);
        } else {
          return Promise.reject(new CodedError(constants.t.GAME_NOT_STARTABLE));
        }
      }
    ).then(
      function(g) {
        game = g;
        if (game) {
          return getPlayerCount(game);
        } else {
          return Promise.reject(new CodedError(constants.t.GAME_START_ERROR));
        }
      }
    ).then(
      function(playerCount) {
        if (playerCount >= 2) {
          respond(res, constants.t.GAME_STARTED, getGameInfo(game, playerCount, player));
        } else {
          respondError(res, constants.t.GAME_INSUFFICIENT_PLAYERS);
        }
      },
      respondError(res)
    );
});

Parse.Cloud.define("listTurns", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var gameId = String(req.params.gameId);
  var gameQuery = new Query(Game);
  gameQuery
    .get(gameId)
    .then(
      function(g) {
        game = g;
        var playerQuery = new Query(Player);
        return playerQuery
          .equalTo("game", game)
          .equalTo("user", user)
          .first();
      }
    ).then(
      function(player) {
        if (!player) return Promise.reject(new CodedError(constants.t.TURN_THIRD_PARTY));
        if (errorOnInvalidGame(game, res, [GameState.Running, GameState.Ended])) return;
        var query = new Query(Turn);
        addPaging(query, req, constants.TURN_PAGING);
        return query
          .equalTo("game", game)
          .include("player.user")
          .include("lastValid")
          .find();
      }
    ).then(
      function(turns) {
        respond(res, constants.t.TURN_LIST, {
          turns: turns
        });
      },
      respondError(res)
    );
});

Parse.Cloud.define("listFriends", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var contactQuery = new Query(Contact);
  addPaging(contactQuery, req, constants.CONTACT_PAGING);
  contactQuery
    .equalTo("user", user)
    .include("contact")
    .find()
    .then(
      function(contacts) {
        var users = contacts.map(function(contact) {
          return contact.get("contact");
        });
        respond(res, constants.t.CONTACT_LIST, {
          contacts: users
        });
      },
      respondError(res)
    );
});

Parse.Cloud.define("deleteFriend", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var contactId = String(req.params.userId);
  var contact = new Parse.User();
  contact.id = contactId;

  var contactQuery = new Query(Contact);
  contactQuery
    .equalTo("user", user)
    .equalTo("contact", contact)
    .first()
    .then(
      function(contact) {
        if (!contact) return Promise.reject(new CodedError(constants.t.CONTACT_NOT_FOUND));
        return contact.destroy();
      }
    ).then(
      function() {
        respond(res, constants.t.CONTACT_DELETED, {});
      },
      respondError(res)
    );
});

function prepareTurn(game, player, previousTurn) {

  if (!previousTurn) previousTurn = null;

  var config = game.get("config");
  var timeout = config.get("turnMaxSec");
  if (isNaN(timeout)) {
    return Promise.reject(new CodedError(constants.t.GAME_INVALID_TIMEOUT, {
      timeout: timeout
    }));
  }

  var pushPromise = notifyPlayers([player], constants.t.PLAYER_TURN, {
    game: game,
    previousTurn: previousTurn
  });

  var job;
  var jobPromise = addJob("game turn timeout", {
    delay: timeout*1000,
    title:
      "Game " + game.id +
      ", " + "Player " + player.id +
      ", " + timeout + "s" +
      ", " + (game.get("consecutiveTurnTimeouts") + 1) + " / " +
             constants.GAME_ENDING_INACTIVE_ROUNDS*config.get("playerNum"),
    playerId: player.id
  }).then(
    function(j) {
      job = j;
      var gameSaver = new Game();
      gameSaver.id = game.id;
      gameSaver.set("turnTimeoutJob", job.id);
      return gameSaver.save(); 
    }
  ).then(
    function(savedGame) {
      return Promise.resolve(job);
    }
  );

  return Promise.when(pushPromise, jobPromise);
}

/**
 * Transitions the game to the next player. This also saves any pending changes
 * made to the game object.
 * 
 * @param game      The game to transition.
 * @param lastTurn  The turn to include with the message to the next player.
 *                  Optional, retrieves the latest turn if undefined.
 * @param final     Specifies whether the turn was final (game ending) or not.
 */
function gameNextPlayer(game, lastTurn, final) {

  var nextPlayer;

  return (final ? Promise.resolve(null) : findNextPlayer(game)).then(
    function(np) {
      nextPlayer = np;
      game.increment("turn");
      game.set("currentPlayer", nextPlayer);

      var turnTimeoutRemovalPromise = removeJob(game.get("turnTimeoutJob"));

      var turnPromise;
      if (lastTurn) {
        turnPromise = Promise.resolve(lastTurn);
      } else {
        var turnQuery = new Query(Turn);
        turnPromise = turnQuery
          .equalTo("game", game)
          .addDescending("createdAt")
          .first();
      }

      // `nextPlayer` can be null either on the final turn or with no
      // active players left in the game.
      var configPromise;
      if (nextPlayer) {
        configPromise = Parse.Object.fetchAllIfNeeded([game.get("config")]);
      } else {
        configPromise = Promise.resolve();
        game.set("state", GameState.Ended);
      }

      return Promise.when(game.save(), turnPromise, configPromise, turnTimeoutRemovalPromise);
    }
  ).then(
    function(g, turn, configResults, turnTimeoutJob) {
      if (nextPlayer) {
        return prepareTurn(game, nextPlayer, turn);
      }
      return Promise.resolve();
    }
  ).then(
    function() {
      return Promise.resolve(nextPlayer);
    }
  );

}

Parse.Cloud.define("gameTurn", function(req, res) {
  if (errorOnInvalidUser(req.user, res)) return;

  var game;
  var gameId = String(req.params.gameId);
  var final = Boolean(req.params.final);
  var query = new Query(Game);
  query
    .include("currentPlayer")
    .get(gameId)
    .then(
      function(g) {
        game = g;
        if (errorOnInvalidGame(game, res, [GameState.Running])) return;

        var currentPlayer = game.get("currentPlayer");
        if (
          !currentPlayer || 
          currentPlayer.get("user").id != req.user.id ||
          currentPlayer.get("state") != PlayerState.Active
        ) {
          return Promise.reject(new CodedError(constants.t.TURN_NOT_IT));
        }

        var save = req.params.save;
        if (!save || typeof(save) != 'string' || save === "") {
          return Promise.reject(new CodedError(constants.t.TURN_INVALID_SAVE));
        }

        var turn = new Turn();
        turn.set("game", game);
        turn.set("save", save);
        turn.set("player", currentPlayer);
        turn.set("turn", game.get("turn"));
        turn.set("lastValid", null);

        game.set("consecutiveTurnTimeouts", 0);

        return Promise.when(
          turn.save(),
          gameNextPlayer(game, turn, final)
        );
      }
    ).then(
      function(turn, nextPlayer) {
        
        var promises = [];

        if (final) {
          promises[promises.length] = notifyGame(game, constants.t.GAME_ENDED, {
            game: game,
            lastTurn: turn
          });
        }

        return Promise.when(promises);
      }
    ).then(
      function(results) {
        respond(res, constants.t.TURN_SAVED, {
          ended: final
        });
      },
      respondError(res)
    );
});

/**
 * Finds the player that should have the next turn by slot order.
 * For only one player it always returns that player.
 * If no player was found (i.e. the game has no active players) it returns null.
 * 
 * Returns a promise with either a fulfilled player value (or null) or rejected
 * with an error.
 */
function findNextPlayer(game) {
  var currentPlayer = game.get("currentPlayer");
  if (!currentPlayer) {
    return Promise.reject(new CodedError(constants.t.PLAYER_NEXT_NO_CURRENT));
  }

  // console.log("Current player slot:\n ", currentPlayer.get("slot"));

  function getNextPlayerQuery() {
    var query = new Query(Player);
    query.equalTo("game", game);
    query.equalTo("state", PlayerState.Active);
    query.addAscending("slot");
    return query;
  }

  var query;
  
  query = getNextPlayerQuery();
  query.greaterThanOrEqualTo("slot", currentPlayer.get("slot"));
  query.notEqualTo("objectId", currentPlayer.id);

  return query.first().then(
    function(nextPlayer) {
      if (nextPlayer) {
        // console.log("Next newer player slot:\n ", nextPlayer.get("slot"));
        return Promise.resolve(nextPlayer);
      } else {
        query = getNextPlayerQuery();
        query.limit(1);
        return query.first();
      }
    }
  );
}



Parse.Cloud.define("userSet", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var avatar = req.params.avatar;
  if (avatar !== undefined) {
    if (typeof(avatar) == "number") {
      user.set("avatar", avatar);
    } else {
      respondError(res, constants.t.INVALID_PARAMETER);
      return;
    }
  }

  user
    .save(null, { useMasterKey: true })
    .then(
      function(user) {
        respond(res, constants.t.USER_SAVED, {});
      },
      respondError(res)
    );
});


Parse.Cloud.beforeSave(Parse.User, function(req, res) {
    var user = req.object;

    var email = user.get("username");
    if
      (
        !email || 
        typeof(email) !== "string" ||
        email.indexOf("@") == -1
      )
    {
      respondError(res, constants.t.INVALID_PARAMETER);
      return;
    }

    var emailField = user.get("email");
    if (emailField) {
      respondError(res, constants.t.INVALID_PARAMETER);
      return;
    }

    user.set("email", email);

    var displayName = user.get("displayName");

    if
      (
        !displayName || 
        typeof(displayName) !== "string" ||
        displayName.length < constants.DISPLAY_NAME_MIN ||
        displayName.length > constants.DISPLAY_NAME_MAX
      )
    {
      respondError(res, constants.t.INVALID_PARAMETER);
      return;
    }
    
    var avatar = user.get("avatar");
    if (typeof(avatar) == 'undefined') avatar = constants.AVATAR_DEFAULT;
    if (typeof(avatar) != "number" || isNaN(avatar)) {
      respondError(res, constants.t.INVALID_PARAMETER);
      return;
    }

    var query = new Query(Parse.User);
    if (user.id) query.notEqualTo("objectId", user.id)
    query
      .equalTo("displayName", displayName)
      .first()
      .then(
        function(result) {
          if (result) {
            respondError(res, constants.t.DISPLAY_NAME_TAKEN)
            return
          }
          res.success();
        },
        respondError(res)
    );
});


// TODO: add beforeSave validation
// Parse.Cloud.beforeSave(Game, function(req, res) {
//   var game = req.object;
