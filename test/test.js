var should = require('chai').should();
var fs = require('fs');
var rest = require('rest');
var mime = require('rest/interceptor/mime');
var Parse = require('parse/node');
var Promise = Parse.Promise;
var client = rest.wrap(mime);

var urlParse = "http://127.0.0.1:1337/parse/";

var logins = [
  { user: "Alice", pass: "p" },
  { user: "Bob", pass: "p" }
];
var tokens = {};

var GameState = {
  PENDING: 0
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
  if (typeof(token) != "string" || token === "")  console.warn("Token missing for " + username);
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

describe('simple game loop', function() {
  before(function() {
    
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

  });

  describe('two user game', function() {
    // this.timeout(4000);
    
    var gameByName = {};
    var gameId;
    var players = {};

    it('create a game and get the game id with Alice', function() {
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
          gameId = id;
          gameByName.Alice = id;
        }
      );
    });

    it('create another game with Bob', function() {
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

    // TODO: creating a game should automatically join you into it
    logins.forEach(function(login) {
      it('join game and get player id for ' + login.user, function() {
        return parseCall(login.user, "joinGame", {
          gameId: gameId
        }).then(
          function(result) {
            result.should.have.deep.property("entity.result.playerId");
            players[login.user] = result.entity.result.playerId;
          }
        );
      });  
    }, this);

    function listGames(name, desc, gameFunc, testFunc) {
      it(desc, function() {
        var req = {};
        if (gameFunc) req.gameIds = gameFunc();
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

    function getGame(name, desc, testFunc) {
      if (!desc) desc = 'get the right game status with ' + name;
      listGames(name, desc, function() { return [gameId]; }, function(games) {
        games.should.have.length(1);
        testFunc(games[0]);
      });
    }
    
    getGame("Alice", '', function(game) {
      game.state.should.equal(GameState.PENDING);
      game.turn.should.equal(0);
    });

    var turnNumber = 0;
    function makeTurn(name, allow) {
      it('game turn by ' + name + ' should ' + (allow ? '' : 'not ') + 'be allowed', function() {
        return parseCall(name, "gameTurn", {
          gameId: gameId,
          state: "turn #" + (turnNumber++)
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
    function makeAndAllowTurn(name) { makeTurn(name, true); }
    function makeAndDenyTurn(name) { makeTurn(name, false); }
    
    makeAndDenyTurn("Bob");
    makeAndAllowTurn("Alice");
    makeAndDenyTurn("Alice");
    makeAndAllowTurn("Bob");
    makeAndDenyTurn("Bob");
    makeAndAllowTurn("Alice");
    makeAndAllowTurn("Bob");
    makeAndAllowTurn("Alice");
    makeAndAllowTurn("Bob");
    makeAndDenyTurn("Bob");

    getGame("Bob", '', function(game) {
      // TODO fix
      // game.state.should.equal(GameState.PENDING);
      game.turn.should.equal(6);
    });

    function matchGameId(name) {
      listGames(
        name,
        'get the created game id from the list of games with ' + name,
        null,
        function(games) {
          games.some(function(game) {
            return game.objectId == gameId;
          }).should.equal(true);
        }
      );

      listGames(
        name,
        'not get a game its not a part of with ' + name,
        null,
        function(games) {
          function gameMatcher(matcher, game) {
            return game.objectId == ngame;
          }

          for (var gname in gameByName) {
            var ngame = gameByName[gname];
            if (gname != name && ngame != gameId) {
              games.some(gameMatcher.bind(this, gname)).should.equal(false);
            }
          }
        }
      );
    }
    
    matchGameId('Alice');
    matchGameId('Bob');
  });
});
