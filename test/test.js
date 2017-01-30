process.env.SERVER_ROOT = "http://127.0.0.1:5000";
// process.env.SERVER_ROOT = "http://paperback.herokuapp.com";

var appId = "pbserver";
var masterKey = "12345";

var constants = require('../cloud/constants.js');
var GameState = constants.GameState;
var AIDifficulty = constants.AIDifficulty;

var timeoutMultiplier = 1;
var testTimeouts = false;

var should = require('chai').should();
var fs = require('fs');
var rest = require('rest');
var mime = require('rest/interceptor/mime');
var Parse = require('parse/node');
var kue = require('kue');
var jobs = kue.createQueue({
  redis: process.env.REDIS_URL
});
var Promise = Parse.Promise;
var client = rest.wrap(mime);


var urlRoot = process.env.SERVER_ROOT + "/";
var urlParse = urlRoot + "parse/";

var logins = [
  { name: "Alice", user: "alice@example.com", pass: "p" },
  { name: "Bob", user: "bob@example.com", pass: "p" },
  { name: "Carol", user: "carol@example.com", pass: "p" },
  { name: "Dan", user: "dan@example.com", pass: "p" }
];
var tokens = {};


var messageById = {
  "-1": "unspecified, please fix test"
};
for (var messageName in constants.t) {
  var message = constants.t[messageName];
  if (isNaN(message.id)) throw new Error("Invalid message: " + message);
  var inMap = messageById[message.id];
  if (inMap) throw new Error("Message ID for " + messageName + " already in use by " + inMap);
  messageById[message.id] = messageName;
}


function requestLogin(username, password) {    
  return client({
    path: urlParse + "login" +
      "?username=" + encodeURIComponent(username) + 
      "&password=" + encodeURIComponent(password),
    headers: {
      "X-Parse-Application-Id": appId,
      "X-Parse-Master-Key": masterKey
    }
  }).then(function(response) {
    response.should.have.property("entity");
    return Promise.resolve(response.entity);
  });
}

function parseCall(auth, apiName, payload) {

  var headers = {
    "Content-Type": "application/json",
    "X-Parse-Application-Id": appId
  }

  if (typeof(auth) == 'string') {
    var token = tokens[auth];
    if (typeof(token) != "string" || token === "") {
      return Promise.reject(new Error("Token missing for " + auth));
    }
    headers["X-Parse-Session-Token"] = token;
  } else if (auth && typeof(auth) == 'object') {
    if (auth.useMasterKey) {
      headers["X-Parse-Master-Key"] = masterKey;
    }
  }

  if (apiName.indexOf("/") == -1) apiName = "functions/" + apiName;

  return client({
    path: urlParse + apiName,
    headers: headers,
    entity: payload
  }).then(function(response) {
    response.should.have.property("entity");
    return Promise.resolve(response.entity);
  });
}

function parseError(message) {
  return (function(entity) {
    entityError(entity, message);
  });
}


function entityResult(entity, message) {
  if (typeof(entity.error) == 'string') should.not.exist(entity.error);
  if (entity.error) should.not.exist(entity.error.message);
  if (entity.code) should.not.exist(entity.message);
  entity.should.have.property("result");
  if (message) {
    entity.result.code.should.equal(message.id);
  }
  return entity.result;
}

function entityError(entity, message) {
  if (!message.id) throw new Error("Invalid message provided");

  // Cloud Code Error Code
  
  if (entity.result) {
    var unexpected = messageById[entity.result.code];
    should.not.exist(unexpected);
  }

  entity.should.have.property("code");
  entity.code.should.equal(141);

  entity.should.have.property("error");
  
  var error = entity.error;
  error.should.be.an("object");

  error.should.have.property("message");
  error.message.should.be.a("string");
  
  error.should.have.property("code");
  error.code.should.be.a("number");

  var expected = messageById[message.id];
  expected = expected ? expected + " (" + message.id + ")" : message.id;

  var actual = messageById[error.code];
  if (!actual && error.code >= 1999 && error.code < 3000) {
    actual = "ParseError";
    actual = actual + " (2/" + (error.code - 2000) + ")";
  } else {
    actual = actual ? actual + " (" + error.code + ")" : error.code;
  }

  var msg = "Expected " + actual + " to equal " + expected;
  error.code.should.equal(message.id, msg);

  error.should.not.have.property("error");
}

function entityGameId(entity) {
  var result = entityResult(entity);
  result.should.have.property("game");
  var game = result.game;
  game.should.have.property("objectId");
  game.objectId.should.be.a("string");
  return game.objectId;
}

function getUserSessions() {
  var sessionFile = __dirname + "/sessions.json";
  var mainPromise = new Promise();
  fs.readFile(sessionFile, "utf8", function(err, data) {
    var pending = [];
    if (err && err.code == "ENOENT") {
      console.info("Sessions file missing, rebuilding: " + sessionFile);
      pending = logins;
    } else {
      tokens = JSON.parse(data);
      logins.forEach(function(login) {
        if (!tokens[login.name]) pending.push(login);
      }, this);
    }
    
    var promises = [];
    pending.forEach(function(login) {
      promises.push(requestLogin(login.user, login.pass));
    }, this);

    if (promises.length === 0) {
      return mainPromise.resolve();
    } else {
      return Promise.when(promises).then(
        function(results) {
          results.forEach(function(loginResult) {
            var user = loginResult.username;
            var name = logins.find(function(login) {
              return login.user == user;
            }).name;
            tokens[name] = loginResult.sessionToken;
            console.log("Updated session token for " + user);
          }, this);

          fs.writeFile(sessionFile, JSON.stringify(tokens), function(err) {
            if (err) {
              mainPromise.reject(new Error(
                "Unable to update sessions file: " + err
              ));
            } else {
              console.log("Sessions file updated");
              mainPromise.resolve();
            }
          });
        },
        function(error) {
          console.error(error);
          mainPromise.reject(new Error("Unable to login all users"));
        }
      );
    }
    
  });

  return mainPromise;
}

