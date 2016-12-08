
var util = require("util");
var moment = require('moment');
var constants = require('./constants.js');
var kue = require('kue');
var JsonPropertyFilter = require("json-property-filter");

GameState = constants.GameState;
PlayerState = constants.PlayerState;
AIDifficulty = constants.AIDifficulty;

var Promise = Parse.Promise;
var Query = Parse.Query;

var Game = Parse.Object.extend("Game");
var Config = Parse.Object.extend("Config");
var Turn = Parse.Object.extend("Turn");
var Player = Parse.Object.extend("Player");
var Contact = Parse.Object.extend("Contact");
var Invite = Parse.Object.extend("Invite");


// Jobs
var jobs = kue.createQueue();

function addJob(name, config) {
  var promise = new Promise();

  var delay = config.delay; delete config.delay;
  
  var job = jobs.create(name, config);
  if (delay !== undefined) job.delay(delay);
  job.save(function(err) {
    if (err) {
      promise.reject(err);
    } else {
      promise.resolve(job);
    }
  });

  return promise;
}


function removeJob(id) {
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
    })
  });

  return promise;
}



jobs.process('game turn timeout', 10, function(job, done) {

  var playerId = job.data.playerId;

  job.log("Player: " + playerId);

  
  new Query(Player)
    .include("game")
    .get(playerId)
    .then(
      function(player) {
        job.log("Loaded");
        return gameNextPlayer(player.get("game"));
      }
    ).then(
      function(nextPlayer) {
        job.log("Next player: " + (nextPlayer ? nextPlayer.id : "N/A"));
        if (nextPlayer) {
          done();
        } else {
          done(new Error("Unable to transition game to next player"));
        }
      },
      function(err) {
        done(err);
      }
    )

});

jobs.process('game lobby timeout', 10, function(job, done) {

  var gameId = job.data.gameId;

  job.log("Game: " + gameId);
  
  var game;
  var playerCount;

  new Query(Game)
    .get(gameId)
    .then(
      function(g) {
        game = g;

        if (game.get("state") != GameState.Lobby) {
          return Promise.reject("Not a lobby, skipping.");
        }

        return getPlayerCount(game);
      }
    ).then(
      function(c) {
        playerCount = c;

        job.log("Player count: " + playerCount);

        if (playerCount < 2) {
          job.log("Timed out");
          notifyPlayers([game.get("currentPlayer")], {
            alert: "Game '" + game.id + "' timed out, nobody joined!",
            data: {
              game: game
            }
          });
          game.set("state", GameState.Ended)
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
        done(new Error(error));
      }
    );
});



function defaultError(res) {
  return (function(error) {
    res.error(error);
  });
}

function errorOnInvalidUser(user, res) {
  var invalid = !user;
  if (invalid) res.error("User not found.");
  return invalid;
}

function errorOnInvalidGame(game, res, acceptable) {
  if (!game) {
    res.error("Game not found.");
    return true;
  }
  var state = game.get("state");
  if (acceptable.indexOf(state) == -1) {

    var acceptableNames = acceptable.map(function(st) {
      return GameState.getName(st);
    }).join(", ");

    var stateName = GameState.getName(state);
    res.error("Game state '" + stateName + "' does not accept this operation. Supported states: " + acceptableNames);

    return true;
  }
  return false;
}


Parse.Cloud.define("checkNameFree", function(req, res) {
  
  var name = String(req.params.displayName);
  if (!name || name === "") {
    res.error("Unable to check, invalid display name.");
    return;
  }

  var query = new Query(Parse.User);
  query.equalTo("displayName", name);
  query.find().then(
    function(results) {
      res.success({
        available: results.length === 0
      });
    },
    defaultError(res)
  );
});




      // var game = new Game();
      // game.set("config", config);
      // game.set("state", GameState.PENDING);
      // game.set("turn", 0);
      // game.save().then(
      //   function(game) {
      //     res.success({
      //       id: game.id
      //     });
      //   },
      //   function(gameError) {
      //     // Destroy config if creating the game was unsuccessful
      //     config.destroy().then(
      //       function(config) {
      //         res.error(gameError);
      //       }
      //     );
      //   }
      // );


function respond(res, data, filter) {
  if (filter) {
    var propFilter = new JsonPropertyFilter.JsonPropertyFilter(filter);
    data = propFilter.apply(data);
  }
  res.success(data);
}


Parse.Cloud.define("createGame", function(req, res) {
  if (errorOnInvalidUser(req.user, res)) return;

  createConfigFromRequest(req).then(
    function(config) {
      return createGameFromConfig(req.user, config);
    }
  ).then(
    function(gameInfo) {
      respond(res, gameInfo);
    },
    defaultError(res)
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
        if (!invite) return Promise.reject("Unable to get invite.");
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
        if (!player) return Promise.reject("Unable to find player.");
        return getInvite(player);
      }
    ).then(
      function(invite) {
        res.success({
          "invite": invite,
          "link": getInviteLink(invite)
        });
      },
      defaultError(res)
    );
  
});

