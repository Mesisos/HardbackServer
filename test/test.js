process.env.SERVER_ROOT = "http://127.0.0.1:5000";
// process.env.SERVER_ROOT = "http://paperback.herokuapp.com";

var constants = require('../cloud/constants.js');
var GameState = constants.GameState;
var AIDifficulty = constants.AIDifficulty;

var should = require('chai').should();
var fs = require('fs');
var rest = require('rest');
var mime = require('rest/interceptor/mime');
var Parse = require('parse/node');
var kue = require('kue');
var Promise = Parse.Promise;
var client = rest.wrap(mime);
var jobs = kue.createQueue();

var urlRoot = process.env.SERVER_ROOT + "/";
var urlParse = urlRoot + "parse/";
var appId = "pbserver";
var masterKey = "12345";

var logins = [
  { user: "Alice", pass: "p" },
  { user: "Bob", pass: "p" },
  { user: "Carol", pass: "p" },
  { user: "Dan", pass: "p" }
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

function parseCall(auth, funcname, payload) {

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

  return client({
    path: urlParse + "functions/" + funcname,
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
        if (!tokens[login.user]) pending.push(login);
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
            tokens[user] = loginResult.sessionToken;
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
      this.timeout(2000 + relativeDelay);

      setTimeout(function() {
        promise.resolve();
      }, relativeDelay);
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
  internalStartGame(name, game, desc, customFunc, constants.START_GAME_MANUAL_TIMEOUT*1000);
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
      state: "turn " + turnNumber,
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
        "slotNum": 2,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity, constants.t.GAME_CREATED);
          result.game.state.should.equal(GameState.Lobby);

          var config = result.game.config;
          config.slotNum.should.equal(2);
          config.isRandom.should.equal(false);
          config.fameCards.should.have.property("The Chinatown Connection");
          config.fameCards["The Chinatown Connection"].should.equal(3);
          config.aiDifficulty.should.equal(0);
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
        "slotNum": 4,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
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

  describe('find games', function() {

    var gameInfos = [];
    var gameToJoin = {};
    var gameNum = 7;

    it('should remove random games first', function() {
      return client({
        path: urlRoot + "purgeRandomGames",
        headers: {
          "Content-Type": "application/json",
          "X-Parse-Application-Id": appId,
          "X-Parse-Master-Key": masterKey
        }
      });
    });

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
        "slotNum": 3,
        "isRandom": true,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
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
      it('should make Alice create random game #' + gameIndex + ' and get the result', createRandomGame.bind(null, gameInfos));
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
          gameToJoin.id = game.objectId;
        }
      );
    });

    joinGame("Bob", gameToJoin, "should try joining the found game with Bob");
    joinGame("Bob", gameToJoin,
      "should not be able to join twice",
      resultShouldError(constants.t.PLAYER_ALREADY_IN_GAME)
    );

  });


  describe("start game", function() {

    var game = {};
    var nonstarterGame = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 3,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
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
        "slotNum": 2,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
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
        "slotNum": 3,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiDifficulty": AIDifficulty.None,
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
      return client({
        path: urlRoot + "purgeContacts",
        headers: {
          "Content-Type": "application/json",
          "X-Parse-Application-Id": appId,
          "X-Parse-Master-Key": masterKey
        }
      });
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

  
  describe("lobby timeout job", function() {

    var game = {};

    it('creates a game and waits for timeout with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 2,
        "isRandom": false,
        "fameCards": {},
        "aiDifficulty": AIDifficulty.None,
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
        "slotNum": 2,
        "isRandom": false,
        "fameCards": {},
        "aiDifficulty": AIDifficulty.None,
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

    var turnMaxSec = 1;
    var game = {};

    it('creating a game with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 2,
        "isRandom": false,
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
    makeTurn("Bob", game, "finish", turnNumber++);

    it('should be different after a few turns', function() {
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

  
  describe("game ending turn timeout job", function() {

    var slotNum = 2;
    var turnMaxSec = 1;
    var game = {};

    it('creating a game with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": slotNum,
        "isRandom": false,
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
      var waitMs = (turnMaxSec + 1)*slotNum*constants.GAME_ENDING_INACTIVE_ROUNDS*1000;
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