function joinGameCheck(entity) {
  entityResult(entity, constants.t.GAME_JOINED)
    .should.have.deep.property("player.objectId");
}

function resultShouldError(message) {
  if (!message.id) {
    resultShouldError({ id: -1 })(message);
  }
  return (function(entity) {
    entityError(entity, message);
  });
}

function joinGame(name, game, desc, playerFunc) {
  if (!desc) desc = 'has ' + name + ' join game and get player id';
  it(desc, function() {
    return parseCall(name, "joinGame", {
      gameId: game.id
    }).then(
      function(entity) {
        if (playerFunc) playerFunc(entity);
        else joinGameCheck(entity);
      }
    );
  });
}

function leaveGame(name, game, desc, playerFunc) {
  if (!desc) desc = 'has ' + name + ' leave game';
  it(desc, function() {
    return parseCall(name, "leaveGame", {
      gameId: game.id
    }).then(
      function(entity) {
        if (playerFunc) playerFunc(entity);
        else entityResult(entity, constants.t.GAME_LEFT);
      }
    );
  });
}

function internalStartGame(name, game, desc, customFunc, delay) {
  var timeBuffer = 1;
  if (!desc) desc = 'has ' + name + ' start the game';
  it(desc, function() {
    
    var promise = new Promise();

    if (delay === 0) {
      promise.resolve();
    } else {
      var relativeDelay = delay - (game.startTime > 0 ? (Date.now() - game.startTime) : 0);
      if (relativeDelay <= 0) {
        promise.resolve();
      } else {
        this.timeout(2000 + relativeDelay);

        setTimeout(function() {
          promise.resolve();
        }, relativeDelay);
      }
    }

    return promise.then(function() {
      return parseCall(name, "startGame", {
        gameId: game.id
      });
    }).then(
      function(entity) {
        if (customFunc) customFunc(entity);
        else {
          var result = entityResult(entity, constants.t.GAME_STARTED);
          result.should.have.deep.property("player.objectId");
          result.game.state.should.equal(GameState.Running);
        }
      }
    );
  });
}

function waitAndStartGame(name, game, desc, customFunc) {
  if (testTimeouts) internalStartGame(name, game, desc, customFunc, constants.START_GAME_MANUAL_TIMEOUT*1000);
}

function startGame(name, game, desc, customFunc) {
  internalStartGame(name, game, desc, customFunc, 0);
}

function listGames(name, games, desc, testFunc) {
  it(desc, function() {
    var req = {};
    if (games) req.gameIds = games.map(function(game) { return game.id; });
    return parseCall(name, "listGames", req).then(
      function(entity) {
        var result = entityResult(entity, constants.t.GAME_LIST);
        result.should.have.property("games");
        result.games.should.be.an("array");
        testFunc(result.games);
      }
    );
  });
}

function getGame(name, game, desc, testFunc) {
  if (!desc) desc = 'returns the right game status to ' + name;
  listGames(name, [game], desc, function(games) {
    games.should.have.length(1);
    testFunc(games[0]);
  });
}

function makeTurn(name, game, type, turnNumber) {
  var msg;
  switch (type) {
    case "invalid": msg = "get invalid state for"; break;
    default: msg = type;
  }
  it('should ' + msg + ' game turn by ' + name, function() {
    return parseCall(name, "gameTurn", {
      gameId: game.id,
      save: "turn " + turnNumber,
      final: type == "finish"
    }).then(
      function(entity) {
        switch (type) {
          case "allow":
            entityResult(entity, constants.t.TURN_SAVED);
            break;
          
          case "invalid":
            entityError(entity, constants.t.GAME_INVALID_STATE);
            break;

          case "deny":
            entityError(entity, constants.t.TURN_NOT_IT);
            break;

          case "finish":
            var result = entityResult(entity, constants.t.TURN_SAVED);
            result.should.have.property("ended");
            result.ended.should.equal(true);
            break;

          default:
            should.fail(entity, "supported type", "Invalid turn type");
        }
      }
    );
  });
}

function getJob(id) {
  var promise = new Promise();
  kue.Job.get(id, function(err, job) {
    if (err) {
      promise.reject(new Error(err));
      return;
    }
    promise.resolve(job);
  });
  return promise;
}

function checkDeletedJob(id) {
  var promise = new Promise();
  getJob(id).then(
    function(job) {
      promise.reject(new Error(
        "Job was found, but it should've been deleted: " + job.id
      ));
    },
    function(err) {
      promise.resolve();
    }
  )
  return promise;
}