Parse.Cloud.define("findGames", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var minLimit = 1;
  var maxLimit = 100;
  var defaultLimit = 20;

  var limit = Number(req.params.limit);
  if (isNaN(limit)) limit = defaultLimit;
  if (limit < minLimit) limit = minLimit;
  if (limit > maxLimit) limit = maxLimit;

  var skip = Number(req.params.skip);
  if (isNaN(skip)) skip = 0;

  var configQuery = new Query(Config);
  configQuery
    .equalTo("isRandom", true);
  
  var query = new Query(Game);
  query
    .matchesQuery("config", configQuery)
    .equalTo("state", GameState.Lobby)
    .addAscending("createdAt")
    .include("config")
    .limit(limit)
    .skip(skip)
    .find()
    .then(
      function(games) {
        if (games) {
          res.success({
            "games": games
          });
        } else {
          res.error("No games found.");
        }
      },
      defaultError(res)
    );

});





// TODO remove this as it's not needed anymore
function createConfigFromRandom() {
  var config = new Config();
  config.set("slotNum", 2);
  config.set("isRandom", true);
  config.set("fameCards", {});
  config.set("aiDifficulty", AIDifficulty.None);
  config.set("turnMaxSec", 60);
  return config.save();
}

function createConfigFromRequest(req) {
  var config = new Config();
  config.set("slotNum", Number(req.params.slotNum));
  config.set("isRandom", Boolean(req.params.isRandom));
  
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
  config.set("aiDifficulty", Number(req.params.aiDifficulty));
  config.set("turnMaxSec", Number(req.params.turnMaxSec));
  return config.save();
}

function createGameFromConfig(user, config) {
  var promise = new Promise();
  var savedGame = false;
  var gameInfo;
  var game = new Game();
  game.set("config", config);
  game.set("state", GameState.Init);
  game.set("turn", 0);
  game.set("creator", user);
  game.save().then(
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
        title: "Lobby " + game.id + " times out after " + lobbyTimeout + "s",
        gameId: game.id
      });
    }
  ).then(
    function(job) {
      // Set creator player as the current player
      game.set("currentPlayer", gameInfo.player);

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
      promise.resolve(gameInfo);
    },
    function(error) {
      // Try cleaning up before failing
      var toDestroy = [config];
      if (savedGame) toDestroy.push(game);
      Parse.Object.destroyAll(toDestroy).then(
        function(config) {
          promise.reject(error);
        },
        function(destroyError) {
          promise.reject(destroyError);
        }
      );
    }
  );
  return promise;
}

Parse.Cloud.beforeDelete(Game, function(req, res) {
  var game = req.object;
  var config = game.get("config");

  var configP = config.destroy();

  var playersP = new Promise();
  var players = new Query(Player);
  players.equalTo("game", game);
  players.find().then(
    function(results) {
      return Parse.Object.destroyAll(results);
    },
    function(error) {
      playersP.reject("Unable to find player to destroy: " + error);
    }
  ).then(
    function() {
      playersP.resolve();
    },
    function(error) {
      playersP.reject("Unable to destroy all players: " + error);
    }
  );

  Promise.when([configP, playersP]).then(
    function() {
      res.success();
    },
    function(error) {
      res.error(error);
    }
  );

  // TODO: remove invites
  // TODO: remove turns

/*
  var turns = new Query(Turn);
  turns.equalTo("game", game);
  turns.find().then(
    function(results) {
      for (var i = 0; i < results.length; i++) {
        var turn = results[i];
        turn.destroy().then(
          function(player) {},
          function(error) {
            console.error("Unable to destroy player", error);
          }
        )
      }
    },
    function(error) {
      console.error("Unable to find player to destroy", error);
    }
  );
*/
});

