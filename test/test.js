var should = require('chai').should();
var fs = require('fs');
var rest = require('rest');
var mime = require('rest/interceptor/mime');
var Parse = require('parse/node');
var Promise = Parse.Promise;
var client = rest.wrap(mime);

var urlRoot = "http://localhost:5000/";
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

var GameState = {
  Init: 0,
  Lobby: 1,
  Running: 2,
  Ended: 3,
};

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

function parseCall(username, funcname, payload) {
  var token = tokens[username];
  // console.log(username, funcname, token, payload);
  if (typeof(token) != "string" || token === "") {
    return Promise.reject(new Error("Token missing for " + username));
  }
  return client({
    path: urlParse + "functions/" + funcname,
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": appId,
      "X-Parse-Session-Token": token
    },
    entity: payload
  }).then(function(response) {
    response.should.have.property("entity");
    return Promise.resolve(response.entity);
  });
}

function entityResult(entity) {
  if (entity.error) should.not.exist(entity.error.message);
  entity.should.have.property("result");
  return entity.result;
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
              mainPromise.reject("Unable to update sessions file: " + err);
            } else {
              console.log("Sessions file updated");
              mainPromise.resolve();
            }
          });
        },
        function(error) {
          console.error(error);
          mainPromise.reject("Unable to login all users");
        }
      );
    }
    
  });

  return mainPromise;
}

function joinGameCheck(entity) {
  entity.should.have.deep.property("result.player.objectId");
}