describe('public', function() {
  describe('name check', function() {

    it("should return false for existing name", function() {
      return parseCall(null, "checkNameFree", {
        displayName: "Ally"
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.available.should.equal(false);
        }
      );
    });

    it("should return true for a free name", function() {
      return parseCall(null, "checkNameFree", {
        displayName: "ThisDisplayNameShouldRemainFree"
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.available.should.equal(true);
        }
      );
    });

    it("should error on missing parameter", function() {
      return parseCall(null, "checkNameFree", {}).then(
        parseError(constants.t.INVALID_PARAMETER)
      );
    });

    it("should error on empty name", function() {
      return parseCall(null, "checkNameFree", {
        displayName: ""
      }).then(
        parseError(constants.t.INVALID_PARAMETER)
      );
    });

  });
});


describe('game flow', function() {
  before(getUserSessions);

  describe('two user game', function() {

    var gameByName = {};
    var game = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" }
        ],
        "fameCards": { "The Chinatown Connection": 3 },
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity, constants.t.GAME_CREATED);
          result.game.state.should.equal(GameState.Lobby);

          var config = result.game.config;
          config.slotNum.should.equal(2);
          config.isRandom.should.equal(true);
          config.fameCards.should.have.property("The Chinatown Connection");
          config.fameCards["The Chinatown Connection"].should.equal(3);
          config.turnMaxSec.should.equal(60);
          gameByName.Alice = game.id;
        }
      );
    });

    
    it('gets an invite link with Alice', function() {
      return parseCall("Alice", "getInvite", {
        "gameId": game.id
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_INVITE);
          result.should.have.property("link");
          game.invite = result.link;
          result.should.have.deep.property("invite.objectId");
          result.link.should.equal(constants.INVITE_URL_PREFIX + result.invite.objectId);
        }
      );
    });


    it('gets the same invite link with Alice', function() {
      return parseCall("Alice", "getInvite", {
        "gameId": game.id
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_INVITE);
          result.should.have.property("link");
          result.link.should.equal(game.invite);
        }
      );
    });



    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Lobby);
      game.turn.should.equal(0);
    });

    makeTurn("Alice", game, "invalid");
    makeTurn("Bob",   game, "invalid");
    makeTurn("Carol", game, "invalid");

    joinGame("Alice", game,
      "should fail joining Alice as it's her game",
      resultShouldError(constants.t.PLAYER_ALREADY_IN_GAME)
    );
    
    joinGame("Bob", game);


    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Running);
      game.turn.should.equal(0);
    });

    joinGame("Carol", game,
      "should fail joining Carol as the game is running",
      resultShouldError(constants.t.GAME_INVALID_STATE)
    );

    it('creates another game with Bob', function() {
      return parseCall("Bob", "createGame", {
        "fameCards": { "The Chinatown Connection": 3 },
        "turnMaxSec": 60
      }).then(
        function(entity) {
          gameByName.Bob = entityGameId(entity);
        }
      );
    });


    var turnNumber = 0;

    makeTurn("Bob",   game, "deny",  turnNumber);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Alice", game, "deny",  turnNumber);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "deny",  turnNumber);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "deny",  turnNumber);

    
    it('denies listing of turns by Carol', function() {
      return parseCall("Carol", "listTurns", {
        gameId: game.id,
        limit: 100,
        skip: 0
      }).then(resultShouldError(constants.t.TURN_THIRD_PARTY));
    });

    it('gets the latest turn with Alice', function() {
      return parseCall("Alice", "listTurns", {
        gameId: game.id,
        limit: 1
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turns");
          result.turns.should.have.length(1);
          var turn = result.turns[0];
          turn.turn.should.equal(5);
          turn.save.should.equal("turn 5");
          turn.player.user.displayName.should.equal("Bobzor");
        }
      );
    });

    it('gets two turns in the middle with Alice', function() {
      return parseCall("Alice", "listTurns", {
        gameId: game.id,
        limit: 2,
        skip: 1
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turns");
          result.turns.should.have.length(2);

          var turnAlice = result.turns[0];
          turnAlice.player.user.displayName.should.equal("Ally");
          turnAlice.turn.should.equal(4);

          var turnBob = result.turns[1];
          turnBob.player.user.displayName.should.equal("Bobzor");
          turnBob.turn.should.equal(3);
        }
      );
    });


    it('gets a valid list of all turns with Bob', function() {
      return parseCall("Bob", "listTurns", {
        gameId: game.id,
        limit: 100,
        skip: 0
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turns");
          result.turns.forEach(function(turn) {
            turn.save.should.equal("turn " + turn.turn);
            turn.player.user.displayName.should.equal(
              turn.turn%2 == 0 ? "Ally" : "Bobzor"
            );
          }, this);
        }
      );
    });


    getGame("Bob", game, '', function(game) {
      game.state.should.equal(GameState.Running);
      game.turn.should.equal(6);
    });

    function matchGameId(name, gameNeedle) {
      listGames(
        name,
        null,
        'should return created game id in the list of games to ' + name,
        function(games) {
          games.some(function(game) {
            return game.objectId == gameNeedle.id;
          }).should.equal(true);
        }
      );

      listGames(
        name,
        null,
        'should not return a 3rd party game to ' + name,
        function(games) {
          function gameMatcher(matcher, game) {
            return game.id == ngame;
          }

          for (var gname in gameByName) {
            var ngame = gameByName[gname];
            if (gname != name && ngame != gameNeedle.id) {
              games.some(gameMatcher.bind(this, gname)).should.equal(false);
            }
          }
        }
      );
    }
    
    matchGameId('Alice', game);
    matchGameId('Bob', game);

    makeTurn("Alice", game, "finish", turnNumber++);

    getGame("Bob", game, 'should get the ended game state with one more turn', function(game) {
      game.state.should.equal(GameState.Ended);
      game.turn.should.equal(7);
    });

    makeTurn("Alice", game, "invalid");
    makeTurn("Bob",   game, "invalid");
    makeTurn("Carol", game, "invalid");
    makeTurn("Dan",   game, "invalid");

  });

  describe('turn order with complex slots', function() {

    var game = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "invite", "displayName": "Carry" },
          { "type": "open" },
          { "type": "invite", "displayName": "Bobzor" },
          { "type": "creator" },
        ],
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity, constants.t.GAME_CREATED);
          result.game.state.should.equal(GameState.Lobby);
        }
      );
    });

    joinGame("Bob", game);
    joinGame("Dan", game);
    joinGame("Carol", game);
    
    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Running);
      game.turn.should.equal(0);
    });

    var turnNumber = 0;

    makeTurn("Alice", game, "deny",  turnNumber);
    makeTurn("Bob",   game, "deny",  turnNumber);
    makeTurn("Dan",   game, "deny",  turnNumber);
    makeTurn("Carol", game, "allow", turnNumber++);
    makeTurn("Alice", game, "deny",  turnNumber);
    makeTurn("Bob",   game, "deny",  turnNumber);
    makeTurn("Carol", game, "deny",  turnNumber);
    makeTurn("Dan",   game, "allow", turnNumber++);
    makeTurn("Alice", game, "deny",  turnNumber);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "deny",  turnNumber);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Carol", game, "allow", turnNumber++);
    makeTurn("Dan",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Carol", game, "allow", turnNumber++);
    makeTurn("Dan",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Carol", game, "allow", turnNumber++);
    makeTurn("Dan",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);

    getGame("Dan", game, '', function(game) {
      game.state.should.equal(GameState.Running);
      game.turn.should.equal(16);
    });
    
    makeTurn("Carol", game, "finish", turnNumber++);

    getGame("Bob", game, 'should get the ended game state with one more turn', function(game) {
      game.state.should.equal(GameState.Ended);
      game.turn.should.equal(17);
    });

    makeTurn("Alice", game, "invalid");
    makeTurn("Bob",   game, "invalid");
    makeTurn("Carol", game, "invalid");
    makeTurn("Dan",   game, "invalid");

  });

  describe('find games', function() {

    var gameInfos = [];
    var gameToJoin = {};
    var gameNum = 7;

    function purgeRandom() {
      it('should remove random games first', function() {
        return parseCall({ useMasterKey: true }, "purgeRandomGames",
          {}
        ).then(
          function(result) {
            result.should.have.property("result");
            should.equal(result.result.purged, true);
          }
        );
      });
    }

    purgeRandom();

    it('finds no games with Bob after all of them are removed', function() {
      return parseCall("Bob", "findGames", {
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          result.should.have.property("games");
          result.games.should.have.length(0);
        }
      );
    });

    function createRandomGame(gameInfos) {
      return parseCall("Alice", "createGame", {
        "fameCards": { "The Chinatown Connection": 3 },
        "turnMaxSec": 60
      }).then(
        function(entity) {
          var gameInfo = entityResult(entity, constants.t.GAME_CREATED);
          gameInfo.should.have.property("game");
          gameInfos.push(gameInfo);
        }
      );
    }
    
    for (var gameIndex = 0; gameIndex < gameNum; gameIndex++) {
      it('should make Alice create random game #' + (gameIndex + 1) + ' and get the result', createRandomGame.bind(null, gameInfos));
    }

    it('finds random games with Bob that match the above', function() {
      return parseCall("Bob", "findGames", {
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          should.not.exist(result.playerCount);
          result.should.have.property("games");
          var games = result.games;
          games.should.have.length(gameNum);
          for (var gameIndex = 0; gameIndex < gameNum; gameIndex++) {
            var game = games[gameIndex];
            should.exist(game);
            game.should.have.property("objectId");
            game.objectId.should.equal(gameInfos[gameIndex].game.objectId);
            game.joined.should.equal(false);
          }
        }
      );
    });

    it('finds the first three games with Bob', function() {
      return parseCall("Bob", "findGames", {
        "limit": 3
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          should.not.exist(result.playerCount);
          result.should.have.property("games");
          var games = result.games;
          games.should.have.length(3);
          for (var gameIndex = 0; gameIndex < 3; gameIndex++) {
            games.should.have.property(gameIndex);
            var game = games[gameIndex];
            game.should.have.property("objectId");
            game.objectId.should.equal(gameInfos[gameIndex].game.objectId);
          }
        }
      );
    });

    it('finds the next three games with Bob', function() {
      return parseCall("Bob", "findGames", {
        "limit": 3,
        "skip": 3
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          should.not.exist(result.playerCount);
          result.should.have.property("games");
          var games = result.games;
          games.should.have.length(3);
          for (var gameIndex = 0; gameIndex < 3; gameIndex++) {
            games.should.have.property(gameIndex);
            var game = games[gameIndex];
            game.should.have.property("objectId");
            game.objectId.should.equal(gameInfos[3 + gameIndex].game.objectId);
          }
        }
      );
    });

    
    it('finds the one random game to join with Bob', function() {
      return parseCall("Bob", "findGames", {
        "limit": 1,
        "skip": 1,
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          should.not.exist(result.playerCount);
          result.should.have.property("games");
          var games = result.games;
          games.should.have.length(1);
          var game = games[0];
          should.exist(game);
          game.should.have.property("objectId");
          game.objectId.should.equal(gameInfos[1].game.objectId);
          game.joined.should.equal(false);
          gameToJoin.id = game.objectId;
        }
      );
    });

    joinGame("Bob", gameToJoin, "should try joining the found game with Bob");
    joinGame("Bob", gameToJoin,
      "should not be able to join twice",
      resultShouldError(constants.t.PLAYER_ALREADY_IN_GAME)
    );

    it('verified joined status for three games', function() {
      return parseCall("Bob", "findGames", {
        "limit": 3,
        "skip": 0
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          var games = result.games;
          for (var gameIndex = 0; gameIndex < 3; gameIndex++) {
            var game = games[gameIndex];
            game.joined.should.equal(gameIndex == 1);
          }
        }
      );
    });

    describe('free slots', function() {

      function createGameSlotsCheck(entity) {
        var gameInfo = entityResult(entity, constants.t.GAME_CREATED);
        gameInfo.game.config.should.have.property("slots");
        game.id = gameInfo.game.objectId;
      }
      function createGameSlots(game, slots, desc, resultFunc) {
        if (!desc) desc = "create game with " + slots.length + " slots";
        it(desc, function() {
          return parseCall("Alice", "createGame", {
            "slots": slots
          }).then(
            function(entity) {
              if (resultFunc) resultFunc(entity);
              else createGameSlotsCheck(entity);
            }
          );
        });
      }

      function checkFreeSlots(game, desc, slotNum) {
        it("should equal " + slotNum + " for " + desc, function() {
          return parseCall("Alice", "findGames", {}).then(
            function(entity) {
              var result = entityResult(entity, constants.t.GAME_LIST);
              result.should.have.property("games");
              if (slotNum == -1) {
                result.games.length.should.equal(0);
              } else {
                result.games.length.should.equal(1);
                result.games[0].freeSlots.should.equal(slotNum);
              }
            }
          );
        });
      }

      var game = {};
      function testGameSlots(desc, slotNum, slots) {
        purgeRandom();
        createGameSlots(game, desc, slots);
        checkFreeSlots(game, slotNum);
      }
      
      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "none" },
        { type: "none" },
        { type: "none" }
      ]);
      checkFreeSlots(game, 'game with no open slots', -1);
      
      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "open" },
        { type: "none" },
        { type: "none" }
      ]);
      checkFreeSlots(game, 'game with one open slot', 1);

      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "open" },
        { type: "open" },
        { type: "none" }
      ]);
      checkFreeSlots(game, 'game with two open slots', 2);

      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "open" },
        { type: "invite", displayName: "Bobzor" },
        { type: "none" }
      ]);
      checkFreeSlots(game, 'game with one open slot and one invite slot', 1);
      
      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "open" },
        { type: "open" },
        { type: "open" }
      ]);
      joinGame("Bob", game);
      checkFreeSlots(game, 'game with three open slots, one filled', 2);
      
      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "open" },
        { type: "invite", displayName: "Bobzor" },
        { type: "open" }
      ]);
      joinGame("Bob", game);
      joinGame("Carol", game);
      checkFreeSlots(game, 'game with one invite, two open slots, one filled', 1);
      
      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "open" },
        { type: "invite", displayName: "Bobzor" },
        { type: "invite", displayName: "Carry" },
      ]);
      joinGame("Bob", game);
      joinGame("Carol", game);
      checkFreeSlots(game, 'game with two invites, one open', 1);
      
      purgeRandom();
      createGameSlots(game, [
        { type: "creator" },
        { type: "invite", displayName: "Bobzor" },
        { type: "invite", displayName: "Bobzor" },
        { type: "open" }
      ], "duplicate invites should error", resultShouldError(constants.t.GAME_INVALID_CONFIG));

    });


  });


  describe("start game", function() {

    var game = {};
    var nonstarterGame = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" },
          { "type": "open" }
        ],
        "fameCards": { "The Chinatown Connection": 3 },
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          game.startTime = Date.now();
        }
      );
    });

    it('creates a game and gets the game id with Bob', function() {
      return parseCall("Bob", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" },
          { "type": "open" }
        ],
        "fameCards": { "The Chinatown Connection": 3 },
        "turnMaxSec": 60
      }).then(
        function(entity) {
          nonstarterGame.id = entityGameId(entity);
          nonstarterGame.startTime = Date.now();
        }
      );
    });

    joinGame("Bob", game);
    
    startGame("Alice", game,
      'should not allow Alice to start the game already',
      resultShouldError(constants.t.GAME_NOT_STARTABLE)
    );

    startGame("Bob", game,
      'should not allow Bob to start the Alice game',
      resultShouldError(constants.t.GAME_THIRD_PARTY)
    );

    startGame("Bob", nonstarterGame,
      'should not allow Bob to start his game already',
      resultShouldError(constants.t.GAME_NOT_STARTABLE)
    );
    
    waitAndStartGame("Bob", nonstarterGame,
      'should not allow Bob to start a game with just himself',
      resultShouldError(constants.t.GAME_INSUFFICIENT_PLAYERS)
    );
    
    waitAndStartGame("Bob", game,
      'should not allow a non-creator to start the game',
      resultShouldError(constants.t.GAME_THIRD_PARTY)
    );

    waitAndStartGame("Alice", game,
      'should allow Alice to start the game after the timeout'
    );
    
    waitAndStartGame("Bob", game,
      'should not allow Bob to start the game after Alice',
      resultShouldError(constants.t.GAME_THIRD_PARTY)
    );

    waitAndStartGame("Alice", game,
      'should not allow Alice to start the game twice',
      resultShouldError(constants.t.GAME_NOT_STARTABLE)
    );
    
  });



  describe("leave game", function() {

    var game = {};
    
    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" },
          { "type": "open" }
        ],
        "fameCards": { "The Chinatown Connection": 3 },
        "turnMaxSec": 7
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
        }
      );
    });

    leaveGame("Bob", game,
      "should not allow Bob to leave a game he's not in",
      resultShouldError(constants.t.PLAYER_NOT_IN_GAME)
    );

    joinGame("Bob", game);
    joinGame("Carol", game);

    var turnNumber = 0;

    makeTurn("Bob",   game, "deny", turnNumber);
    makeTurn("Carol", game, "deny", turnNumber);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Alice", game, "deny", turnNumber);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "deny", turnNumber);
    makeTurn("Carol", game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Carol", game, "allow", turnNumber++);
    

    listGames("Alice", [game],
      "should return the game in the list of active games for Alice",
      function(games) {
        games.should.have.length(1);
        game.id.should.equal(games[0].objectId);
      }
    );


    leaveGame("Alice", game);

    listGames("Alice", [game],
      "should remove the game from the list of active games for Alice",
      function(games) {
        games.should.have.length(0);
      }
    );


    leaveGame("Alice", game,
      "should not allow Alice to leave the game twice",
      resultShouldError(constants.t.PLAYER_NOT_IN_GAME)
    );

    makeTurn("Alice", game, "deny", turnNumber);
    makeTurn("Carol", game, "deny", turnNumber);
    makeTurn("Bob",   game, "allow", turnNumber++);

    joinGame("Alice", game,
      "should not allow Alice to rejoin",
      resultShouldError(constants.t.GAME_INVALID_STATE)
    );
    leaveGame("Bob", game);
    leaveGame("Bob", game,
      "should not allow Bob to leave the game twice",
      resultShouldError(constants.t.PLAYER_NOT_IN_GAME)
    );
    joinGame("Bob", game,
      "should not allow Bob to rejoin",
      resultShouldError(constants.t.GAME_INVALID_STATE)
    );

    it("should keep the game alive with one player left", function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.state.should.equal(GameState.Running);
        }
      );
    });

    leaveGame("Carol", game);

    it("should end the game after the last player leaves", function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.state.should.equal(GameState.Ended);
        }
      );
    });

  });

});