function getPlayerCount(game) {
  var query = new Query(Player);
  return query
    .equalTo("game", game)
    .count();
}

function getGameInfo(game, playerCount, player) {
  return {
    game: augmentGameState(game.toJSON()),
    playerCount: playerCount,
    player: player
  };
}

function notifyPlayers(players, data) {
  users = players.map(function(player) {
    return player.get("user");
  });

  var sessionQuery = new Query(Parse.Session);
  sessionQuery
    .containedIn("user", users)

  var installationQuery = new Query(Parse.Installation);
  installationQuery.matchesKeyInQuery("installationId", "installationId", sessionQuery);

  return Parse.Push.send({
    where: installationQuery,
    data: data
  }, { useMasterKey: true });
}

function notifyGame(game, data) {
  var playerQuery = new Query(Player);
  return playerQuery
    .equalTo("game", game)
    .find()
    .then(
      function(players) {
        return notifyPlayers(players, data);
      }
    );
}


function startGame(game) {
  var state = game.get("state");
  if (state != GameState.Lobby) {
    return Promise.reject(
      "Unable to start a game in state: " + GameState.getName(state)
    );
  }
  game.set("state", GameState.Running);

  return Promise.when(game.save(), removeJob(game.get("lobbyTimeoutJob")))
    .then(
      function(g) {
        game = g;
        return notifyGame(game, {
          alert: "Game '" + game.id + "' has started!",
          data: {
            game: augmentGameState(game.toJSON())
          }
        });
      }
    ).then(
      function() {
        return prepareTurn(game, game.get("currentPlayer"));
      }
    ).then(
      function() {
        return Promise.resolve(game)
      }
    );
}

function joinGame(game, user) {
  var player;
  var playerCount;
  
  function getPlayer(game, user) {
    var player = new Player();
    player.set("game", game);
    player.set("user", user);
    player.set("state", PlayerState.Active);
    return player.save();
  }
  
  var initial = game.get("state") == GameState.Init;
  return getPlayer(game, user).then(
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
      var config = game.get("config");
      var maxPlayers = config.get("slotNum");
      var promise;
      if (playerCount > maxPlayers) {
        promise = new Promise();
        player
          .destroy()
          .then(
            function() {
              promise.reject("Unable to join, too full.");
            },
            function() {
              promise.reject("Game too full, but unable to remove player.");
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
          res.error("Player already in game.");
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



Parse.Cloud.define("joinGame", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
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
      function(gameInfo) {
        res.success(gameInfo);
      },
      defaultError(res)
    );
});


Parse.Cloud.define("leaveGame", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var gameId = String(req.params.gameId);
  
  var leaver;
  var game;
  var gameQuery = new Query(Game);
  gameQuery
    .get(gameId)
    .then(
      function(g) {
        game = g;
        if (errorOnInvalidGame(game, res, [GameState.Running])) return;

        var query = new Query(Player);
        return query
          .equalTo("game", game)
          .equalTo("user", user)
          .equalTo("state", PlayerState.Active)
          .first();
      }
    ).then(
      function(player) {
        if (!player) return Promise.reject("Unable to leave game, user not in game.");
        leaver = player;
        player.set("state", PlayerState.Inactive);
        return player.save();
      }
    ).then(
      function(player) {
        if (game.get("currentPlayer").id == player.id) {
          return findNextPlayer(game);
        }
        return Promise.resolve(player);
      }
    ).then(
      function(player) {
        if (!player) return Promise.reject("Unable to transition to next player.");
        if (game.get("currentPlayer").id != player.id) {
          game.set("currentPlayer", player);
          return game.save();
        }
        return Promise.resolve(game);
      }
    ).then(
      function(game) {
        res.success({
          left: true,
          player: leaver
        });
      },
      defaultError(res)
    );

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
          return error.message != "[exists]";
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
          res.error("[exists]");
        } else {
          res.success();
        }
      },
      function(error) {
        res.error(error);
      }
    );
});