function resultShouldError(result) {
  result.should.have.deep.property("error");
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

function listGames(name, games, desc, testFunc) {
  it(desc, function() {
    var req = {};
    if (games) req.gameIds = games.map(function(game) { return game.id; });
    return parseCall(name, "listGames", req).then(
      function(entity) {
        var result = entityResult(entity);
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
  it('should ' + type + ' game turn by ' + name, function() {
    return parseCall(name, "gameTurn", {
      gameId: game.id,
      state: "turn " + turnNumber,
      final: type == "finish"
    }).then(
      function(entity) {
        switch (type) {
          case "allow":
            entity.should.have.deep.property("result.saved");
            entity.result.saved.should.equal(true);
            break;
          
          case "deny":
            entity.should.have.property("code");
            entity.code.should.equal(141);
            break;

          case "finish":
            var result = entityResult(entity);
            result.should.have.property("saved");
            result.saved.should.equal(true);
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


describe('game flow', function() {
  before(getUserSessions);

  describe('two user game', function() {
    // this.timeout(4000);



    var gameByName = {};
    var game = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 3,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiNum": 1,
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
          var result = entityResult(entity);
          var config = result.game.config;
          config.slotNum.should.equal(3);
          config.isRandom.should.equal(false);
          config.fameCards.should.have.property("The Chinatown Connection");
          config.fameCards["The Chinatown Connection"].should.equal(3);
          config.aiNum.should.equal(1);
          config.turnMaxSec.should.equal(60);
          gameByName.Alice = game.id;
        }
      );
    });


    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Lobby);
      game.turn.should.equal(0);
    });

    makeTurn("Alice", game, "deny");
    makeTurn("Bob",   game, "deny");
    makeTurn("Carol", game, "deny");

    joinGame("Alice", game, "should fail joining Alice as it's her game", resultShouldError);
    joinGame("Bob", game);

    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Running);
      game.turn.should.equal(0);
    });

    joinGame("Carol", game, "should fail joining Carol as the game is running", resultShouldError);

    it('creates another game with Bob', function() {
      return parseCall("Bob", "createGame", {
        "slotNum": 4,
        "isRandom": false,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiNum": 0,
        "turnMaxSec": 60
      }).then(
        function(entity) {
          gameByName.Bob = entityGameId(entity);
        }
      );
    });

    var turnNumber = 0;

    makeTurn("Bob",   game, "deny",  turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Alice", game, "deny",  turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "deny",  turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Alice", game, "allow", turnNumber++);
    makeTurn("Bob",   game, "allow", turnNumber++);
    makeTurn("Bob",   game, "deny",  turnNumber++);

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

    makeTurn("Alice", game, "deny");
    makeTurn("Bob",   game, "deny");
    makeTurn("Carol", game, "deny");
    makeTurn("Dan",   game, "deny");

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
          var result = entityResult(entity);
          result.should.have.property("games");
          result.games.should.have.length(0);
        }
      );
    });
    
    for (var gameIndex = 0; gameIndex < gameNum; gameIndex++) {
      it('should make Alice create random game #' + gameIndex + ' and get the result', function() {
        return parseCall("Alice", "createGame", {
          "slotNum": 3,
          "isRandom": true,
          "fameCards": { "The Chinatown Connection": 3 },
          "aiNum": 0,
          "turnMaxSec": 60
        }).then(
          function(entity) {
            var gameInfo = entityResult(entity);
            gameInfo.should.have.property("game");
            gameInfos.push(gameInfo);
          }
        );
      });
    }

    it('finds random games with Bob that match the above', function() {
      return parseCall("Bob", "findGames", {
      }).then(
        function(entity) {
          var result = entityResult(entity);
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
          var result = entityResult(entity);
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
          var result = entityResult(entity);
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
          var result = entityResult(entity);
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
    joinGame("Bob", gameToJoin, "should not be able to join twice", resultShouldError);

  });

  describe('request game', function() {

    var game = {};

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

    it('should create a random game and get the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 3,
        "isRandom": true,
        "fameCards": { "The Chinatown Connection": 3 },
        "aiNum": 0,
        "turnMaxSec": 60
      }).then(
        function(entity) {
          game.id = entityGameId(entity);
        }
      );
    });

    
    it('requests a random game with Bob', function() {
      return parseCall("Bob", "requestGame", {
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.playerCount.should.equal(2);
          result.should.have.property("game");
          var randomGame = result.game;
          randomGame.config.isRandom.should.equal(true);
          randomGame.state.should.equal(GameState.Lobby);
          randomGame.objectId.should.equal(game.id);
        }
      );
    });

    joinGame("Bob", game, "should auto-join Bob into the game", resultShouldError);

    it('starts the game by requesting a random game with Carol', function() {
      return parseCall("Carol", "requestGame", {
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.playerCount.should.equal(3);
          result.should.have.property("game");
          var randomGame = result.game;
          randomGame.config.isRandom.should.equal(true);
          randomGame.state.should.equal(GameState.Running);
          randomGame.objectId.should.equal(game.id);
        }
      );
    });

    joinGame("Carol", game, "should auto-join Carol into the game", resultShouldError);

    it('creates a new game by requesting a random game with Dan', function() {
      return parseCall("Dan", "requestGame", {
      }).then(
        function(entity) {
          var result = entityResult(entity);
          result.should.have.property("playerCount");
          result.playerCount.should.equal(1);
          result.should.have.deep.property("player.user.username");
          result.player.user.username.should.equal("Dan");

          result.should.have.property("game");
          var randomGame = result.game;
          randomGame.config.isRandom.should.equal(true);
          randomGame.state.should.equal(GameState.Lobby);
          randomGame.objectId.should.not.equal(game.id);
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
            var result = entityResult(entity);
            result.should.have.property("contacts");
            var contacts = result.contacts;
            if (nobody) {
              contacts.should.have.length(0);
            } else {

              include.forEach(function(contactName) {
                should.exist(contacts.find(function(contact) {
                  return contact.username == contactName;
                }));
              }, this);

              exclude.forEach(function(contactName) {
                should.not.exist(contacts.find(function(contact) {
                  return contact.username == contactName;
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
        "aiNum": 0,
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
    contactCheck("Carol", null, ["Alice", "Bob"], ["Carol", "Dan"], function(contacts) {
      bobId = contacts.find(function(contact) { return contact.username == "Bob"; }).objectId;
    });

    contactCheck("Bob", null, ["Alice", "Carol"], ["Bob", "Dan"]);
    contactCheck("Alice", null, ["Bob", "Carol"], ["Alice", "Dan"]);

    contactCheck("Dan", "still returns nobody for Dan :(");

    it('makes Carol delete Bob as friend', function() {
      return parseCall("Carol", "deleteFriend", {
        userId: bobId
      }).then(
        function(entity) {
          entity.should.have.deep.property("result.deleted");
          entity.result.deleted.should.equal(true);
        }
      );
    });
    
    contactCheck("Carol", "should make sure Carol hates Bob now", ["Alice"], ["Bob", "Carol", "Dan"]);

  });
});