describe("contacts", function() {
  before(getUserSessions);

  describe("mutual addition", function() {
    it("should remove contacts first", function() {
      return parseCall({ useMasterKey: true }, "purgeContacts", {}).then(
        function(result) {
          result.should.have.property("result");
          should.equal(result.result.purged, true);
        }
      );
    });

    function contactCheck(name, desc, include, exclude, done) {
      var nobody = !include && !exclude;
      if (!desc) {
        desc = nobody ?
          'returns nobody for ' + name :
          'returns ' + 
            include.join(" and ") +
            ' and not ' + exclude.join(" and ") +
            ' as friends of ' + name;
      }
      it(desc, function() {
        return parseCall(name, "listFriends", {
        }).then(
          function(entity) {
            var result = entityResult(entity, constants.t.CONTACT_LIST);
            result.should.have.property("contacts");
            var contacts = result.contacts;
            if (nobody) {
              contacts.should.have.length(0);
            } else {

              include.forEach(function(contactName) {
                should.exist(contacts.find(function(contact) {
                  return contact.displayName == contactName;
                }));
              }, this);

              exclude.forEach(function(contactName) {
                should.not.exist(contacts.find(function(contact) {
                  return contact.displayName == contactName;
                }));
              }, this);
              
            }

            if (done) done(contacts);
          }
        );
      });
    }

    contactCheck("Alice");
    contactCheck("Bob");
    contactCheck("Carol");
    contactCheck("Dan");

    var game = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 4,
        "isRandom": true,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
        }
      );
    });

    joinGame("Bob", game, 'has Bob join game');
    joinGame("Carol", game, 'has Carol join game');

    var bobId;
    contactCheck("Carol", null, ["Ally", "Bobzor"], ["Carry", "Dan the Man"], function(contacts) {
      bobId = contacts.find(function(contact) { return contact.displayName == "Bobzor"; }).objectId;
    });

    contactCheck("Bob", null, ["Ally", "Carry"], ["Bobzor", "Dan the Man"]);
    contactCheck("Alice", null, ["Bobzor", "Carry"], ["Ally", "Dan the Man"]);

    contactCheck("Dan", "still returns nobody for Dan :(");

    it('makes Carol delete Bob as friend', function() {
      return parseCall("Carol", "deleteFriend", {
        userId: bobId
      }).then(
        function(entity) {
          entityResult(entity, constants.t.CONTACT_DELETED);
        }
      );
    });
    
    contactCheck("Carol", "should make sure Carry hates Bob now", ["Ally"], ["Bobzor", "Carry", "Dan the Man"]);

  });
});