// I never asked for this.
function augmentGameState(game) {
  var now = moment();
  var momentCreated = moment(game.createdAt);
  game.createdAgo = momentCreated.from(now);
  game.updatedAgo = moment(game.updatedAt).from(now);
  var momentStartTimeout = now.subtract(constants.START_GAME_MANUAL_TIMEOUT, "seconds");
  game.startable =
    game.state == GameState.Lobby &&
    momentCreated.isBefore(momentStartTimeout);
  return game;
}


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
      playerQuery.equalTo("user", user);
      playerQuery.include("game");
      if (games) playerQuery.containedIn("game", games);
      playerQuery.limit(1000);
      return playerQuery.find();
    }
  ).then(
    function(players) {
      var games = players.map(function(player) {
        return augmentGameState(player.get("game").toJSON());
      });
      res.success({
        "games": games
      });
    },
    defaultError(res)
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
      }
    ).then(
      function(p) {
        player = p;
        if (!player) return Promise.reject("Unable to start a third party game.");
        var gameJSON = game.toJSON();
        augmentGameState(gameJSON);
        if (gameJSON.startable) {
          return startGame(game);
        } else {
          return Promise.reject("Unable to start game, invalid state.");
        }
      }
    ).then(
      function(g) {
        game = g;
        if (game) {
          return getPlayerCount(game);
        } else {
          return Promise.reject("Unable to start game.");
        }
      }
    ).then(
      function(playerCount) {
        if (playerCount >= 2) {
          res.success(getGameInfo(game, playerCount, player));
        } else {
          res.error("Unable to start game with less than two players.");
        }
      },
      defaultError(res)
    );
});

Parse.Cloud.define("listTurns", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;
  
  var minLimit = 1;
  var maxLimit = 100;
  var defaultLimit = 3;

  var limit = Number(req.params.limit);
  if (isNaN(limit)) limit = defaultLimit;
  if (limit < minLimit) limit = minLimit;
  if (limit > maxLimit) limit = maxLimit;

  var skip = Number(req.params.skip);
  if (isNaN(skip)) skip = 0;

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
        if (!player) return Promise.reject("Unable to list third party turns.");
        if (errorOnInvalidGame(game, res, [GameState.Running, GameState.Ended])) return;
        var query = new Query(Turn);
        return query
          .equalTo("game", game)
          .include("player.user")
          .addDescending("createdAt")
          .limit(limit)
          .skip(skip)
          .find();
      }
    ).then(
      function(turns) {
        if (!turns) return Promise.reject("No turns found.");
        res.success({
          turns: turns
        });
      },
      defaultError(res)
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
        if (!contact) return Promise.reject("Contact not found");
        return contact.destroy();
      }
    ).then(
      function() {
        res.success({
          deleted: true
        });
      },
      defaultError(res)
    );
});

Parse.Cloud.define("listFriends", function(req, res) {
  var user = req.user;
  if (errorOnInvalidUser(user, res)) return;

  var contactQuery = new Query(Contact);
  contactQuery
    .equalTo("user", user)
    .include("contact")
    .limit(1000)
    .find()
    .then(
      function(contacts) {
        var users = contacts.map(function(contact) {
          // TODO: filter?
          return contact.get("contact");
        });
        res.success({
          contacts: users
        });
      },
      defaultError(res)
    );

  /* 
  // On demand list of friends, no good
  var playerQuery = new Query(Player);
  playerQuery
    .equalTo("user", user)
    .limit(1000)
    .find()
    .then(
      function(players) {
        var games = players.map(function(player) {
          return player.get("game");
        });

        console.log("games: " + games.length);

        var connectedQuery = new Query(Player);
        return connectedQuery
          .containedIn("game", games)
          .limit(1000)
          .find()
      }
    ).then(
      function(players) {
        
        var usersById = {};
        players.forEach(function(player) {
          var connectedUser = player.get("user");
          if (!usersById[connectedUser.id]) {
            usersById[connectedUser.id] = connectedUser;
          }
        }, this);

        var users = [];
        for (userId in usersById) {
          if (userId == user.id) continue;
          users.push(usersById[userId]);
        }

        res.success(users);
      },
      defaultError(res)
    );
    */
});

