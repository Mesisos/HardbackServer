var should = require('chai').should();
var fs = require('fs');
var rest = require('rest');
var mime = require('rest/interceptor/mime');
var Parse = require('parse/node');
var client = rest.wrap(mime);

var urlParse = "http://127.0.0.1:1337/parse/";

var logins = [
  { user: "Alice", pass: "p" },
  { user: "Bob", pass: "p" }
];
var tokens = {};

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
  if (!token) console.warn("Token missing for " + username);
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
  before(function(done) {
    
    var sessionFile = __dirname + "/sessions.json";
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

      if (promises.length == 0) {
        done();
      } else {
        Parse.Promise.when(promises).then(
          function(results) {
            results.forEach(function(loginResult) {
              var user = loginResult.entity.username;
              tokens[user] = loginResult.entity.sessionToken;
              console.log("Updated session token for " + user);
            }, this);
            fs.writeFile(sessionFile, JSON.stringify(tokens), function(err) {
              if (err) {
                done("Unable to update sessions file: " + err);
              } else {
                console.log("Sessions file updated");
                done();
              }
            });
          },
          function(error) {
            done("Unable to login all users: " + error);
          }
        )
      }
      

    });

  })
  describe('create and join game with two users', function() {
    // this.timeout(4000);
    
    var gameId;
    var players = {};

    it('should create a game and get the game id with Alice', function(done) {
      parseCall("Alice", "createGame", {
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
          done();
        },
        done
      );
    });

    // TODO: creating a game should automatically join you into it
    logins.forEach(function(login) {
      it('should join game and get player id for ' + login.user, function(done) {
        parseCall(login.user, "joinGame", {
          gameId: gameId
        }).then(
          function(result) {
            result.should.have.deep.property("entity.result.playerId");
            players[login.user] = result.entity.result.playerId;
            done();
          },
          done
        );
      });  
    }, this);
    
    it('should get the right game status', function(done) {
      parseCall("Alice", "gameStatus", {
        gameId: gameId
      }).then(
        function(result) {
          result.should.have.deep.property("entity.result");
          var game = result.entity.result;
          game.state.should.equal("pending");
          game.turn.should.equal(0);
          done();
        },
        done
      );
    });

    it('should not allow Bob to make a turn', function(done) {
      
    });


    it('should not get game its not a part of');
    it('should get the created game id from the list of games');
  });
});