describe("kue", function() {
  before(getUserSessions);

  
  if (testTimeouts) describe("lobby timeout job", function() {

    var game = {};

    if (testTimeouts) it('creates a game and waits for timeout with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" }
        ],
        "fameCards": {},
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity);
        }
      );
    });
    
    it('should end the game after timeout', function() {
      
      var promise = new Promise();

      setTimeout(function() {
       promise.resolve();
      }, constants.START_GAME_AUTO_TIMEOUT*1000 + 1000);

      this.timeout(constants.START_GAME_AUTO_TIMEOUT*1000 + 2000);

      return promise.then(
        function() {
          return parseCall("Alice", "listGames", {
            gameIds: [game.id]  
          })
        }
      ).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_LIST);
          result.should.have.property("games");
          result.games.should.be.an("array");
          result.games.should.have.length(1);

          var game = result.games[0];
          game.state.should.equal(GameState.Ended);
          return Promise.resolve();
        }
      );
    })

  });

  
  describe("lobby timeout skipped job", function() {

    var game = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" }
        ],
        "fameCards": {},
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity);
        }
      );
    });
    joinGame("Bob", game);

    it("should get deleted after game starts", function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          return checkDeletedJob(result.lobbyTimeoutJob);
        }
      );
    });
  });

  describe("turn timeout job", function() {

    var turnMaxSec = 1*timeoutMultiplier;
    var game = {};

    it('creating a game with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" }
        ],
        "turnMaxSec": turnMaxSec
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity);
        }
      );
    });
    joinGame("Bob", game);

    it('sets job id in game', function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turnTimeoutJob");
          game.turnTimeoutJob = result.turnTimeoutJob; 
        }
      );
    });
    
    it('should be running', function() {
      return getJob(game.turnTimeoutJob).then(
        function(job) {
          job.id.should.equal(game.turnTimeoutJob);
        }
      );
    });

    var turnNumber = 0;
    makeTurn("Alice", game, "allow", turnNumber++);
    
    it("should get deleted after a turn is made", function() {
      return checkDeletedJob(game.turnTimeoutJob);
    });

    it('sets new job id in game', function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turnTimeoutJob");
          result.turnTimeoutJob.should.not.equal(game.turnTimeoutJob);
          game.turnTimeoutJob = result.turnTimeoutJob; 
        }
      );
    });

    makeTurn("Alice", game, "deny", turnNumber);
    
    if (testTimeouts) {
      it("should advance to the next player after timeout", function() {
        var promise = new Promise();
        setTimeout(function() {
          promise.resolve();
        }, turnMaxSec*1000 + 1000);
        this.timeout(turnMaxSec*1000 + 2000);

        return promise.then(
          function() {
            return parseCall({ useMasterKey: true }, "debugGame", {
              gameId: game.id
            });
          }
        ).then(
          function(entity) {
            var result = entityResult(entity);
            result.should.have.property("turnTimeoutJob");
            result.turnTimeoutJob.should.not.equal(game.turnTimeoutJob);
            game.turnTimeoutJob = result.turnTimeoutJob;
          }
        )
      });
      makeTurn("Bob", game, "deny", turnNumber);
      makeTurn("Alice", game, "allow", turnNumber++);
    }

    makeTurn("Bob", game, "finish", turnNumber++);

    if (testTimeouts) it('should be different after a few turns', function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turnTimeoutJob");
          result.turnTimeoutJob.should.not.equal(game.turnTimeoutJob);
          game.turnTimeoutJob = result.turnTimeoutJob;
        }
      );
    });

    it('should not exist after end of game', function() {
      return checkDeletedJob(game.turnTimeoutJob);
    });

  });

  
  if (testTimeouts) describe("game ending turn timeout job", function() {

    var slots = [
      { "type": "creator" },
      { "type": "open" }
    ];
    var turnMaxSec = 1*timeoutMultiplier;
    var game = {};

    it('creating a game with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slots": [
          { "type": "creator" },
          { "type": "open" }
        ],
        "turnMaxSec": turnMaxSec
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity);
        }
      );
    });
    joinGame("Bob", game);

    it('should be running', function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turnTimeoutJob");
          game.turnTimeoutJob = result.turnTimeoutJob;
          return getJob(game.turnTimeoutJob); 
        }
      ).then(
        function(job) {
          job.id.should.equal(game.turnTimeoutJob);
        }
      );
    });
    
    var turnNumber = 0;
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob", game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob", game, "allow", turnNumber++);

    it('should still be running', function() {
      return parseCall({ useMasterKey: true }, "debugGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("turnTimeoutJob");
          game.turnTimeoutJob = result.turnTimeoutJob;
          return getJob(game.turnTimeoutJob); 
        }
      ).then(
        function(job) {
          job.id.should.equal(game.turnTimeoutJob);
        }
      );
    });

    it("should end the game after " + constants.GAME_ENDING_INACTIVE_ROUNDS + " inactive rounds", function() {
      var waitMs = (turnMaxSec + 1)*slots.length*constants.GAME_ENDING_INACTIVE_ROUNDS*1000;
      var promise = new Promise();
      setTimeout(function() {
        promise.resolve();
      }, waitMs + 1000);
      this.timeout(waitMs + 2000);

      return promise.then(
        function() {
          return parseCall({ useMasterKey: true }, "debugGame", {
            gameId: game.id
          });
        }
      ).then(
        function(entity) {
          var result = entityResult(entity);
          result.state.should.equal(GameState.Ended);
        }
      )
    });

  });

});