function prepareTurn(game, player, previousTurn) {

  if (!previousTurn) previousTurn = null;

  var timeout = game.get("config").get("turnMaxSec");
  if (isNaN(timeout)) {
    return Promise.reject(new Error("Invalid game timeout: " + timeout));
  }

  var pushPromise = notifyPlayers([player], {
    alert: "It's your turn in game '" + game.id + "'!",
    data: {
      game: augmentGameState(game.toJSON()),
      previousTurn: previousTurn
    }
  });


  var jobPromise = addJob("game turn timeout", {
    delay: timeout*1000,
    title: "Turn times out after " + timeout + "s",
    playerId: player.id
  });

  return Promise.when(pushPromise, jobPromise);
}

function gameNextPlayer(game, lastTurn, final) {

  var nextPlayer;

  return (final ? Promise.resolve(null) : findNextPlayer(game)).then(
    function(np) {
      nextPlayer = np;
      game.increment("turn");
      game.set("currentPlayer", nextPlayer);
      if (final) game.set("state", GameState.Ended);

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

      var configPromise = Parse.Object.fetchAllIfNeeded([game.get("config")]);

      return Promise.when(game.save(), turnPromise, configPromise);
    }
  ).then(
    function(g, turn, configResults) {
      if (!final) {
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
          res.error("Game turn invalid, it's not your turn!");
          return;
        }

        var save = String(req.params.state);
        // TODO: validate

        var turn = new Turn();
        turn.set("game", game);
        turn.set("save", save);
        turn.set("player", currentPlayer);
        turn.set("turn", game.get("turn"));

        return Promise.when(turn.save(), gameNextPlayer(game, turn, final));
      }
    ).then(
      function(turn, nextPlayer) {
        
        var promises = [];

        if (final) {
          promises[promises.length] = notifyGame(game, {
            alert: "Game '" + game.id + "' has ended!",
            data: {
              game: augmentGameState(game.toJSON()),
              lastTurn: turn
            }
          })
        }

        return Promise.when(promises);
      }
    ).then(
      function(results) {
        res.success({
          saved: true,
          ended: final
        });
      },
      defaultError(res)
    );
});

// DONE get next player by date
// DONE wrap if no newer player found by getting the oldest player
// TODO check player state (active, not disconnected, etc.)
// DONE make sure that empty results due to player state or otherwise
//      don't put the next player search into a frenzy or loop, add tests?
function findNextPlayer(game) {
  var promise = new Promise();

  var currentPlayer = game.get("currentPlayer");
  if (!currentPlayer) {
    promise.reject("Unable to find next player, no current player");
    return;
  }

  // console.log("Current player created at:\n ", currentPlayer.createdAt);

  function getNextPlayerQuery() {
    var query = new Query(Player);
    query.notEqualTo("objectId", currentPlayer.id);
    query.equalTo("game", game);
    query.equalTo("state", PlayerState.Active);
    query.addAscending("createdAt");
    return query;
  }

  var query;
  
  query = getNextPlayerQuery();
  query.greaterThanOrEqualTo("createdAt", currentPlayer.createdAt);

  query.first().then(
    function(nextPlayer) {
      if (nextPlayer) {
        // console.log("Next newer player created at:\n ", nextPlayer.createdAt);
        promise.resolve(nextPlayer);
      } else {
        query = getNextPlayerQuery();
        query.limit(1);
        return query.first();
      }
    }
  ).then(
    function(nextPlayer) {
      if (nextPlayer) {
        // console.log("Back to oldest player created at:\n ", nextPlayer.createdAt);
        promise.resolve(nextPlayer);
      } else {
        promise.reject("Unable to find next player");
      }
    },
    promise.reject
  );

  return promise;
}






// TODO: add beforeSave validation
// Parse.Cloud.beforeSave(Game, function(req, res) {
//   var game = req.object;
