var should = require('chai').should();
var fs = require('fs');
var rest = require('rest');
var mime = require('rest/interceptor/mime');
var Parse = require('parse/node');
var Promise = Parse.Promise;
var client = rest.wrap(mime);

var urlRoot = "http://127.0.0.1:1337/";
var urlParse = urlRoot + "parse/";

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
      "X-Parse-Application-Id": "myAppId",
      "X-Parse-Master-Key": "12345"
    }
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
      "X-Parse-Application-Id": "myAppId",
      "X-Parse-Session-Token": token
    },
    entity: payload
  });
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
            var user = loginResult.entity.username;
            tokens[user] = loginResult.entity.sessionToken;
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

function joinGameCheck(result) {
  result.should.have.deep.property("entity.result.playerId");
}

function joinGame(name, game, desc, playerFunc) {
  if (!desc) desc = 'has ' + name + ' join game and get player id';
  it(desc, function() {
    return parseCall(name, "joinGame", {
      gameId: game.id
    }).then(
      function(result) {
        if (playerFunc) playerFunc(result);
        else joinGameCheck(result);
      }
    );
  });
}

function listGames(name, games, desc, testFunc) {
  it(desc, function() {
    var req = {};
    if (games) req.gameIds = games.map(function(game) { return game.id; });
    return parseCall(name, "listGames", req).then(
      function(result) {
        result.should.have.deep.property("entity.result");
        
        var games = result.entity.result;
        games.should.be.an("array");
        
        testFunc(games);
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

function makeTurn(name, game, turnNumber, allow) {
  it('should ' + (allow ? 'allow' : 'deny') + ' game turn by ' + name, function() {
    return parseCall(name, "gameTurn", {
      gameId: game.id,
      state: "turn " + turnNumber
    }).then(
      function(result) {
        if (allow) {
          result.should.have.deep.property("entity.result.saved");
          result.entity.result.saved.should.equal(true);
        } else {
          result.should.have.deep.property("entity.code");
          result.entity.code.should.equal(141);
        }
      }
    );
  });
}
function makeAndAllowTurn(name, game, turnNumber) { makeTurn(name, game, turnNumber, true); }
function makeAndDenyTurn(name, game, turnNumber) { makeTurn(name, game, turnNumber, false); }


describe('simple game loop', function() {
  before(getUserSessions);

  describe('two user game', function() {
    // this.timeout(4000);



    var gameByName = {};
    var game = {};

    it('creates a game and gets the game id with Alice', function() {
      return parseCall("Alice", "createGame", {
        "slotNum": 2,
        "isRandom": true,
        "fameCardNum": 10,
        "aiNum": 2,
        "turnMaxSec": 60
      }).then(
        function(result) {
          result.should.have.deep.property("entity.result.id");
          var id = result.entity.result.id;
          id.should.be.a("string");
          game.id = id;
          gameByName.Alice = id;
        }
      );
    });


    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Lobby);
      game.turn.should.equal(0);
    });

    makeAndDenyTurn("Alice", game);
    makeAndDenyTurn("Bob", game);
    makeAndDenyTurn("Carol", game);

    joinGame("Alice", game, "should fail joining Alice as it's her game", function(result) {
      result.should.have.deep.property("entity.error");
    });
    joinGame("Bob", game);

    getGame("Alice", game, '', function(game) {
      game.state.should.equal(GameState.Running);
      game.turn.should.equal(0);
    });

    joinGame("Carol", game, "should fail joining Carol as the game is running", function(result) {
      result.should.have.deep.property("entity.error");
    });

    it('creates another game with Bob', function() {
      return parseCall("Bob", "createGame", {
        "slotNum": 4,
        "isRandom": true,
        "fameCardNum": 10,
        "aiNum": 2,
        "turnMaxSec": 60
      }).then(
        function(result) {
          result.should.have.deep.property("entity.result.id");
          var id = result.entity.result.id;
          id.should.be.a("string");
          gameByName.Bob = id;
        }
      );
    });

    var turnNumber = 0;

    makeAndDenyTurn("Bob", game, turnNumber++);
    makeAndAllowTurn("Alice", game, turnNumber++);
    makeAndDenyTurn("Alice", game, turnNumber++);
    makeAndAllowTurn("Bob", game, turnNumber++);
    makeAndDenyTurn("Bob", game, turnNumber++);
    makeAndAllowTurn("Alice", game, turnNumber++);
    makeAndAllowTurn("Bob", game, turnNumber++);
    makeAndAllowTurn("Alice", game, turnNumber++);
    makeAndAllowTurn("Bob", game, turnNumber++);
    makeAndDenyTurn("Bob", game, turnNumber++);

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
            return game.objectId == ngame;
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
          "X-Parse-Application-Id": "myAppId",
          "X-Parse-Master-Key": "12345"
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
          function(result) {
            result.should.have.deep.property("entity.result.contacts");
            var contacts = result.entity.result.contacts;
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
        )
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
        "fameCardNum": 10,
        "aiNum": 2,
        "turnMaxSec": 60
      }).then(
        function(result) {
          result.should.have.deep.property("entity.result.id");
          var id = result.entity.result.id;
          id.should.be.a("string");
          game.id = id;
        }
      );
    });

    it('has Bob join game', function() {
      return parseCall("Bob", "joinGame", {
        gameId: game.id
      }).then(
        function(result) {
          result.should.have.deep.property("entity.result.playerId");
        }
      );
    });

    it('has Carol join game', function() {
      return parseCall("Carol", "joinGame", {
        gameId: game.id
      }).then(
        function(result) {
          result.should.have.deep.property("entity.result.playerId");
        }
      );
    });

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
        function(result) {
          result.should.have.deep.property("entity.result.deleted");
          result.entity.result.deleted.should.equal(true);
        }
      );
    });
    
    contactCheck("Carol", "should make sure Carol hates Bob now", ["Alice"], ["Bob", "Carol", "Dan"]);

  });
});