describe("cleanup", function() {
  before(getUserSessions);

  describe("game", function() {

    var game = {};

    it('gets created with Alice', function() {
      return parseCall("Alice", "createGame", {
        slots: [
          { type: "creator" },
          { type: "open" }
        ]
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          game.result = entityResult(entity);
        }
      );
    });
    
    it('provides invite link to Alice', function() {
      return parseCall("Alice", "getInvite", {
        "gameId": game.id
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.GAME_INVITE);
          game.invite = result.invite;
        }
      );
    });

    joinGame("Bob", game);

    var turnNumber = 0;
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob", game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob", game, "allow", turnNumber++);
    
    it('provides turn list', function() {
      return parseCall("Alice", "listTurns", {
        gameId: game.id,
        limit: 10,
        skip: 0
      }).then(
        function(entity) {
          var result = entityResult(entity, constants.t.TURN_LIST);
          game.turns = result.turns;
        }
      );
    });

    it('exists', function() {
      return parseCall({ useMasterKey: true }, "classes/Game/" + game.id).then(
        function(retGame) {
          retGame.objectId.should.equal(game.id);
          game.jobs = [
            retGame.turnTimeoutJob
          ];
          if (game.result.state == GameState.Lobby) {
            game.jobs.push(retGame.lobbyTimeoutJob);
          }
        }
      );
    });

    it('jobs exist', function() {
      return Promise.when(game.jobs.map(
        function(jobId) {
          return getJob(jobId);
        }
      )).then(
        function(retJobs) {
          for (var jobIndex in retJobs) {
            var jobId = game.jobs[jobIndex];
            var retJob = retJobs[jobIndex];
            retJob.id.should.equal(jobId);
          }
        }
      );
    });
    
    it('turns exist', function() {
      return Promise.when(game.turns.map(
        function(turn) {
          return parseCall({ useMasterKey: true }, "classes/Turn/" + turn.objectId);
        }
      )).then(
        function(retTurns) {
          for (var turnIndex in retTurns) {
            var turn = game.turns[turnIndex];
            var retTurn = retTurns[turnIndex];
            retTurn.objectId.should.equal(turn.objectId);
          }
        }
      );
    });
    
    it('invite exists', function() {
      return parseCall({ useMasterKey: true }, "classes/Invite/" + game.invite.objectId).then(
        function(retInvite) {
          retInvite.objectId.should.equal(game.invite.objectId);
        }
      );
    });





    it("gets destroyed", function() {
      return parseCall({ useMasterKey: true }, "destroyGame", {
        gameId: game.id
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.destroyed.should.equal(true);
        }
      );
    });




    
    it('does not exist anymore', function() {
      return parseCall({ useMasterKey: true }, "classes/Game/" + game.id).then(
        function(result) {
          if (result && result.code == Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve();
          }
          return Promise.reject(new Error("it exists"));
        }
      );
    });

    it('jobs do not exist anymore', function() {
      return Promise.when(game.jobs.map(
        function(jobId) {
          return getJob(jobId);
        }
      )).then(
        function(retJobs) {
          return Promise.reject(new Error("they exist"));
        },
        function() {
          return Promise.resolve();
        }
      );
    });

    it('turns do not exist anymore', function() {
      this.timeout(20000);
      return Promise.when(game.turns.map(
        function(turn) {
          return parseCall({ useMasterKey: true }, "classes/Turn/" + turn.objectId);
        }
      )).then(
        function(results) {
          if (results) {
            var everyNotFound = results.every(function(result) {
              return result.code == Parse.Error.OBJECT_NOT_FOUND;
            });
            if (everyNotFound) {
              return Promise.resolve();
            }
          }
          return Promise.reject(new Error("they exist"));
        }
      );
    });
    
    it('invite does not exist anymore', function() {
      return parseCall({ useMasterKey: true }, "classes/Invite/" + game.invite.objectId).then(
        function(result) {
          if (result && result.code == Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve();
          }
          return Promise.reject(new Error("it exists"));
        }
      );
    });

  });

});


describe("access security", function() {
  before(getUserSessions);
  
  function checkAccess(desc, apiName) {
    apiName = "/" + apiName;
    it(desc + " (" + apiName + ")", function() {
      return parseCall(null, apiName).then(
        function(result) {
          result.should.not.have.property("results");
          result.should.have.property("code");
          result.code.should.equal(119);
        }
      );
    });
  }

  describe("user access", function() {

    checkAccess("should not return list of users", "users");
    checkAccess("should not return specific user", "users/etSAhagpLp");

    it("should return Alice", function() {
      return parseCall("Alice", "/users/me").then(
        function(result) {
          result.should.have.property("objectId");
          result.should.have.property("displayName");
          result.displayName.should.equal("Ally");
        }
      );
    });

  });

  function checkClassAccess(className) {
    checkAccess("should not return list of " + className + "s", "classes/" + className);
  }

  describe("class access", function() {
    
    checkClassAccess("_Installation");
    checkClassAccess("_User");
    checkClassAccess("Session");
    checkClassAccess("Game");
    checkClassAccess("Config");
    checkClassAccess("Invite");
    checkClassAccess("Player");
    checkClassAccess("Turn");

  });


});